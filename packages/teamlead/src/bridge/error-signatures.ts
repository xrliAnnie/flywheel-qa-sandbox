/**
 * FLY-1048 (Task A1): shared error-signature table + line normalization.
 *
 * Pure functions consumed by BOTH detection sides:
 *  - runner side: `evaluateStuckCandidate` repeated-error-signature path (A3);
 *  - lead side: `LeadWatchdog` multi-frame veto (A4) via `computeFrameDeltas` (A2).
 *
 * The table covers the FLY-942 PRD false-negative strings the existing
 * recognizers structurally miss (exploration §1.4): "Server error mid-response"
 * (FLY-546/975), "Not logged in" (FLY-910 auth — does NOT match the
 * login…expired regex), rolling ENOENT loops (FLY-910 worktree), plus the
 * pre-existing evidence-only stream-idle-timeout string folded into the same
 * table (same "API Error:" strictness as detectStreamErrorSignature).
 *
 * Echo-immunity constraints:
 *  - alert bodies must NEVER echo `line` back into a pane-visible message
 *    (FLY-220 storm family) — callers render kind + suggested action only;
 *  - lines quoted with the `▏` prefix (the A5 suspicious-report quote marker)
 *    are skipped, so a delivered suspicious report re-captured in a Lead pane
 *    can never re-trigger the scanner.
 */

export type ErrorSignatureKind =
	| "server_error_mid_response" // FN2 (FLY-546/975)
	| "not_logged_in" // FN0 (FLY-910 auth)
	| "enoent_loop" // FN1 (FLY-910 worktree deleted)
	| "stream_idle_timeout"; // pre-existing evidence-only string, same table

export interface ErrorSignatureHit {
	kind: ErrorSignatureKind;
	/** The raw matching pane line. Lead-face evidence ONLY — never rendered
	 * into an alert body (echo immunity) and never shown to the founder. */
	line: string;
	/** Normalized form (paths/numbers stripped) — stable across frames of the
	 * same failure, the cross-frame repeat key for A2/A3. */
	signature: string;
}

/**
 * Quote prefix used when a suspicious report embeds pane lines into a
 * Lead-visible message (A5). Scanners skip lines carrying it.
 */
export const SUSPICIOUS_QUOTE_PREFIX = "▏";

const QUOTED_LINE = /^\s*▏/u;

/**
 * Ordered, most-specific-first: a line matches AT MOST one kind. All patterns
 * are case-insensitive with word boundaries so prose prefixes ("not logged
 * inside…", "stream idle timeout" without "API Error:") never match.
 */
const SIGNATURE_PATTERNS: ReadonlyArray<{
	kind: ErrorSignatureKind;
	pattern: RegExp;
}> = [
	{
		kind: "server_error_mid_response",
		pattern: /\bserver error mid[-\s]?response\b/i,
	},
	{ kind: "not_logged_in", pattern: /\bnot logged in\b/i },
	{ kind: "enoent_loop", pattern: /\bENOENT\b/i },
	// Same strictness as stuck-candidate's detectStreamErrorSignature: requires
	// `API Error:` AND `Stream idle timeout` on the SAME line.
	{ kind: "stream_idle_timeout", pattern: /API Error:.*Stream idle timeout/i },
];

/**
 * Normalize an error line into a stable signature: ANSI stripped, paths and
 * numbers replaced with placeholders, case-folded, whitespace collapsed. Two
 * frames of the SAME rolling failure (different attempt counters / elapsed
 * timers / tmp paths) normalize to the SAME signature.
 */
export function normalizeErrorLine(line: string): string {
	return (
		line
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escape sequences from tmux pane
			.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
			.toLowerCase()
			// Absolute / home-relative paths → <path> (before digit folding so
			// version-numbered path segments collapse into the same placeholder).
			.replace(/(?:~?\/)[\w@.~/-]+/g, "<path>")
			.replace(/\d+/g, "<n>")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/**
 * Scan pane text line by line for known error signatures. `▏`-quoted lines
 * (A5 suspicious-report quotes) are skipped. One hit per line, most-specific
 * kind first.
 */
export function scanErrorSignatures(text: string): ErrorSignatureHit[] {
	const hits: ErrorSignatureHit[] = [];
	for (const raw of text.split("\n")) {
		if (QUOTED_LINE.test(raw)) continue;
		for (const { kind, pattern } of SIGNATURE_PATTERNS) {
			if (pattern.test(raw)) {
				hits.push({ kind, line: raw, signature: normalizeErrorLine(raw) });
				break;
			}
		}
	}
	return hits;
}
