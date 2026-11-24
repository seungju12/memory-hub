// Bridge renderer (P3.5): turns D1 into the "About Me" snapshot that non-MCP clients read
// (Gemini via a Google Doc, Pickle via a Notion page). Sinks only format; what gets exported
// and in which order is decided here, once, so both stores always show the same thing.
import type { Category, Memory } from "../core/memory";

/** Architecture §3.2: keep the snapshot short — large docs hurt answer quality and speed. */
export const SNAPSHOT_BUDGET = 4500;

/** §9: only these leave D1 — anything with importance >= 4, plus profile/preference memories. */
export const EXPORT_MIN_IMPORTANCE = 4;
const ALWAYS_EXPORTED: readonly Category[] = ["profile", "preference"];

export const isExportable = (m: Pick<Memory, "category" | "importance">) =>
	m.importance >= EXPORT_MIN_IMPORTANCE || ALWAYS_EXPORTED.includes(m.category);

// Section order = reading order for the client. Categories not listed fall into "기타".
const SECTIONS: { title: string; categories: Category[] }[] = [
	{ title: "선호", categories: ["preference"] },
	{ title: "진행 중인 일", categories: ["project", "todo"] },
	{ title: "결정", categories: ["decision"] },
	{ title: "배경 정보", categories: ["profile", "knowledge"] },
];

export interface SnapshotSection {
	title: string;
	items: string[];
}

export interface Snapshot {
	title: string;
	generatedAt: string;
	profile: [string, string][];
	sections: SnapshotSection[];
	/** Memories left out because of the size budget (the client should not assume it knows everything). */
	omitted: number;
	/** Stable across runs while the content is the same — sinks skip the write when it matches. */
	hash: string;
}

export interface RenderInput {
	profile: Record<string, string>;
	memories: Memory[];
	now?: Date;
	budget?: number;
}

const itemLine = (m: Memory) => m.content.replace(/\s+/g, " ").trim();

/**
 * Picks memories by priority (importance, then recency) until the character budget is used,
 * then lays them out by section. Profile entries always go in first.
 */
export async function renderSnapshot(input: RenderInput): Promise<Snapshot> {
	const budget = input.budget ?? SNAPSHOT_BUDGET;
	const profile = Object.entries(input.profile).sort(([a], [b]) => a.localeCompare(b));
	let used = profile.reduce((n, [k, v]) => n + k.length + v.length + 6, 0);

	const ranked = input.memories
		.filter(isExportable)
		.sort((a, b) => b.importance - a.importance || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));

	const picked: Memory[] = [];
	let omitted = 0;
	for (const m of ranked) {
		const cost = itemLine(m).length + 3; // "- " + newline
		if (used + cost > budget) {
			omitted++;
			continue; // a shorter, lower-ranked item may still fit
		}
		used += cost;
		picked.push(m);
	}

	const sections: SnapshotSection[] = [];
	const placed = new Set<string>();
	for (const s of SECTIONS) {
		const items = picked.filter((m) => s.categories.includes(m.category));
		items.forEach((m) => placed.add(m.id));
		if (items.length) sections.push({ title: s.title, items: items.map(itemLine) });
	}
	const rest = picked.filter((m) => !placed.has(m.id));
	if (rest.length) sections.push({ title: "기타", items: rest.map(itemLine) });

	const body = { profile, sections, omitted };
	return {
		title: "About Me",
		generatedAt: (input.now ?? new Date()).toISOString(),
		...body,
		hash: await sha256Hex(JSON.stringify(body)),
	};
}

/** Plain markdown, used by the Google Docs sink and for previews. */
export function snapshotToMarkdown(s: Snapshot): string {
	const out: string[] = [
		`# ${s.title}`,
		"",
		`> Memory Hub가 자동으로 생성한 문서입니다 (갱신: ${s.generatedAt}). 직접 수정하면 다음 동기화 때 덮어써집니다.`,
		"",
	];
	if (s.profile.length) {
		out.push("## 프로필", "");
		for (const [k, v] of s.profile) out.push(`- **${k}**: ${v}`);
		out.push("");
	}
	for (const sec of s.sections) {
		out.push(`## ${sec.title}`, "");
		for (const item of sec.items) out.push(`- ${item}`);
		out.push("");
	}
	if (s.omitted) out.push(`_분량 제한으로 기억 ${s.omitted}개는 생략됨. 모르는 내용은 추측하지 말고 물어볼 것._`, "");
	return out.join("\n");
}

async function sha256Hex(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Loads everything the renderer may export. Filtering happens in SQL too, to keep the read small. */
export async function loadSnapshotInput(db: D1Database): Promise<Pick<RenderInput, "profile" | "memories">> {
	const [profileRes, memRes] = await Promise.all([
		db.prepare("SELECT key, value FROM profile").all<{ key: string; value: string }>(),
		db
			.prepare(
				`SELECT id, content, category, tags, source, importance, created_at, updated_at FROM memories
				 WHERE deleted_at IS NULL AND (importance >= ? OR category IN (${ALWAYS_EXPORTED.map(() => "?").join(", ")}))`,
			)
			.bind(EXPORT_MIN_IMPORTANCE, ...ALWAYS_EXPORTED)
			.all<Omit<Memory, "tags"> & { tags: string }>(),
	]);
	return {
		profile: Object.fromEntries(profileRes.results.map((r) => [r.key, r.value])),
		memories: memRes.results.map((r) => ({ ...r, tags: [] })), // tags are not rendered
	};
}
