// P0 auth: a single static Bearer token (secret MCP_TOKEN).
// P1 replaces this with OAuth 2.1 for claude.ai / Antigravity and keeps tokens for CLI clients.

async function sha256(text: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Constant-time comparison; hashing first hides length differences. */
export async function tokenMatches(provided: string, expected: string): Promise<boolean> {
	const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
	return crypto.subtle.timingSafeEqual(a, b);
}

export async function checkBearer(request: Request, expected: string | undefined): Promise<Response | null> {
	if (!expected || expected.length < 16) {
		// Fail closed: a missing or weak server token must never mean "open to everyone".
		return new Response("Server misconfigured: MCP_TOKEN is not set (min 16 chars).", { status: 500 });
	}
	const header = request.headers.get("Authorization") ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(header);
	if (!match?.[1] || !(await tokenMatches(match[1].trim(), expected))) {
		return new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="memory-hub"' },
		});
	}
	return null;
}
