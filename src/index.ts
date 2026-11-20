import { createMcpHandler } from "agents/mcp/server";
import { checkBearer } from "./auth/bearer";
import { SERVER_INFO, buildServer } from "./mcp/server";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({ ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version });
		}

		if (url.pathname === "/mcp") {
			// Let CORS preflight through; everything else needs the token.
			if (request.method !== "OPTIONS") {
				const denied = await checkBearer(request, env.MCP_TOKEN);
				if (denied) return denied;
			}
			// Stateless: a fresh server per request, so no Durable Object is needed.
			const handler = createMcpHandler(() => buildServer(env.DB), { route: "/mcp" });
			return handler(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
