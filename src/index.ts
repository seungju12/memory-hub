import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { tokenMatches } from "./auth/bearer";
import { type AuthProps, handleAuthRoute } from "./auth/github";
import { SERVER_INFO, buildServer } from "./mcp/server";

const MCP_ROUTE = "/mcp";

/** Requests under /mcp with a valid token (OAuth-issued or the static Bearer) land here. */
const mcpApi = {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const props = (ctx as ExecutionContext & { props?: Partial<AuthProps> }).props;
		// Stateless: a fresh server per request, so no Durable Object is needed.
		const handler = createMcpHandler(() => buildServer(env.DB, props?.source), { route: MCP_ROUTE });
		return handler(request, env, ctx);
	},
};

/** Everything that is not /mcp: health check, the consent page and GitHub callback. */
function defaultHandler(baseUrl: string) {
	return {
		async fetch(request: Request, env: Env) {
			const { pathname } = new URL(request.url);
			if (pathname === "/health") {
				return Response.json({ ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version });
			}
			return (await handleAuthRoute(request, env, baseUrl)) ?? new Response("Not found", { status: 404 });
		},
	};
}

function createProvider(baseUrl: string) {
	const resource = `${baseUrl}${MCP_ROUTE}`;
	return new OAuthProvider<Env>({
		apiRoute: MCP_ROUTE,
		apiHandler: mcpApi,
		defaultHandler: defaultHandler(baseUrl),
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/token",
		clientRegistrationEndpoint: "/register", // DCR: clients register themselves
		clientIdMetadataDocumentEnabled: true, // CIMD: newer MCP clients use an https client_id instead of DCR
		resourceMetadata: { resource, resource_name: "Memory Hub" },
		accessTokenTTL: 60 * 60, // 1 hour
		refreshTokenTTL: 60 * 60 * 24 * 30, // 30 days fixed …
		refreshTokenIdleTTL: 60 * 60 * 24 * 30, // … extended while the client keeps using it

		// CLI fallback: the static MCP_TOKEN is still accepted at /mcp (architecture §9 "CLI용 대안").
		resolveExternalToken: async ({ token, env }) => {
			if (!env.MCP_TOKEN || env.MCP_TOKEN.length < 16) return null; // fail closed
			if (!(await tokenMatches(token, env.MCP_TOKEN))) return null;
			return { props: {} satisfies Partial<AuthProps>, audience: resource };
		},
	});
}

// The public URL comes from PUBLIC_BASE_URL so switching to a custom domain (P3) is config-only.
// Without it (local dev) the request origin is used.
const providers = new Map<string, ReturnType<typeof createProvider>>();

function baseUrlFor(request: Request, env: Env): string {
	return (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

export default {
	fetch(request, env, ctx): Promise<Response> {
		const baseUrl = baseUrlFor(request, env);
		let provider = providers.get(baseUrl);
		if (!provider) {
			provider = createProvider(baseUrl);
			providers.set(baseUrl, provider);
		}
		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
