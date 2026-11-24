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
	/** P3.5 Bridge → Notion (Pickle). Unset = Notion sync/inbox disabled. */
	NOTION_TOKEN?: string;
	/** Page that receives the About Me snapshot (shared with the integration). */
	NOTION_ABOUT_PAGE_ID?: string;
	/** Data source of the Memory Inbox database (Notion: database ⋯ → Manage data sources → Copy data source ID). */
	NOTION_INBOX_DATA_SOURCE_ID?: string;
	/** OAuth grants, tokens and registered clients (workers-oauth-provider). */
	OAUTH_KV: KVNamespace;
	/** Injected by OAuthProvider into the default handler's env (not a real binding). */
	OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}
