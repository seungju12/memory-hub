// Static Bearer token check (P0). Since P1 it is the CLI fallback next to OAuth,
// wired in through OAuthProvider.resolveExternalToken (see src/index.ts).

async function sha256(text: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Constant-time comparison; hashing first hides length differences. */
export async function tokenMatches(provided: string, expected: string): Promise<boolean> {
	const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
	return crypto.subtle.timingSafeEqual(a, b);
}
