import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { loadSnapshotInput, renderSnapshot, snapshotToMarkdown } from "../src/bridge/renderer";
import { type Memory, forget, remember, setProfile } from "../src/core/memory";

let seq = 0;
function mem(p: Partial<Memory> & Pick<Memory, "content" | "category">): Memory {
	seq++;
	return {
		id: `M${String(seq).padStart(25, "0")}`,
		tags: [],
		source: "test",
		importance: 3,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
		...p,
	};
}

const now = new Date("2026-02-01T00:00:00.000Z");

describe("renderSnapshot", () => {
	it("exports only importance >= 4 or profile/preference memories", async () => {
		const s = await renderSnapshot({
			profile: { name: "민수" },
			memories: [
				mem({ content: "아메리카노를 좋아한다", category: "preference", importance: 1 }),
				mem({ content: "사이드 프로젝트 진행 중", category: "project", importance: 4 }),
				mem({ content: "사소한 지식", category: "knowledge", importance: 3 }),
			],
			now,
		});
		const all = s.sections.flatMap((x) => x.items);
		expect(all).toContain("아메리카노를 좋아한다");
		expect(all).toContain("사이드 프로젝트 진행 중");
		expect(all).not.toContain("사소한 지식");
		expect(s.profile).toEqual([["name", "민수"]]);
	});

	it("groups by section in a fixed order and ranks by importance within", async () => {
		const s = await renderSnapshot({
			profile: {},
			memories: [
				mem({ content: "결정 A", category: "decision", importance: 4 }),
				mem({ content: "선호 낮음", category: "preference", importance: 2 }),
				mem({ content: "선호 높음", category: "preference", importance: 5 }),
				mem({ content: "할 일", category: "todo", importance: 4 }),
			],
			now,
		});
		expect(s.sections.map((x) => x.title)).toEqual(["선호", "진행 중인 일", "결정"]);
		expect(s.sections[0]!.items).toEqual(["선호 높음", "선호 낮음"]);
	});

	it("stays within the budget, keeping higher-ranked items and counting the rest", async () => {
		const memories = Array.from({ length: 50 }, (_, i) =>
			mem({ content: `기억 ${i} ${"가".repeat(80)}`, category: "project", importance: i < 5 ? 5 : 4 }),
		);
		const s = await renderSnapshot({ profile: {}, memories, now, budget: 1000 });
		const items = s.sections.flatMap((x) => x.items);
		expect(items.length).toBeGreaterThan(0);
		expect(items.join("").length).toBeLessThanOrEqual(1000);
		expect(s.omitted).toBe(50 - items.length);
		for (let i = 0; i < 5; i++) expect(items.some((t) => t.startsWith(`기억 ${i} `))).toBe(true);
		expect(snapshotToMarkdown(s)).toContain(`기억 ${s.omitted}개는 생략됨`);
	});

	it("keeps the hash stable across time but changes it with content", async () => {
		const memories = [mem({ content: "선호 하나", category: "preference" })];
		const a = await renderSnapshot({ profile: {}, memories, now });
		const b = await renderSnapshot({ profile: {}, memories, now: new Date("2027-01-01") });
		const c = await renderSnapshot({ profile: { name: "민수" }, memories, now });
		expect(a.hash).toBe(b.hash);
		expect(a.hash).not.toBe(c.hash);
	});

	it("renders markdown with a do-not-edit notice", async () => {
		const s = await renderSnapshot({ profile: { job: "엔지니어" }, memories: [mem({ content: "줄\n바꿈", category: "preference" })], now });
		const md = snapshotToMarkdown(s);
		expect(md).toMatch(/^# About Me\n/);
		expect(md).toContain("덮어써집니다");
		expect(md).toContain("- **job**: 엔지니어");
		expect(md).toContain("- 줄 바꿈");
	});
});

describe("loadSnapshotInput", () => {
	it("reads only exportable, non-deleted rows from D1", async () => {
		const db = env.DB;
		await setProfile(db, "nickname", "테스터", "test");
		const keep = await remember(db, { content: "렌더러 테스트용 중요 기억", category: "knowledge", importance: 5 });
		const skip = await remember(db, { content: "렌더러 테스트용 사소한 기억", category: "knowledge", importance: 2 });
		const gone = await remember(db, { content: "렌더러 테스트용 지운 선호", category: "preference" });
		if (gone.status === "created") await forget(db, gone.memory.id);

		const input = await loadSnapshotInput(db);
		const contents = input.memories.map((m) => m.content);
		expect(input.profile.nickname).toBe("테스터");
		expect(keep.status === "created" && contents).toContain("렌더러 테스트용 중요 기억");
		expect(skip.status === "created" && contents).not.toContain("렌더러 테스트용 사소한 기억");
		expect(contents).not.toContain("렌더러 테스트용 지운 선호");
	});
});
