// Secrets are not in wrangler.jsonc, so `wrangler types` only sees them when
// .dev.vars exists. Declare them here so typecheck also works in CI.
interface Env {
	/** Static Bearer token for CLI clients (optional fallback next to OAuth). */
	MCP_TOKEN: string;
	/** GitHub OAuth App credentials (P1). */
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	/** Numeric GitHub user id of the only person allowed to sign in. */
	ALLOWED_GITHUB_USER_ID: string;
	/** Public origin, e.g. https://memory-hub.<account>.workers.dev (no trailing slash). */
	PUBLIC_BASE_URL?: string;
	/** OAuth grants, tokens and registered clients (workers-oauth-provider). */
	OAUTH_KV: KVNamespace;
	/** Injected by OAuthProvider into the default handler's env (not a real binding). */
	OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}
