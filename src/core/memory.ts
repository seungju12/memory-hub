// Core service layer: every write path (MCP tools, future Bridge inbox, Gemini import)
// goes through these functions so validation, dedupe and audit stay consistent.
import { findSensitive } from "./sensitive";
import { ulid } from "./ulid";

export const CATEGORIES = ["profile", "preference", "project", "decision", "knowledge", "todo"] as const;
export type Category = (typeof CATEGORIES)[number];

export const MAX_CONTENT = 2000;
export const MAX_TAGS = 10;

export interface Memory {
	id: string;
	content: string;
	category: Category;
	tags: string[];
	source: string;
	importance: number;
	created_at: string;
	updated_at: string;
}

interface MemoryRow extends Omit<Memory, "tags"> {
	tags: string;
}

export class MemoryError extends Error {}

const SELECT_COLS = "id, content, category, tags, source, importance, created_at, updated_at";

function toMemory(row: MemoryRow): Memory {
	let tags: string[] = [];
	try {
		const parsed: unknown = JSON.parse(row.tags);
		if (Array.isArray(parsed)) tags = parsed.map(String);
	} catch {
		// corrupted tags column — treat as empty
	}
	return { ...row, tags };
}

function normalizeTags(tags: string[] | undefined): string[] {
	const out = [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
	if (out.length > MAX_TAGS) throw new MemoryError(`tags: at most ${MAX_TAGS} allowed`);
	return out;
}

function validateContent(content: string): string {
	const text = content.trim();
	if (!text) throw new MemoryError("content must not be empty");
	if (text.length > MAX_CONTENT) throw new MemoryError(`content: at most ${MAX_CONTENT} characters`);
	const hit = findSensitive(text);
	if (hit) throw new MemoryError(`refused: content looks like a ${hit}. Memory Hub never stores secrets or identifiers.`);
	return text;
}

const normalizeForDedupe = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

async function audit(db: D1Database, memoryId: string | null, action: string, source: string, diff: unknown) {
	await db
		.prepare("INSERT INTO audit_log (memory_id, action, source, diff, at) VALUES (?, ?, ?, ?, ?)")
		.bind(memoryId, action, source, JSON.stringify(diff), new Date().toISOString())
		.run();
}

export async function getMemory(db: D1Database, id: string): Promise<Memory | null> {
	const row = await db
		.prepare(`SELECT ${SELECT_COLS} FROM memories WHERE id = ? AND deleted_at IS NULL`)
		.bind(id)
		.first<MemoryRow>();
	return row ? toMemory(row) : null;
}

export interface RememberInput {
	content: string;
	category: Category;
	tags?: string[];
	importance?: number;
	source?: string;
}

export type RememberResult = { status: "created"; memory: Memory } | { status: "duplicate"; existing: Memory };

export async function remember(db: D1Database, input: RememberInput): Promise<RememberResult> {
	const content = validateContent(input.content);
	const tags = normalizeTags(input.tags);
	const source = input.source?.trim() || "unknown";
	const importance = input.importance ?? 3;

	// P0 dedupe: exact match after normalization. P2 replaces this with vector similarity.
	const { results } = await db
		.prepare(`SELECT ${SELECT_COLS} FROM memories WHERE deleted_at IS NULL AND category = ?`)
		.bind(input.category)
		.all<MemoryRow>();
	const target = normalizeForDedupe(content);
	const dup = results.find((r) => normalizeForDedupe(r.content) === target);
	if (dup) return { status: "duplicate", existing: toMemory(dup) };

	const now = new Date().toISOString();
	const memory: Memory = {
		id: ulid(),
		content,
		category: input.category,
		tags,
		source,
		importance,
		created_at: now,
		updated_at: now,
	};
	await db
		.prepare(
			"INSERT INTO memories (id, content, category, tags, source, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(memory.id, content, memory.category, JSON.stringify(tags), source, importance, now, now)
		.run();
	await audit(db, memory.id, "create", source, { content, category: memory.category, tags, importance });
	return { status: "created", memory };
}

export interface UpdateInput {
	id: string;
	content?: string;
	category?: Category;
	tags?: string[];
	importance?: number;
	source?: string;
}

export async function updateMemory(db: D1Database, input: UpdateInput): Promise<Memory> {
	const current = await getMemory(db, input.id);
	if (!current) throw new MemoryError(`memory not found: ${input.id}`);
	const next: Memory = {
		...current,
		content: input.content !== undefined ? validateContent(input.content) : current.content,
		category: input.category ?? current.category,
		tags: input.tags !== undefined ? normalizeTags(input.tags) : current.tags,
		importance: input.importance ?? current.importance,
		updated_at: new Date().toISOString(),
	};
	await db
		.prepare("UPDATE memories SET content = ?, category = ?, tags = ?, importance = ?, updated_at = ? WHERE id = ?")
		.bind(next.content, next.category, JSON.stringify(next.tags), next.importance, next.updated_at, next.id)
		.run();
	const source = input.source?.trim() || "unknown";
	await audit(db, next.id, "update", source, {
		before: { content: current.content, category: current.category, tags: current.tags, importance: current.importance },
		after: { content: next.content, category: next.category, tags: next.tags, importance: next.importance },
	});
	return next;
}

export async function forget(db: D1Database, id: string, reason?: string, source = "unknown"): Promise<Memory> {
	const current = await getMemory(db, id);
	if (!current) throw new MemoryError(`memory not found: ${id}`);
	const now = new Date().toISOString();
	await db.prepare("UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(now, now, id).run();
	await audit(db, id, "forget", source, { reason: reason ?? null });
	return current;
}

// ---------- search ----------

// Common Korean particles; stripping them lets "프로젝트를" match "프로젝트".
const KO_PARTICLES = ["에서", "으로", "에게", "까지", "부터", "을", "를", "이", "가", "은", "는", "의", "에", "로", "와", "과", "도", "랑"];

export function queryTerms(query: string): string[] {
	const raw = query
		.toLowerCase()
		.split(/[\s,.;:!?()[\]{}"'`/\\|]+/)
		.filter(Boolean);
	const terms = new Set<string>();
	for (const t of raw) {
		terms.add(t);
		if (/[가-힣]$/.test(t) && t.length >= 3) {
			const p = KO_PARTICLES.find((p) => t.endsWith(p) && t.length - p.length >= 2);
			if (p) terms.add(t.slice(0, -p.length));
		}
	}
	return [...terms].slice(0, 8);
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface RecallInput {
	query: string;
	category?: Category;
	limit?: number;
}

export async function recall(db: D1Database, input: RecallInput): Promise<(Memory & { score: number })[]> {
	const terms = queryTerms(input.query);
	if (terms.length === 0) return [];
	const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);

	// Each matched term adds 1 to the score. The trigram FTS table makes LIKE
	// work for Korean substrings without a morphological analyzer.
	const scoreExpr = terms
		.map(() => "((f.content LIKE ? ESCAPE '\\') OR (f.tags LIKE ? ESCAPE '\\'))")
		.join(" + ");
	const binds: unknown[] = [];
	for (const t of terms) {
		const pattern = `%${escapeLike(t)}%`;
		binds.push(pattern, pattern);
	}
	let sql = `
		SELECT ${SELECT_COLS.split(", ").map((c) => `m.${c}`).join(", ")}, (${scoreExpr}) AS score
		FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
		WHERE m.deleted_at IS NULL`;
	if (input.category) {
		sql += " AND m.category = ?";
		binds.push(input.category);
	}
	sql += " AND score > 0 ORDER BY score DESC, m.importance DESC, m.updated_at DESC LIMIT ?";
	binds.push(limit);

	const { results } = await db.prepare(sql).bind(...binds).all<MemoryRow & { score: number }>();
	return results.map((r) => ({ ...toMemory(r), score: r.score }));
}

export interface ListInput {
	category?: Category;
	since?: string;
	limit?: number;
}

export async function listMemories(db: D1Database, input: ListInput = {}): Promise<Memory[]> {
	const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
	let sql = `SELECT ${SELECT_COLS} FROM memories WHERE deleted_at IS NULL`;
	const binds: unknown[] = [];
	if (input.category) {
		sql += " AND category = ?";
		binds.push(input.category);
	}
	if (input.since) {
		sql += " AND updated_at >= ?";
		binds.push(input.since);
	}
	sql += " ORDER BY updated_at DESC LIMIT ?";
	binds.push(limit);
	const { results } = await db.prepare(sql).bind(...binds).all<MemoryRow>();
	return results.map(toMemory);
}

// ---------- profile ----------

export async function getProfile(db: D1Database): Promise<Record<string, string>> {
	const { results } = await db.prepare("SELECT key, value FROM profile ORDER BY key").all<{ key: string; value: string }>();
	return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function setProfile(db: D1Database, key: string, value: string | null, source = "unknown") {
	const k = key.trim().toLowerCase();
	if (!/^[a-z0-9_]{1,64}$/.test(k)) throw new MemoryError("profile key must be snake_case (a-z, 0-9, _), max 64 chars");
	if (value === null) {
		await db.prepare("DELETE FROM profile WHERE key = ?").bind(k).run();
		await audit(db, null, "profile_delete", source, { key: k });
		return;
	}
	const v = validateContent(value);
	await db
		.prepare(
			"INSERT INTO profile (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		)
		.bind(k, v, new Date().toISOString())
		.run();
	await audit(db, null, "profile_set", source, { key: k, value: v });
}

// ---------- context ----------

export interface Context {
	profile: Record<string, string>;
	important: Memory[];
	recent: Memory[];
	related: Memory[];
}

/** Snapshot an AI client should load at the start of a conversation. */
export async function getContext(db: D1Database, topic?: string): Promise<Context> {
	const [profile, importantRes, recent, related] = await Promise.all([
		getProfile(db),
		db
			.prepare(
				`SELECT ${SELECT_COLS} FROM memories WHERE deleted_at IS NULL AND importance >= 4 ORDER BY importance DESC, updated_at DESC LIMIT 20`,
			)
			.all<MemoryRow>(),
		listMemories(db, { limit: 10 }),
		topic ? recall(db, { query: topic, limit: 10 }) : Promise.resolve([]),
	]);
	const important = importantRes.results.map(toMemory);
	const seen = new Set(important.map((m) => m.id));
	return {
		profile,
		important,
		recent: recent.filter((m) => !seen.has(m.id)),
		related: related.filter((m) => !seen.has(m.id)).map(({ score: _s, ...m }) => m),
	};
}
