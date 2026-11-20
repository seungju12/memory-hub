import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.example.jsonc" },
			miniflare: {
				bindings: {
					MCP_TOKEN: "test-token-0123456789",
					PUBLIC_BASE_URL: "https://memory-hub.example.workers.dev",
					GITHUB_CLIENT_ID: "test-gh-client",
					GITHUB_CLIENT_SECRET: "test-gh-secret",
					ALLOWED_GITHUB_USER_ID: "4242",
					TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, "migrations")),
				},
			},
		})),
	],
	test: {
		setupFiles: ["./tests/apply-migrations.ts"],
	},
});
