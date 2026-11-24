import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	INBOX,
	NOTION_VERSION,
	type NotionApi,
	type NotionBlock,
	type NotionRow,
	STATUS,
	collectNotionInbox,
	httpNotion,
	notionAboutMeSink,
	parseCategory,
	snapshotToNotionBlocks,
} from "../src/bridge/notion";
import { renderSnapshot } from "../src/bridge/renderer";
import { FULL_RESYNC_MS, type Sink, syncSinks } from "../src/bridge/sync";
import { listMemories, remember, setProfile } from "../src/core/memory";

const db = env.DB;

/** In-memory Notion: one page with children, one inbox data source. */
class FakeNotion implements NotionApi {
	children: { id: string; block: NotionBlock }[] = [];
	rows: (NotionRow & { updates: Record<string, unknown>[] })[] = [];
	queries: unknown[] = [];
	calls = 0;
	private seq = 0;

	async listChildren() {
		this.calls++;
		return this.children.map((c) => c.id);
	}
	async appendChildren(_id: string, blocks: NotionBlock[]) {
		this.calls++;
		for (const block of blocks) this.children.push({ id: `b${++this.seq}`, block });
	}
	async deleteBlock(id: string) {
		this.calls++;
		this.children = this.children.filter((c) => c.id !== id);
	}
	async queryDataSource(_id: string, body: { page_size: number }) {
		this.calls++;
		this.queries.push(body);
		return this.rows.filter((r) => r.updates.length === 0).slice(0, body.page_size);
	}
	async updatePage(id: string, properties: Record<string, unknown>) {
		this.calls++;
		this.rows.find((r) => r.id === id)!.updates.push(properties);
	}

	addRow(content: string, category?: string, importance?: number) {
		const id = `row${++this.seq}`;
		this.rows.push({
			id,
			updates: [],
			properties: {
				[INBOX.content]: { type: "title", title: [{ plain_text: content }] },
				[INBOX.category]: { type: "select", select: category ? { name: category } : null },
				[INBOX.importance]: { type: "number", number: importance ?? null },
				[INBOX.status]: { type: "select", select: null },
			},
		});
		return id;
	}
	statusOf(id: string) {
		const u = this.rows.find((r) => r.id === id)!.updates.at(-1) as Record<string, { select?: { name: string }; rich_text?: { text: { content: string } }[] }>;
		return { status: u?.[INBOX.status]?.select?.name, note: u?.[INBOX.result]?.rich_text?.[0]?.text.content ?? "" };
	}
}

const textOfBlocks = (blocks: NotionBlock[]) => JSON.stringify(blocks);

describe("Notion About Me sink", () => {
	it("lays the snapshot out in a handful of blocks", async () => {
		const s = await renderSnapshot({
			profile: { name: "민수", job: "엔지니어" },
			memories: Array.from({ length: 30 }, (_, i) => ({
				id: `m${i}`,
				content: `선호 ${i}`,
				category: "preference" as const,
				tags: [],
				source: "t",
				importance: 3,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
			})),
		});
		const blocks = snapshotToNotionBlocks(s);
		expect(blocks.length).toBe(5); // callout + profile (2) + 선호 (2)
		expect(textOfBlocks(blocks)).toContain("• 선호 29");
		expect(textOfBlocks(blocks)).toContain("• job: 엔지니어");
	});

	it("splits long sections into 2000-char rich text objects", async () => {
		const s = await renderSnapshot({ profile: {}, memories: [], budget: 99999 });
		s.sections = [{ title: "긴 섹션", items: Array.from({ length: 60 }, () => "가".repeat(70)) }];
		const para = snapshotToNotionBlocks(s)[2] as unknown as { paragraph: { rich_text: { text: { content: string } }[] } };
		expect(para.paragraph.rich_text.length).toBeGreaterThan(1);
		for (const t of para.paragraph.rich_text) expect(t.text.content.length).toBeLessThanOrEqual(2000);
	});

	it("replaces the old content: append new first, then delete old", async () => {
		const notion = new FakeNotion();
		notion.children = [{ id: "old1", block: { type: "paragraph" } }, { id: "old2", block: { type: "paragraph" } }];
		const sink = notionAboutMeSink(notion, "page");
		await sink.write(await renderSnapshot({ profile: { name: "민수" }, memories: [] }));
		expect(notion.children.map((c) => c.id)).not.toContain("old1");
		expect(notion.children[0]!.block.type).toBe("callout");
		expect(textOfBlocks(notion.children.map((c) => c.block))).toContain("name: 민수");
	});
});

describe("syncSinks", () => {
	function recordingSink(name = "fake", fail = false): Sink & { writes: number } {
		const sink = {
			name,
			writes: 0,
			async write() {
				sink.writes++;
				if (fail) throw new Error("boom");
			},
		};
		return sink;
	}

	it("writes once, skips while the snapshot is unchanged, rewrites on change", async () => {
		const sink = recordingSink();
		const t0 = new Date("2026-03-01T00:00:00Z");
		await setProfile(db, "name", "민수");
		expect((await syncSinks(db, [sink], t0))[0]!.action).toBe("written");
		expect((await syncSinks(db, [sink], new Date(t0.getTime() + 60_000)))[0]!.action).toBe("skipped");
		expect(await db.prepare("SELECT synced_at, checked_at FROM bridge_state WHERE sink = 'fake'").first()).toEqual({
			synced_at: t0.toISOString(),
			checked_at: new Date(t0.getTime() + 60_000).toISOString(),
		});

		await remember(db, { content: "새로운 선호", category: "preference" });
		expect((await syncSinks(db, [sink], new Date(t0.getTime() + 120_000)))[0]!.action).toBe("written");
		expect(sink.writes).toBe(2);
	});

	it("rewrites an unchanged snapshot after a day (safety net)", async () => {
		const sink = recordingSink();
		const t0 = new Date("2026-03-01T00:00:00Z");
		await syncSinks(db, [sink], t0);
		expect((await syncSinks(db, [sink], new Date(t0.getTime() + FULL_RESYNC_MS + 1)))[0]!.action).toBe("written");
	});

	it("records a failing sink without blocking the others, and retries next run", async () => {
		const bad = recordingSink("bad", true);
		const good = recordingSink("good");
		const out = await syncSinks(db, [bad, good]);
		expect(out.map((o) => o.action)).toEqual(["failed", "written"]);
		const row = await db.prepare("SELECT hash, last_error FROM bridge_state WHERE sink = 'bad'").first();
		expect(row).toEqual({ hash: null, last_error: "boom" });
		expect((await syncSinks(db, [bad, good]))[0]!.action).toBe("failed"); // not skipped
	});
});

describe("Notion Memory Inbox", () => {
	it("saves pending rows through the service layer with source=pickle", async () => {
		const notion = new FakeNotion();
		const a = notion.addRow("주말마다 등산을 간다", "선호", 4);
		const b = notion.addRow("사이드 프로젝트로 게임 서버를 만든다", "project");
		await collectNotionInbox(db, notion, "ds");

		expect(notion.statusOf(a).status).toBe(STATUS.done);
		expect(notion.statusOf(b).status).toBe(STATUS.done);
		const saved = await listMemories(db);
		const hike = saved.find((m) => m.content === "주말마다 등산을 간다")!;
		expect(hike).toMatchObject({ category: "preference", importance: 4, source: "pickle" });
		expect(saved.find((m) => m.content.startsWith("사이드"))!.category).toBe("project");
		expect(notion.statusOf(a).note).toContain(hike.id);
	});

	it("marks duplicates, sensitive content and empty rows without saving them", async () => {
		await remember(db, { content: "이미 아는 사실", category: "knowledge" });
		const notion = new FakeNotion();
		const dup = notion.addRow("이미 아는 사실");
		const secret = notion.addRow("비밀번호: hunter2");
		const empty = notion.addRow("   ");
		await collectNotionInbox(db, notion, "ds");

		expect(notion.statusOf(dup).status).toBe(STATUS.duplicate);
		expect(notion.statusOf(secret)).toMatchObject({ status: STATUS.rejected });
		expect(notion.statusOf(secret).note).toContain("Notion에서 직접 지워");
		expect(notion.statusOf(empty).status).toBe(STATUS.rejected);
		expect(await listMemories(db)).toHaveLength(1);
	});

	it("drains only a few rows per run (subrequest budget) and asks for pending or empty status", async () => {
		const notion = new FakeNotion();
		for (let i = 0; i < 5; i++) notion.addRow(`인박스 항목 번호 ${i}`);
		const r = await collectNotionInbox(db, notion, "ds", null, 3);
		expect(r.processed).toBe(3);
		expect(JSON.stringify(notion.queries[0])).toContain(`"equals":"${STATUS.pending}"`);
		expect(JSON.stringify(notion.queries[0])).toContain('"is_empty":true');
		await collectNotionInbox(db, notion, "ds", null, 3);
		expect(notion.rows.every((row) => row.updates.length === 1)).toBe(true);
	});

	it("maps Korean and English category labels, defaulting to knowledge", () => {
		expect(parseCategory("선호")).toBe("preference");
		expect(parseCategory("할 일")).toBe("todo");
		expect(parseCategory("Decision")).toBe("decision");
		expect(parseCategory(undefined)).toBe("knowledge");
		expect(parseCategory("모름")).toBe("knowledge");
	});
});

describe("httpNotion", () => {
	it("sends the version header and retries once on 429", async () => {
		const seen: Request[] = [];
		let n = 0;
		const fetchFn = (async (url: string, init: RequestInit) => {
			seen.push(new Request(url, init));
			if (n++ === 0) return new Response(JSON.stringify({ code: "rate_limited" }), { status: 429, headers: { "Retry-After": "0" } });
			return Response.json({ results: [{ id: "x" }], has_more: false, next_cursor: null });
		}) as typeof fetch;
		const ids = await httpNotion("secret_x", fetchFn).listChildren("page1");
		expect(ids).toEqual(["x"]);
		expect(seen).toHaveLength(2);
		expect(seen[0]!.headers.get("Notion-Version")).toBe(NOTION_VERSION);
		expect(seen[0]!.headers.get("Authorization")).toBe("Bearer secret_x");
		expect(seen[0]!.url).toBe("https://api.notion.com/v1/blocks/page1/children?page_size=100");
	});

	it("throws a NotionError with the API code on other failures", async () => {
		const fetchFn = (async () => Response.json({ code: "object_not_found", message: "not shared" }, { status: 404 })) as unknown as typeof fetch;
		await expect(httpNotion("t", fetchFn).deleteBlock("b")).rejects.toThrow(/404 object_not_found/);
	});
});
