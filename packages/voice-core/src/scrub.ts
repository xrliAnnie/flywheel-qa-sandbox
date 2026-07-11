/**
 * scrubTranscript (FLY-1065) — the secret red line for spoken transcripts.
 *
 * Applied at the FINAL aggregation exit (GeminiLiveSession flush), so every
 * downstream consumer (caption / quotes / recap / JSONL / Linear comment)
 * receives clean text from one choke point; the Discord caption exit and the
 * Linear landing re-apply it as defense in depth (shared/injectable paths).
 *
 * Patterns all require long-random-string shape — ordinary spoken language
 * (Chinese / English / mixed), URLs and issue ids must pass untouched (the
 * false-positive surface is pinned by scrub.test.ts). Hitting on real speech
 * is rare and that's expected: this guards "the assistant read a tool output
 * containing a credential aloud", not everyday conversation.
 *
 * Known v1 boundary: final:false 分片 events are NOT scrubbed (a token split
 * across fragments can't be matched piecewise); v1 has no consumer that
 * displays or persists fragments.
 */

const REDACTED = "[redacted]";

/** credential-shaped patterns → [redacted]. Order: specific before generic. */
const PATTERNS: RegExp[] = [
	/sk-[A-Za-z0-9_-]{16,}/g,
	/ghp_[A-Za-z0-9]{20,}/g,
	/github_pat_\w{20,}/g,
	/gho_[A-Za-z0-9]{20,}/g,
	/xox[baprs]-[A-Za-z0-9-]{10,}/g,
	/AIza[A-Za-z0-9_-]{30,}/g,
	/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
	/\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\s*[=:]\s*\S{8,}/g,
];

/**
 * Bare long random string: 40+ chars of base64url-ish alphabet containing
 * both letters and digits. `/` is deliberately EXCLUDED from the class (the
 * plan's sketch had it): with `/` every long URL path would be eaten, and the
 * pinned contract says URLs pass. Slash-carrying secrets are still caught by
 * the anchored patterns above (Bearer / prefixed keys).
 */
const BARE_RANDOM = /[A-Za-z0-9+=_-]{40,}/g;

export function scrubTranscript(text: string): string {
	let out = text;
	for (const p of PATTERNS) {
		out = out.replace(p, REDACTED);
	}
	out = out.replace(BARE_RANDOM, (m) =>
		/[A-Za-z]/.test(m) && /[0-9]/.test(m) ? REDACTED : m,
	);
	return out;
}
