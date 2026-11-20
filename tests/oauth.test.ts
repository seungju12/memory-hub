import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "https://memory-hub.example.workers.dev";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const ALLOWED_ID = 4242; // matches ALLOWED_GITHUB_USER_ID in vitest.config.ts

const app = (input: string | Request, init?: RequestInit) =>
	exports.default.fetch(typeof input === "string" ? new Request(new URL(input, BASE), init) : input);

/** Minimal cookie jar: keeps name=value pairs from Set-Cookie headers. */
class Jar {
	private cookies = new Map<string, string>();
	take(res: Response) {
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(";");
			const i = pair!.indexOf("=");
			const name = pair!.slice(0, i);
			if (/max-age=0/i.test(c)) this.cookies.delete(name);
			else this.cookies.set(name, pair!.slice(i + 1));
		}
	}
	header() {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	}
}

function b64url(bytes: ArrayBuffer | Uint8Array) {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

async function pkce() {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	return { verifier, challenge };
}

/** Fakes github.com and api.github.com; everything else would be a bug in the test. */
function mockGitHub(userId: number, login = "owner") {
	const real = globalThis.fetch;
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.href === "https://github.com/login/oauth/access_token") {
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("client_secret")).toBe("test-gh-secret");
			expect(body.get("code_verifier")).toBeTruthy();
			return Response.json({ access_token: "gho_fake", token_type: "bearer", scope: "" });
		}
		if (url.href === "https://api.github.com/user") return Response.json({ id: userId, login });
		return real(input, init);
	});
}

async function register(name = "Claude") {
	const res = await app("/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { client_id: string }).client_id;
}

/** Runs /authorize (GET + POST) and returns the GitHub redirect, with cookies in the jar. */
async function startAuthorization(clientId: string, jar: Jar, challenge: string) {
	const url = new URL("/authorize", BASE);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		state: "client-state-1",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${BASE}/mcp`,
	}).toString();
	const consent = await app(url.toString());
	expect(consent.status).toBe(200);
	expect(consent.headers.get("X-Frame-Options")).toBe("DENY");
	jar.take(consent);
	const html = await consent.text();
	expect(html).toContain("Claude");
	expect(html).toContain("claude.ai");
	const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
	return { handle, consentUrl: url.toString() };
}

async function postConsent(jar: Jar | null, handle: string, decision: "approve" | "deny") {
	const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
	if (jar) headers.Cookie = jar.header();
	return app("/authorize", { method: "POST", headers, body: new URLSearchParams({ handle, decision }), redirect: "manual" });
}

async function callback(jar: Jar, githubRedirect: string) {
	const state = new URL(githubRedirect).searchParams.get("state")!;
	return app(`/callback?code=gh-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: jar.header() }, redirect: "manual" });
}

let spy: ReturnType<typeof mockGitHub> | undefined;
afterEach(() => spy?.mockRestore());

describe("OAuth discovery", () => {
	it("publishes authorization server and protected resource metadata", async () => {
		const as = (await (await app("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
		expect(as.authorization_endpoint).toBe(`${BASE}/authorize`);
		expect(as.token_endpoint).toBe(`${BASE}/token`);
		expect(as.registration_endpoint).toBe(`${BASE}/register`);
		expect(as.code_challenge_methods_supported).toContain("S256");

		const pr = (await (await app("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
		expect(pr.resource).toBe(`${BASE}/mcp`);
	});

	it("still serves /health and 404s unknown paths", async () => {
		expect((await app("/health")).status).toBe(200);
		expect((await app("/nope")).status).toBe(404);
	});
});

describe("OAuth flow with GitHub sign-in", () => {
	beforeEach(() => {
		spy = undefined;
	});

	it("authorizes the allowed GitHub user end to end and records the client as source", async () => {
		spy = mockGitHub(ALLOWED_ID);
		const jar = new Jar();
		const { verifier, challenge } = await pkce();
		const clientId = await register("Claude");
		const { handle } = await startAuthorization(clientId, jar, challenge);

		const toGitHub = await postConsent(jar, handle, "approve");
		expect(toGitHub.status).toBe(302);
		jar.take(toGitHub);
		const gh = new URL(toGitHub.headers.get("Location")!);
		expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(gh.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
		expect(gh.searchParams.get("code_challenge_method")).toBe("S256");

		const back = await callback(jar, gh.toString());
		expect(back.status).toBe(302);
		const toClient = new URL(back.headers.get("Location")!);
		expect(toClient.origin + toClient.pathname).toBe(REDIRECT);
		expect(toClient.searchParams.get("state")).toBe("client-state-1");
		const code = toClient.searchParams.get("code")!;
		expect(code).toBeTruthy();

		const tokenRes = await app("/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT,
				client_id: clientId,
				code_verifier: verifier,
				resource: `${BASE}/mcp`,
			}),
		});
		expect(tokenRes.status).toBe(200);
		const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
		expect(tokens.refresh_token).toBeTruthy();

		const call = await app("/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tokens.access_token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2025-06-18",
				Host: new URL(BASE).host, // the MCP handler rejects requests without Host (DNS rebinding guard)
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "remember", arguments: { content: "OAuth로 연결된 클라이언트에서 저장한 기억", category: "knowledge" } },
			}),
		});
		expect(call.status).toBe(200);
		const text = await call.text();
		const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text;
		const msg = JSON.parse(line.replace(/^data:/, ""));
		const saved = JSON.parse(msg.result.content[0].text);
		expect(saved.status).toBe("created");
		expect(saved.memory.source).toBe("claude"); // from the OAuth client name, not a tool argument
	});

	it("rejects a GitHub user other than the owner", async () => {
		spy = mockGitHub(9999, "stranger");
		const jar = new Jar();
		const { challenge } = await pkce();
		const { handle } = await startAuthorization(await register(), jar, challenge);
		const toGitHub = await postConsent(jar, handle, "approve");
		jar.take(toGitHub);
		const back = await callback(jar, toGitHub.headers.get("Location")!);
		expect(back.status).toBe(302);
		const toClient = new URL(back.headers.get("Location")!);
		expect(toClient.searchParams.get("error")).toBe("access_denied");
		expect(toClient.searchParams.get("code")).toBeNull();
	});

	it("returns access_denied to the client when the user clicks Deny", async () => {
		const jar = new Jar();
		const { challenge } = await pkce();
		const { handle } = await startAuthorization(await register(), jar, challenge);
		const denied = await postConsent(jar, handle, "deny");
		expect(denied.status).toBe(302);
		expect(new URL(denied.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
	});

	it("refuses a consent post without the browser-binding cookie (CSRF)", async () => {
		const jar = new Jar();
		const { challenge } = await pkce();
		const { handle } = await startAuthorization(await register(), jar, challenge);
		const forged = await postConsent(null, handle, "approve");
		expect(forged.status).toBe(400);
		expect(forged.headers.get("Location")).toBeNull();
	});

	it("refuses a callback whose state is not bound to this browser", async () => {
		spy = mockGitHub(ALLOWED_ID);
		const jar = new Jar();
		const { challenge } = await pkce();
		const { handle } = await startAuthorization(await register(), jar, challenge);
		const toGitHub = await postConsent(jar, handle, "approve");
		const state = new URL(toGitHub.headers.get("Location")!).searchParams.get("state")!;
		const replay = await app(`/callback?code=gh-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
		expect(replay.status).toBe(400);
	});

	it("does not render client-supplied names as HTML", async () => {
		const jar = new Jar();
		const { challenge } = await pkce();
		const clientId = await register('<script>alert(1)</script>');
		const url = new URL("/authorize", BASE);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: REDIRECT,
			state: "s",
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		const html = await (await app(url.toString())).text();
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&#60;script&#62;");
		void jar;
	});
});
