// P1: the /authorize page and GitHub sign-in.
//
// Flow (MCP "confused deputy" protections come from the library's consent/upstream helpers):
//   GET  /authorize  → validate the MCP client's request, show a consent page (browser-bound handle)
//   POST /authorize  → user approved → redirect to GitHub with a browser-bound `state` + PKCE
//   GET  /callback   → exchange GitHub code, allow only ALLOWED_GITHUB_USER_ID, issue our grant
//
// The GitHub access token is used once to read the user id and then discarded:
// the MCP server never calls GitHub on the user's behalf.

import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import type { ClientInfo, ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const CALLBACK_PATH = "/callback";
const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";

/** What every authorized MCP request sees in ctx.props. */
export interface AuthProps {
	/** GitHub login of the owner (display only). */
	login: string;
	/** Name of the MCP client that was authorized, used as the default memory `source`. */
	source: string;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
	headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(
		`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
body{font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#1f2328;background:#fff}
h1{font-size:1.3rem}.box{border:1px solid #d0d7de;border-radius:8px;padding:1rem;margin:1rem 0}
.warn{background:#fff8c5;border-color:#d4a72c}button{font:inherit;padding:.5rem 1.2rem;border-radius:6px;border:1px solid #d0d7de;cursor:pointer}
button.primary{background:#1f883d;color:#fff;border-color:#1f883d}code{font-size:.9em}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}.box{border-color:#30363d}.warn{background:#3b2e00;border-color:#9e6a03}button{background:#21262d;color:#e6edf3;border-color:#30363d}}
</style></head><body>${body}</body></html>`,
		{ status, headers },
	);
}

function errorPage(message: string, status = 400): Response {
	return page("Memory Hub — 오류", `<h1>인증할 수 없습니다</h1><p>${escape(message)}</p>`, status);
}

export function consentPage(details: ConsentDescription, handle: string, headers: Headers): Response {
	const name = escape(details.clientName);
	const origin = details.clientDomain
		? `게시 도메인: <strong>${escape(details.clientDomain)}</strong>`
		: "이 앱은 스스로 등록했으므로 이름이 검증되지 않았습니다.";
	const loopback = details.redirectIsLoopback
		? `<div class="box warn"><strong>내 컴퓨터의 앱으로 권한이 전달됩니다.</strong> 방금 직접 로그인을 시작한 경우에만 계속하세요.</div>`
		: "";
	return page(
		`Memory Hub — ${details.clientName} 승인`,
		`<h1><strong>${name}</strong>이(가) Memory Hub에 접근하려고 합니다</h1>
<div class="box"><p>${origin}</p><p>권한을 받을 곳: <strong>${escape(details.redirectHost)}</strong></p>
<p>허용하면 이 앱이 내 기억을 읽고 쓸 수 있습니다. 다음 단계에서 GitHub로 본인 확인을 합니다.</p></div>
${loopback}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<button class="primary" name="decision" value="approve">허용하고 GitHub로 로그인</button>
<button name="decision" value="deny">거부</button>
</form>`,
		200,
		headers,
	);
}

/** Turns an OAuth client name into a short `source` label, e.g. "Claude Code" → "claude-code". */
export function sourceFromClient(client: ClientInfo | null): string {
	const slug = (client?.clientName ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9가-힣]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "oauth-client";
}

async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function randomVerifier(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function requireConfig(env: Env): string | null {
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return "GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET이 설정되지 않았습니다.";
	if (!/^\d+$/.test(env.ALLOWED_GITHUB_USER_ID ?? "")) return "ALLOWED_GITHUB_USER_ID(숫자 GitHub 사용자 ID)가 설정되지 않았습니다.";
	return null;
}

async function authorize(request: Request, env: Env, baseUrl: string): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;

	if (request.method === "GET") {
		const authRequest = await oauth.parseAuthRequest(request);
		const details = await oauth.describeConsent(authRequest); // first: a failed lookup leaves nothing in KV
		const consent = await oauth.beginConsent(authRequest);
		return consentPage(details, consent.handle, consent.headers);
	}

	if (request.method === "POST") {
		const form = await request.formData();
		const handle = String(form.get("handle") ?? "");
		if (form.get("decision") !== "approve") {
			const denied = await oauth.denyConsent(request, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		}
		const approved = await oauth.approveConsent(request, handle);
		const verifier = randomVerifier();
		const { state, headers } = await oauth.beginUpstream(approved.request, {
			data: { verifier },
			headers: approved.headers,
		});
		const github = new URL(GITHUB_AUTHORIZE);
		github.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
		github.searchParams.set("redirect_uri", `${baseUrl}${CALLBACK_PATH}`);
		github.searchParams.set("state", state);
		github.searchParams.set("code_challenge", await s256(verifier));
		github.searchParams.set("code_challenge_method", "S256");
		github.searchParams.set("allow_signup", "false");
		// No `scope`: a token with no scopes can still read the public profile (the numeric id we need).
		headers.set("Location", github.toString());
		return new Response(null, { status: 302, headers });
	}

	return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
}

async function callback(request: Request, env: Env, baseUrl: string): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
	const params = new URL(request.url).searchParams;
	const code = params.get("code");

	const deny = (description: string) => {
		headers.set("Location", authorizationErrorRedirect(original, "access_denied", description));
		return new Response(null, { status: 302, headers });
	};
	if (params.get("error") || !code) return deny("GitHub sign-in was cancelled or failed");

	const tokenRes = await fetch(GITHUB_TOKEN, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: `${baseUrl}${CALLBACK_PATH}`,
			code_verifier: data.verifier,
		}),
	});
	const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
	if (!tokenRes.ok || !token.access_token) return errorPage("GitHub에서 토큰을 받지 못했습니다. 다시 시도해 주세요.", 502);

	const userRes = await fetch(GITHUB_USER, {
		headers: {
			Authorization: `Bearer ${token.access_token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "memory-hub",
		},
	});
	const user = (await userRes.json().catch(() => ({}))) as { id?: number; login?: string };
	if (!userRes.ok || typeof user.id !== "number") return errorPage("GitHub 사용자 정보를 읽지 못했습니다.", 502);

	// Single-user server: everyone except the owner is turned away.
	if (String(user.id) !== env.ALLOWED_GITHUB_USER_ID) return deny("This GitHub account is not allowed");

	const client = await oauth.lookupClient(original.clientId);
	const props: AuthProps = { login: user.login ?? String(user.id), source: sourceFromClient(client) };
	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: `gh-${user.id}`, // must not contain ':'
		metadata: { client: client?.clientName ?? null },
		scope: original.scope,
		props,
	});
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

/** Handles the browser-facing auth routes. Returns null for paths it does not own. */
export async function handleAuthRoute(request: Request, env: Env, baseUrl: string): Promise<Response | null> {
	const { pathname } = new URL(request.url);
	if (pathname !== "/authorize" && pathname !== CALLBACK_PATH) return null;

	const misconfigured = requireConfig(env);
	if (misconfigured) return errorPage(`서버 설정 오류: ${misconfigured}`, 500);

	try {
		return pathname === "/authorize" ? await authorize(request, env, baseUrl) : await callback(request, env, baseUrl);
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
		if (error instanceof AuthorizationError) return errorPage(`${error.description} — 처음부터 다시 연결해 주세요.`);
		if (error instanceof CimdFetchError) return errorPage("이 앱을 확인할 수 없습니다.");
		throw error;
	}
}
