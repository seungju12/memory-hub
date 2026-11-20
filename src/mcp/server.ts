import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SemanticIndex } from "../search/semantic";
import {
	CATEGORIES,
	MAX_CONTENT,
	MAX_TAGS,
	MemoryError,
	forget,
	getContext,
	getProfile,
	listMemories,
	recall,
	remember,
	setProfile,
	updateMemory,
} from "../core/memory";

export const SERVER_INFO = { name: "memory-hub", version: "0.3.0" };

const INSTRUCTIONS = `Memory Hub is the user's single, shared long-term memory across all of their AI assistants.
- At the start of a conversation, call get_context (optionally with a topic) before answering.
- When you learn a durable fact about the user (preferences, decisions, ongoing projects, profile facts), call remember. Skip small talk and one-off details.
- If something contradicts a stored memory, call update_memory instead of creating a new one.
- remember may answer status "similar" with near-duplicate candidates: merge with update_memory, or retry with allow_similar: true if it is really a different fact.
- Never store secrets, passwords, API keys or government ID numbers.
- Memories are usually written in Korean; search with Korean keywords.`;

const category = z.enum(CATEGORIES);
const sourceField = z
	.string()
	.max(40)
	.optional()
	.describe("Name of the AI client making this call, e.g. 'claude', 'claude-code', 'antigravity'.");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
	try {
		return ok(await fn());
	} catch (e) {
		if (e instanceof MemoryError) return { content: [{ type: "text", text: e.message }], isError: true };
		throw e;
	}
}

/**
 * @param defaultSource Recorded as `source` when a tool call does not name one
 *   (P1: derived from the authorized OAuth client, e.g. "claude").
 * @param sem Semantic search (P2). Without it tools fall back to keyword search and exact dedupe.
 */
export function buildServer(db: D1Database, defaultSource?: string, sem?: SemanticIndex | null): McpServer {
	const withSource = <T extends { source?: string }>(args: T): T => ({ ...args, source: args.source?.trim() || defaultSource });
	const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

	server.registerTool(
		"get_context",
		{
			title: "Load user context",
			description:
				"Call at the start of every conversation. Returns the user's profile, important memories, recent memories, and (if topic is given) memories related to the topic.",
			inputSchema: z.object({
				topic: z.string().max(200).optional().describe("Optional topic of the current conversation, used to fetch related memories."),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ topic }) => run(() => getContext(db, topic, sem)),
	);

	server.registerTool(
		"recall",
		{
			title: "Search memories",
			description:
				"Search the user's memories by meaning and keywords (hybrid: semantic similarity + Korean substring match). A short natural-language query or a few keywords both work.",
			inputSchema: z.object({
				query: z.string().min(1).max(200),
				category: category.optional(),
				limit: z.number().int().min(1).max(50).optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args) => run(() => recall(db, args, sem)),
	);

	server.registerTool(
		"remember",
		{
			title: "Save a memory",
			description:
				"Save one durable fact about the user. One fact per call, written as a self-contained sentence. Returns status 'duplicate' if the exact fact is stored, or 'similar' with near-duplicate candidates (not saved) so you can merge via update_memory or retry with allow_similar: true.",
			inputSchema: z.object({
				content: z.string().min(1).max(MAX_CONTENT),
				category: category.describe(
					"profile: who the user is; preference: likes/dislikes and working style; project: ongoing work; decision: choices made and why; knowledge: things the user knows or learned; todo: open tasks.",
				),
				tags: z.array(z.string().max(40)).max(MAX_TAGS).optional(),
				importance: z.number().int().min(1).max(5).optional().describe("1 (trivial) to 5 (core identity). Default 3."),
				source: sourceField,
				// Some clients send booleans as "true"/"false" (e.g. with a tool list cached before this field existed).
				allow_similar: z
					.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean())
					.optional()
					.describe("Set true only after a 'similar' response, when the new fact is genuinely different from the candidates."),
			}),
		},
		async (args) => run(() => remember(db, withSource(args), sem)),
	);

	server.registerTool(
		"update_memory",
		{
			title: "Update a memory",
			description: "Correct or refine an existing memory by id. Only the given fields change.",
			inputSchema: z.object({
				id: z.string().min(1),
				content: z.string().min(1).max(MAX_CONTENT).optional(),
				category: category.optional(),
				tags: z.array(z.string().max(40)).max(MAX_TAGS).optional(),
				importance: z.number().int().min(1).max(5).optional(),
				source: sourceField,
			}),
			annotations: { idempotentHint: true },
		},
		async (args) => run(() => updateMemory(db, withSource(args), sem)),
	);

	server.registerTool(
		"forget",
		{
			title: "Forget a memory",
			description: "Soft-delete a memory that is wrong or no longer true. Only use when the user asks or the fact is clearly obsolete.",
			inputSchema: z.object({
				id: z.string().min(1),
				reason: z.string().max(200).optional(),
				source: sourceField,
			}),
			annotations: { destructiveHint: true },
		},
		async (args) =>
			run(async () => {
				const { id, reason, source } = withSource(args);
				return { forgotten: await forget(db, id, reason, source, sem) };
			}),
	);

	server.registerTool(
		"list_memories",
		{
			title: "List memories",
			description: "List memories, newest first, optionally filtered by category or update time (ISO 8601).",
			inputSchema: z.object({
				category: category.optional(),
				since: z.string().datetime({ offset: true }).optional(),
				limit: z.number().int().min(1).max(100).optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args) => run(() => listMemories(db, args)),
	);

	server.registerTool(
		"get_profile",
		{
			title: "Get profile",
			description: "Return the user's core profile as key-value pairs (name, language, job, ...).",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () => run(() => getProfile(db)),
	);

	server.registerTool(
		"set_profile",
		{
			title: "Set profile field",
			description: "Set or delete (value: null) one core profile field. Keys are snake_case, e.g. name, job, location, tech_stack.",
			inputSchema: z.object({
				key: z.string().min(1).max(64),
				value: z.string().max(MAX_CONTENT).nullable(),
				source: sourceField,
			}),
			annotations: { idempotentHint: true },
		},
		async (args) =>
			run(async () => {
				const { key, value, source } = withSource(args);
				await setProfile(db, key, value, source);
				return { ok: true, key, value };
			}),
	);

	return server;
}
