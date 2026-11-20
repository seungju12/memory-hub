// Rejects content that looks like secrets or high-risk personal identifiers.
// Memory Hub stores facts about the user — never credentials.

const PATTERNS: { name: string; re: RegExp }[] = [
	{ name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "API key (OpenAI/Anthropic style)", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
	{ name: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/ },
	{ name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
	{ name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
	{ name: "Korean resident registration number", re: /\b\d{6}-?[1-4]\d{6}\b/ },
	{ name: "password", re: /(password|passwd|비밀번호|패스워드)\s*[:=]\s*\S+/i },
];

function luhnValid(digits: string): boolean {
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = Number(digits[i]);
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

/** Returns the name of the first sensitive pattern found, or null. */
export function findSensitive(text: string): string | null {
	for (const { name, re } of PATTERNS) {
		if (re.test(text)) return name;
	}
	for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
		const digits = m[0].replace(/\D/g, "");
		if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return "card number";
	}
	return null;
}
