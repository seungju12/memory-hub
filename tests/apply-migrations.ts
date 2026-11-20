import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is shared across tests in a file, so start each test from an empty DB.
beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM memories"),
		env.DB.prepare("DELETE FROM profile"),
		env.DB.prepare("DELETE FROM audit_log"),
	]);
});
