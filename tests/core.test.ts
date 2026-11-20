import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	MemoryError,
	forget,
	getContext,
	getProfile,
	listMemories,
	queryTerms,
	recall,
	remember,
	setProfile,
	updateMemory,
} from "../src/core/memory";
import { findSensitive } from "../src/core/sensitive";

const db = env.DB;

describe("remember", () => {
	it("stores a memory and writes an audit entry", async () => {
		const r = await remember(db, { content: "TypeScript를 주력 언어로 사용한다", category: "preference", tags: ["Dev", "dev"], source: "test" });
		expect(r.status).toBe("created");
		if (r.status !== "created") return;
		expect(r.memory.tags).toEqual(["dev"]);
		expect(r.memory.id).toMatch(/^[0-9A-Z]{26}$/);
		const audit = await db.prepare("SELECT action, source FROM audit_log WHERE memory_id = ?").bind(r.memory.id).first();
		expect(audit).toEqual({ action: "create", source: "test" });
	});

	it("detects exact duplicates (ignoring case and whitespace)", async () => {
		await remember(db, { content: "Memory Hub 프로젝트를 진행 중", category: "project" });
		const r = await remember(db, { content: "  memory hub   프로젝트를 진행 중 ", category: "project" });
		expect(r.status).toBe("duplicate");
	});

	it("refuses secrets", async () => {
		await expect(remember(db, { content: `내 키는 ${["sk", "ant", "x".repeat(30)].join("-")}`, category: "knowledge" })).rejects.toThrow(MemoryError);
		await expect(remember(db, { content: "비밀번호: hunter2", category: "knowledge" })).rejects.toThrow(/password/);
	});

	it("rejects empty content", async () => {
		await expect(remember(db, { content: "   ", category: "knowledge" })).rejects.toThrow(MemoryError);
	});
});

describe("recall", () => {
	it("finds Korean substrings, including 2-char terms and terms with particles", async () => {
		await remember(db, { content: "무료 클라우드에 MCP 서버를 구축하고 있다", category: "project", importance: 4 });
		await remember(db, { content: "커피는 아메리카노만 마신다", category: "preference" });

		const byShort = await recall(db, { query: "서버" });
		expect(byShort.map((m) => m.content)).toContain("무료 클라우드에 MCP 서버를 구축하고 있다");

		const byParticle = await recall(db, { query: "클라우드를" });
		expect(byParticle).toHaveLength(1);

		const none = await recall(db, { query: "자전거" });
		expect(none).toHaveLength(0);
	});

	it("ranks by number of matched terms and filters by category", async () => {
		await remember(db, { content: "Cloudflare Workers로 배포", category: "decision" });
		await remember(db, { content: "Cloudflare D1과 Workers를 함께 사용", category: "knowledge" });
		const res = await recall(db, { query: "cloudflare workers d1" });
		expect(res[0]?.content).toBe("Cloudflare D1과 Workers를 함께 사용");
		const onlyDecision = await recall(db, { query: "cloudflare", category: "decision" });
		expect(onlyDecision.map((m) => m.category)).toEqual(["decision"]);
	});

	it("treats LIKE wildcards literally", async () => {
		await remember(db, { content: "진행률 100% 달성", category: "project" });
		expect(await recall(db, { query: "%" })).toHaveLength(1);
		expect(await recall(db, { query: "_" })).toHaveLength(0);
	});
});

describe("update / forget", () => {
	it("updates fields, keeps search index in sync, and soft-deletes", async () => {
		const r = await remember(db, { content: "거주지는 서울", category: "profile" });
		if (r.status !== "created") throw new Error("expected created");
		const updated = await updateMemory(db, { id: r.memory.id, content: "거주지는 부산", importance: 5 });
		expect(updated.importance).toBe(5);
		expect(await recall(db, { query: "서울" })).toHaveLength(0);
		expect(await recall(db, { query: "부산" })).toHaveLength(1);

		await forget(db, r.memory.id, "moved");
		expect(await recall(db, { query: "부산" })).toHaveLength(0);
		expect(await listMemories(db)).toHaveLength(0);
		await expect(updateMemory(db, { id: r.memory.id, content: "x" })).rejects.toThrow(/not found/);
	});
});

describe("profile & context", () => {
	it("sets, overwrites and deletes profile keys", async () => {
		await setProfile(db, "Language", "한국어");
		await setProfile(db, "language", "Korean");
		expect(await getProfile(db)).toEqual({ language: "Korean" });
		await setProfile(db, "language", null);
		expect(await getProfile(db)).toEqual({});
		await expect(setProfile(db, "bad key!", "x")).rejects.toThrow(MemoryError);
	});

	it("builds context without duplicating important memories", async () => {
		await setProfile(db, "job", "개발자");
		await remember(db, { content: "핵심 정보", category: "profile", importance: 5 });
		await remember(db, { content: "최근 정보", category: "knowledge" });
		const ctx = await getContext(db, "정보");
		expect(ctx.profile).toEqual({ job: "개발자" });
		expect(ctx.important.map((m) => m.content)).toEqual(["핵심 정보"]);
		expect(ctx.recent.map((m) => m.content)).toEqual(["최근 정보"]);
		expect(ctx.related.map((m) => m.content)).toEqual(["최근 정보"]);
	});
});

describe("helpers", () => {
	it("strips Korean particles in query terms", () => {
		expect(queryTerms("프로젝트를 서버에서")).toEqual(["프로젝트를", "프로젝트", "서버에서", "서버"]);
	});

	it("detects card numbers with Luhn and Korean RRN", () => {
		expect(findSensitive("카드 4111 1111 1111 1111")).toBe("card number");
		expect(findSensitive("전화 010-1234-5678")).toBeNull();
		expect(findSensitive("900101-1234567")).toMatch(/resident/);
	});
});
