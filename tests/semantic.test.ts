import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillEmbeddings, forget, getContext, recall, remember, updateMemory } from "../src/core/memory";
import { reciprocalRankFusion } from "../src/search/semantic";
import { FakeSemantic } from "./fake-semantic";

const db = env.DB;
let sem: FakeSemantic;
beforeEach(() => {
	sem = new FakeSemantic();
});

async function created(content: string, category: "preference" | "knowledge" | "profile" = "preference", extra = {}) {
	const r = await remember(db, { content, category, ...extra }, sem);
	if (r.status !== "created") throw new Error(`expected created, got ${r.status}`);
	return r.memory;
}

const embeddedAt = (id: string) =>
	db.prepare("SELECT embedded_at FROM memories WHERE id = ?").bind(id).first<string>("embedded_at");

describe("remember with semantic dedupe", () => {
	it("indexes new memories and marks them embedded", async () => {
		const m = await created("김치찌개를 자주 먹는다");
		expect(sem.vectors.get(m.id)?.category).toBe("preference");
		expect(await embeddedAt(m.id)).toBeTruthy();
	});

	it("returns similar candidates instead of saving a near-duplicate", async () => {
		const first = await created("김치찌개를 자주 먹는다");
		const r = await remember(db, { content: "한식 중에서는 된장찌개를 제일 좋아한다", category: "preference" }, sem);
		expect(r.status).toBe("similar");
		if (r.status !== "similar") return;
		expect(r.candidates.map((c) => c.id)).toEqual([first.id]);
		expect(r.candidates[0]!.similarity).toBeGreaterThanOrEqual(0.9);
		expect(r.hint).toMatch(/allow_similar/);
		const { count } = (await db.prepare("SELECT COUNT(*) AS count FROM memories").first<{ count: number }>())!;
		expect(count).toBe(1);
	});

	it("checks across categories (the same fact may be filed differently)", async () => {
		await created("김치찌개를 자주 먹는다", "preference");
		const r = await remember(db, { content: "한식 요리를 좋아함", category: "profile" }, sem);
		expect(r.status).toBe("similar");
	});

	it("saves anyway with allow_similar", async () => {
		await created("김치찌개를 자주 먹는다");
		const r = await remember(db, { content: "된장찌개는 싫어한다", category: "preference", allow_similar: true }, sem);
		expect(r.status).toBe("created");
	});

	it("does not flag unrelated facts", async () => {
		await created("김치찌개를 자주 먹는다");
		expect((await remember(db, { content: "주말마다 등산을 간다", category: "preference" }, sem)).status).toBe("created");
	});

	it("still saves when embedding is down, and leaves it for the backfill", async () => {
		sem.failing = true;
		const m = await created("주말마다 등산을 간다");
		expect(await embeddedAt(m.id)).toBeNull();
		sem.failing = false;
		expect(await backfillEmbeddings(db, sem)).toBe(1);
		expect(await embeddedAt(m.id)).toBeTruthy();
		expect(sem.vectors.has(m.id)).toBe(true);
		expect(await backfillEmbeddings(db, sem)).toBe(0);
	});
});

describe("hybrid recall", () => {
	it("finds memories by meaning with no keyword overlap", async () => {
		const food = await created("김치찌개를 자주 먹는다");
		await created("TypeScript를 주력 언어로 쓴다", "knowledge");
		const hits = await recall(db, { query: "한식 메뉴" }, sem);
		expect(hits.map((h) => h.id)).toEqual([food.id]);
		expect(hits[0]!.match).toEqual(["semantic"]);
		expect(hits[0]!.similarity).toBeGreaterThan(0.9);
	});

	it("ranks memories matched both ways above single-signal ones", async () => {
		const both = await created("고양이 두 마리를 키운다");
		const semanticOnly = await created("반려묘 사료는 매달 정기 배송", "knowledge", { allow_similar: true });
		const hits = await recall(db, { query: "고양이" }, sem);
		expect(hits[0]!.id).toBe(both.id);
		expect(hits[0]!.match).toEqual(["keyword", "semantic"]);
		expect(hits.map((h) => h.id)).toContain(semanticOnly.id);
	});

	it("respects the category filter for semantic hits", async () => {
		await created("김치찌개를 자주 먹는다", "preference");
		expect(await recall(db, { query: "한식 메뉴", category: "knowledge" }, sem)).toEqual([]);
	});

	it("drops weak semantic matches", async () => {
		await created("김치찌개를 자주 먹는다");
		expect(await recall(db, { query: "등산 코스" }, sem)).toEqual([]);
	});

	it("falls back to keyword search when semantic search fails", async () => {
		const m = await created("주말마다 등산을 간다");
		sem.failing = true;
		const hits = await recall(db, { query: "등산" }, sem);
		expect(hits.map((h) => h.id)).toEqual([m.id]);
		expect(hits[0]!.match).toEqual(["keyword"]);
	});

	it("uses semantic matches for get_context topics", async () => {
		const food = await created("김치찌개를 자주 먹는다", "preference", { importance: 2 });
		const ctx = await getContext(db, "점심 메뉴 추천", sem);
		expect(ctx.related.map((m) => m.id)).toContain(food.id);
		expect(ctx.related[0]).not.toHaveProperty("match");
	});
});

describe("keeping vectors in sync", () => {
	it("re-embeds on content/category change but not on importance-only change", async () => {
		const m = await created("주말마다 등산을 간다");
		const calls = sem.embedCalls;
		await updateMemory(db, { id: m.id, importance: 5 }, sem);
		expect(sem.embedCalls).toBe(calls);
		await updateMemory(db, { id: m.id, content: "고양이를 키운다", category: "profile" }, sem);
		expect(sem.embedCalls).toBe(calls + 1);
		expect(sem.vectors.get(m.id)?.category).toBe("profile");
		const hits = await recall(db, { query: "반려묘" }, sem);
		expect(hits.map((h) => h.id)).toEqual([m.id]);
	});

	it("marks a failed re-embed for the backfill", async () => {
		const m = await created("주말마다 등산을 간다");
		sem.failing = true;
		await updateMemory(db, { id: m.id, content: "주말마다 트레킹을 간다" }, sem);
		expect(await embeddedAt(m.id)).toBeNull();
	});

	it("removes the vector on forget", async () => {
		const m = await created("주말마다 등산을 간다");
		await forget(db, m.id, "test", "test", sem);
		expect(sem.vectors.has(m.id)).toBe(false);
		expect(await recall(db, { query: "하이킹" }, sem)).toEqual([]);
	});
});

describe("reciprocalRankFusion", () => {
	it("rewards items present in several lists", () => {
		const s = reciprocalRankFusion([["a", "b"], ["b", "c"]]);
		expect(s.get("b")!).toBeGreaterThan(s.get("a")!);
		expect(s.get("a")!).toBeGreaterThan(s.get("c")!);
	});
});
