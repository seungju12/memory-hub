// Secrets are not in wrangler.jsonc, so `wrangler types` only sees them when
// .dev.vars exists. Declare them here so typecheck also works in CI.
interface Env {
	MCP_TOKEN: string;
}
