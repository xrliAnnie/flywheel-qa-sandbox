const REDACTED = "[redacted]";
const SECRET_PATTERNS: RegExp[] = [
	/sk-[A-Za-z0-9_-]{16,}/g,
	/ghp_[A-Za-z0-9]{20,}/g,
	/github_pat_\w{20,}/g,
	/gho_[A-Za-z0-9]{20,}/g,
	/xox[baprs]-[A-Za-z0-9-]{10,}/g,
	/AIza[A-Za-z0-9_-]{30,}/g,
	/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
	/\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\s*[=:]\s*\S{8,}/g,
];
const BARE_RANDOM_SECRET = /[A-Za-z0-9+=_-]{40,}/g;

export function containsSecretLikeText(text: string): boolean {
	for (const pattern of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		if (pattern.test(text)) return true;
	}
	BARE_RANDOM_SECRET.lastIndex = 0;
	return Array.from(text.matchAll(BARE_RANDOM_SECRET)).some(
		([candidate]) => /[A-Za-z]/.test(candidate) && /[0-9]/.test(candidate),
	);
}

export function sanitizeDiscordText(text: string): string {
	let clean = text.trim();
	for (const pattern of SECRET_PATTERNS) {
		clean = clean.replace(pattern, REDACTED);
	}
	return clean
		.replace(BARE_RANDOM_SECRET, (candidate) =>
			/[A-Za-z]/.test(candidate) && /[0-9]/.test(candidate)
				? REDACTED
				: candidate,
		)
		.replace(/@(everyone|here)\b/gi, "@\u200b$1")
		.replace(/<@([!&]?\d+)>/g, "<@\u200b$1>");
}

export function chunkDiscordText(text: string, max = 1_900): string[] {
	if (!Number.isInteger(max) || max < 1) {
		throw new Error("Discord chunk size must be a positive integer");
	}
	const remaining = Array.from(text);
	const chunks: string[] = [];
	while (remaining.length > max) {
		const window = remaining.slice(0, max);
		const newline = window.lastIndexOf("\n");
		const size = newline > 0 ? newline : max;
		const chunk = remaining.splice(0, size).join("");
		if (newline > 0) remaining.shift();
		if (chunk) chunks.push(chunk);
	}
	const tail = remaining.join("");
	if (tail) chunks.push(tail);
	return chunks;
}
