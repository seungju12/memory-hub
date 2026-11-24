// Notion side of the Bridge (P3.5), for Pickle:
//   - About Me page: overwritten with the snapshot (sink)
//   - Memory Inbox data source: rows Pickle writes are saved through the core service layer (collector)
//
// Workers Free allows 50 subrequests per invocation (D1 calls included), so the page is laid out
// in few blocks (heading + one paragraph per section) and the inbox is drained a few rows at a time.
import { CATEGORIES, type Category, MemoryError, remember } from "../core/memory";
import type { SemanticIndex } from "../search/semantic";
import type { Snapshot } from "./renderer";
import type { Sink } from "./sync";

export const NOTION_VERSION = "2026-03-11";
const API = "https://api.notion.com/v1";

// ---------- minimal API client ----------

export type NotionBlock = Record<string, unknown> & { type: string };

export interface NotionRow {
	id: string;
	properties: Record<string, NotionProperty>;
}

export type NotionProperty =
	| { type: "title"; title: { plain_text: string }[] }
	| { type: "rich_text"; rich_text: { plain_text: string }[] }
	| { type: "select"; select: { name: string } | null }
	| { type: "number"; number: number | null }
	| { type: string; [k: string]: unknown };

export interface NotionApi {
	listChildren(blockId: string): Promise<string[]>;
	appendChildren(blockId: string, blocks: NotionBlock[]): Promise<void>;
	deleteBlock(blockId: string): Promise<void>;
	queryDataSource(dataSourceId: string, body: unknown): Promise<NotionRow[]>;
	updatePage(pageId: string, properties: Record<string, unknown>): Promise<void>;
}

export class NotionError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(`notion ${status} ${code}: ${message}`);
	}
}

/** Longest Retry-After we wait inside one run; anything longer is left to the next cron run. */
const MAX_RETRY_WAIT_S = 5;

export function httpNotion(token: string, fetchFn: typeof fetch = fetch): NotionApi {
	async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
		const res = await fetchFn(`${API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Notion-Version": NOTION_VERSION,
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		if (res.ok) return (await res.json()) as T;
		const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
		const wait = Number(res.headers.get("Retry-After") ?? "1");
		if ((res.status === 429 || res.status === 529) && !retried && wait <= MAX_RETRY_WAIT_S) {
			await new Promise((r) => setTimeout(r, wait * 1000));
			return call(method, path, body, true);
		}
		throw new NotionError(res.status, err.code ?? "unknown", err.message ?? res.statusText);
	}

	return {
		async listChildren(blockId) {
			const ids: string[] = [];
			let cursor: string | undefined;
			do {
				const q = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
				const page = await call<{ results: { id: string }[]; has_more: boolean; next_cursor: string | null }>(
					"GET",
					`/blocks/${blockId}/children?${q}`,
				);
				ids.push(...page.results.map((b) => b.id));
				cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
			} while (cursor);
			return ids;
		},
		async appendChildren(blockId, blocks) {
			for (let i = 0; i < blocks.length; i += 100) {
				await call("PATCH", `/blocks/${blockId}/children`, { children: blocks.slice(i, i + 100) });
			}
		},
		async deleteBlock(blockId) {
			await call("DELETE", `/blocks/${blockId}`);
		},
		async queryDataSource(dataSourceId, body) {
			const res = await call<{ results: NotionRow[] }>("POST", `/data_sources/${dataSourceId}/query`, body);
			return res.results;
		},
		async updatePage(pageId, properties) {
			await call("PATCH", `/pages/${pageId}`, { properties });
		},
	};
}

// ---------- About Me sink ----------

const RICH_TEXT_MAX = 2000; // per text object

function richText(text: string, annotations?: Record<string, boolean>) {
	const out: unknown[] = [];
	for (let i = 0; i < text.length; i += RICH_TEXT_MAX) {
		out.push({ type: "text", text: { content: text.slice(i, i + RICH_TEXT_MAX) }, ...(annotations ? { annotations } : {}) });
	}
	return out;
}

const heading = (text: string): NotionBlock => ({ type: "heading_2", heading_2: { rich_text: richText(text) } });
const paragraph = (text: string, annotations?: Record<string, boolean>): NotionBlock => ({
	type: "paragraph",
	paragraph: { rich_text: richText(text, annotations) },
});

/** One heading + one multi-line paragraph per section keeps the page around a dozen blocks. */
export function snapshotToNotionBlocks(s: Snapshot): NotionBlock[] {
	const blocks: NotionBlock[] = [
		{
			type: "callout",
			callout: {
				rich_text: richText(`Memory Hub가 자동으로 생성한 페이지입니다 (갱신: ${s.generatedAt}). 직접 수정하면 다음 동기화 때 덮어써집니다.`),
				icon: { type: "emoji", emoji: "🔄" },
			},
		},
	];
	if (s.profile.length) {
		blocks.push(heading("프로필"), paragraph(s.profile.map(([k, v]) => `• ${k}: ${v}`).join("\n")));
	}
	for (const sec of s.sections) blocks.push(heading(sec.title), paragraph(sec.items.map((i) => `• ${i}`).join("\n")));
	if (s.omitted) blocks.push(paragraph(`분량 제한으로 기억 ${s.omitted}개는 생략됨. 모르는 내용은 추측하지 말고 물어볼 것.`, { italic: true }));
	return blocks;
}

/**
 * Appends the new content first, then deletes the old blocks, so readers never see an empty page.
 * If a run dies halfway, the next run lists everything (old + new) and converges.
 */
export function notionAboutMeSink(api: NotionApi, pageId: string): Sink {
	return {
		name: "notion",
		async write(snapshot) {
			const old = await api.listChildren(pageId);
			await api.appendChildren(pageId, snapshotToNotionBlocks(snapshot));
			for (const id of old) await api.deleteBlock(id);
		},
	};
}

// ---------- Memory Inbox collector ----------

/** Property names of the Memory Inbox database (create them exactly like this in Notion). */
export const INBOX = {
	content: "내용", // title
	category: "카테고리", // select (optional): 프로필/선호/프로젝트/결정/지식/할 일, or the English names
	importance: "중요도", // number (optional), 1-5
	status: "상태", // select: 대기 (or empty) → 처리됨 / 중복 / 확인 필요 / 거부
	result: "처리 결과", // rich_text, written by Memory Hub
} as const;

export const STATUS = { pending: "대기", done: "처리됨", duplicate: "중복", review: "확인 필요", rejected: "거부" } as const;

const CATEGORY_LABELS: Record<string, Category> = {
	프로필: "profile",
	선호: "preference",
	프로젝트: "project",
	결정: "decision",
	지식: "knowledge",
	"할 일": "todo",
	할일: "todo",
};

export function parseCategory(label: string | undefined): Category {
	const l = label?.trim() ?? "";
	if ((CATEGORIES as readonly string[]).includes(l.toLowerCase())) return l.toLowerCase() as Category;
	return CATEGORY_LABELS[l] ?? "knowledge";
}

function textOf(p: NotionProperty | undefined): string {
	if (!p) return "";
	if (p.type === "title" || p.type === "rich_text") {
		const parts = (p as { [k: string]: { plain_text: string }[] })[p.type] ?? [];
		return parts.map((t) => t.plain_text).join("");
	}
	return "";
}

const selectOf = (p: NotionProperty | undefined) => (p?.type === "select" ? ((p as { select: { name: string } | null }).select?.name ?? "") : "");
const numberOf = (p: NotionProperty | undefined) => (p?.type === "number" ? (p as { number: number | null }).number : null);

/** Each row costs ~8 subrequests (D1 + embedding + Vectorize + Notion), so drain a few per run. */
export const INBOX_BATCH = 3;

export interface InboxResult {
	processed: number;
	created: number;
	statuses: Record<string, number>;
}

export async function collectNotionInbox(
	db: D1Database,
	api: NotionApi,
	dataSourceId: string,
	sem?: SemanticIndex | null,
	limit = INBOX_BATCH,
): Promise<InboxResult> {
	const rows = await api.queryDataSource(dataSourceId, {
		filter: {
			or: [
				{ property: INBOX.status, select: { equals: STATUS.pending } },
				{ property: INBOX.status, select: { is_empty: true } },
			],
		},
		sorts: [{ timestamp: "created_time", direction: "ascending" }],
		page_size: limit,
	});

	const result: InboxResult = { processed: 0, created: 0, statuses: {} };
	for (const row of rows.slice(0, limit)) {
		const content = textOf(row.properties[INBOX.content]).trim();
		const imp = numberOf(row.properties[INBOX.importance]);
		let status: string;
		let note: string;
		if (!content) {
			status = STATUS.rejected;
			note = "내용이 비어 있음";
		} else {
			try {
				const r = await remember(
					db,
					{
						content,
						category: parseCategory(selectOf(row.properties[INBOX.category])),
						importance: imp ? Math.min(5, Math.max(1, Math.round(imp))) : 3,
						source: "pickle",
					},
					sem,
				);
				if (r.status === "created") {
					status = STATUS.done;
					note = `저장됨 (${r.memory.id}, ${r.memory.category})`;
					result.created++;
				} else if (r.status === "duplicate") {
					status = STATUS.duplicate;
					note = `이미 있는 기억: ${r.existing.id}`;
				} else {
					status = STATUS.review;
					note = `비슷한 기억이 있어 저장 보류 — 같은 사실이면 그대로 두고, 다른 사실이면 Claude에서 저장: ${r.candidates
						.map((c) => `${c.id} "${c.content.slice(0, 60)}"`)
						.join(" / ")}`;
				}
			} catch (e) {
				if (!(e instanceof MemoryError)) throw e; // infra failure: leave the row pending for the next run
				status = STATUS.rejected;
				note = `${e.message} — 이 행은 Notion에서 직접 지워 주세요.`;
			}
		}
		await api.updatePage(row.id, {
			[INBOX.status]: { select: { name: status } },
			[INBOX.result]: { rich_text: richText(note.slice(0, RICH_TEXT_MAX)) },
		});
		result.processed++;
		result.statuses[status] = (result.statuses[status] ?? 0) + 1;
	}
	return result;
}
