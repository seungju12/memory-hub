// Bridge sync (P3.5): render the snapshot once, push it to every configured sink whose copy is stale.
import type { SemanticIndex } from "../search/semantic";
import { collectNotionInbox, httpNotion, notionAboutMeSink } from "./notion";
import { type Snapshot, loadSnapshotInput, renderSnapshot } from "./renderer";

export interface Sink {
	name: string;
	write(snapshot: Snapshot): Promise<void>;
}

/** Safety net (architecture §3.2 "하루 1회 전체 재생성"): rewrite even an unchanged snapshot after this. */
export const FULL_RESYNC_MS = 24 * 60 * 60 * 1000;

export interface SinkOutcome {
	sink: string;
	action: "written" | "skipped" | "failed";
	error?: string;
}

/** One sink failing never stops the others; the error is kept in bridge_state.last_error. */
export async function syncSinks(db: D1Database, sinks: Sink[], now = new Date()): Promise<SinkOutcome[]> {
	if (sinks.length === 0) return [];
	const snapshot = await renderSnapshot({ ...(await loadSnapshotInput(db)), now });
	const { results } = await db.prepare("SELECT sink, hash, synced_at FROM bridge_state").all<{ sink: string; hash: string | null; synced_at: string | null }>();
	const state = new Map(results.map((r) => [r.sink, r]));
	const at = now.toISOString();

	const outcomes: SinkOutcome[] = [];
	for (const sink of sinks) {
		const prev = state.get(sink.name);
		const fresh = prev?.synced_at && now.getTime() - Date.parse(prev.synced_at) < FULL_RESYNC_MS;
		if (prev?.hash === snapshot.hash && fresh) {
			await db.prepare("UPDATE bridge_state SET checked_at = ? WHERE sink = ?").bind(at, sink.name).run();
			outcomes.push({ sink: sink.name, action: "skipped" });
			continue;
		}
		try {
			await sink.write(snapshot);
			await db
				.prepare(
					`INSERT INTO bridge_state (sink, hash, synced_at, checked_at, last_error) VALUES (?, ?, ?, ?, NULL)
					 ON CONFLICT(sink) DO UPDATE SET hash = excluded.hash, synced_at = excluded.synced_at, checked_at = excluded.checked_at, last_error = NULL`,
				)
				.bind(sink.name, snapshot.hash, at, at)
				.run();
			outcomes.push({ sink: sink.name, action: "written" });
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			await db
				.prepare(
					`INSERT INTO bridge_state (sink, checked_at, last_error) VALUES (?, ?, ?)
					 ON CONFLICT(sink) DO UPDATE SET checked_at = excluded.checked_at, last_error = excluded.last_error`,
				)
				.bind(sink.name, at, error.slice(0, 500))
				.run();
			outcomes.push({ sink: sink.name, action: "failed", error });
		}
	}
	return outcomes;
}

/** Sinks whose secrets are set. Unconfigured stores are simply skipped. */
export function configuredSinks(env: Env): Sink[] {
	const sinks: Sink[] = [];
	if (env.NOTION_TOKEN && env.NOTION_ABOUT_PAGE_ID) sinks.push(notionAboutMeSink(httpNotion(env.NOTION_TOKEN), env.NOTION_ABOUT_PAGE_ID));
	return sinks;
}

export async function runSnapshotSync(env: Env) {
	const outcomes = await syncSinks(env.DB, configuredSinks(env));
	for (const o of outcomes) {
		if (o.action === "failed") console.error(`[bridge] ${o.sink} sync failed: ${o.error}`);
		else if (o.action === "written") console.log(`[bridge] ${o.sink} snapshot written`);
	}
}

export async function runInboxCollection(env: Env, sem: SemanticIndex | null) {
	if (!env.NOTION_TOKEN || !env.NOTION_INBOX_DATA_SOURCE_ID) return;
	const r = await collectNotionInbox(env.DB, httpNotion(env.NOTION_TOKEN), env.NOTION_INBOX_DATA_SOURCE_ID, sem);
	if (r.processed) console.log(`[bridge] notion inbox: ${JSON.stringify(r.statuses)}`);
}
