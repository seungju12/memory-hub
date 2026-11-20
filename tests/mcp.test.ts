import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const TOKEN = "test-token-0123456789";
const BASE = "https://memory-hub.example.workers.dev";
// Built at runtime so secret scanners do not flag this obviously fake fixture.
const FAKE_GITHUB_TOKEN = ["ghp", "x".repeat(36)].join("_");

async function rpc(method: string, params: unknown, token: string | null = TOKEN, id = 1) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": "2025-06-18",
		Host: new URL(BASE).host,
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return exports.default.fetch(
		new Request(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }),
	);
}

/** Parses either a JSON body or an SSE stream and returns the first JSON-RPC message. */
async function body(res: Response): Promise<any> {
	const text = await res.text();
	if ((res.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
		const line = text.split("\n").find((l) => l.startsWith("data:"));
		return JSON.parse(line!.slice(5));
	}
	return JSON.parse(text);
}

async function callTool(name: string, args: unknown) {
	const res = await rpc("tools/call", { name, arguments: args });
	expect(res.status).toBe(200);
	const msg = await body(res);
	return { isError: msg.result.isError === true, data: msg.result.content[0].text as string };
}

describe("HTTP surface", () => {
	it("serves /health without auth", async () => {
		const res = await exports.default.fetch(`${BASE}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, name: "memory-hub" });
	});

	it("rejects missing or wrong tokens", async () => {
		expect((await rpc("tools/list", {}, null)).status).toBe(401);
		expect((await rpc("tools/list", {}, "wrong-token-0123456789")).status).toBe(401);
	});

	it("returns 404 for unknown paths", async () => {
		expect((await exports.default.fetch(`${BASE}/nope`)).status).toBe(404);
	});
});

describe("MCP protocol", () => {
	it("initializes with server info and instructions", async () => {
		const res = await rpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		});
		expect(res.status).toBe(200);
		const msg = await body(res);
		expect(msg.result.serverInfo.name).toBe("memory-hub");
		expect(msg.result.instructions).toContain("get_context");
	});

	it("lists all tools", async () => {
		const msg = await body(await rpc("tools/list", {}));
		const names = msg.result.tools.map((t: { name: string }) => t.name).sort();
		expect(names).toEqual(
			["forget", "get_context", "get_profile", "list_memories", "recall", "remember", "set_profile", "update_memory"].sort(),
		);
	});

	it("remember → recall → get_context round trip", async () => {
		const saved = await callTool("remember", {
			content: "포트폴리오용 MCP 서버를 만들고 있다",
			category: "project",
			importance: 4,
			source: "claude-code",
		});
		expect(saved.isError).toBe(false);
		expect(JSON.parse(saved.data).status).toBe("created");

		const found = JSON.parse((await callTool("recall", { query: "포트폴리오" })).data);
		expect(found).toHaveLength(1);
		expect(found[0].source).toBe("claude-code");

		const ctx = JSON.parse((await callTool("get_context", {})).data);
		expect(ctx.important[0].content).toBe("포트폴리오용 MCP 서버를 만들고 있다");
	});

	it("returns a tool error (not a crash) for refused content", async () => {
		const res = await callTool("remember", { content: FAKE_GITHUB_TOKEN, category: "knowledge" });
		expect(res.isError).toBe(true);
		expect(res.data).toMatch(/GitHub token/);
	});

	it("validates input schemas", async () => {
		const msg = await body(await rpc("tools/call", { name: "remember", arguments: { content: "x", category: "nope" } }));
		const failed = msg.error !== undefined || msg.result?.isError === true;
		expect(failed).toBe(true);
	});
});
