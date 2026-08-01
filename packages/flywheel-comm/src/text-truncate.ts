/**
 * FLY-1586 C — code-point-safe truncation.
 *
 * `String.prototype.slice(0, N)` cuts on UTF-16 **code units**. An astral
 * character (emoji, most CJK extensions) occupies two code units, so a cut that
 * lands between them leaves a lone surrogate — half a character. SQLite cannot
 * store that: it substitutes U+FFFD. Any insert-then-verify read-back therefore
 * sees a value different from the one it wrote, throws, and rolls back the whole
 * transaction. One such row (lead_events seq 56649) wedged every Lead inbox loop
 * in the fleet for 61 hours.
 *
 * ## Contract — deliberately narrow
 *
 * These helpers guarantee only that they will not **split** a well-formed
 * surrogate pair. They do **not** repair a lone surrogate that was already in
 * the input. That repair — and its sanitation audit — lives at the authoritative
 * enqueue boundary (FLY-1586 A). Keeping repair in exactly one place is what
 * makes the audit trail trustworthy: if C quietly repaired on the way past, the
 * audit would never learn a poison value existed.
 *
 * `String.prototype.toWellFormed()` is ES2024; this repo targets ES2022, so it
 * does not typecheck here. Raising the whole repo's `lib` for one P0 is not
 * worth it — hence the hand-rolled scan below.
 */

export interface TruncateResult {
	/** The (possibly shortened) text. Never splits a well-formed pair. */
	text: string;
	/** True when characters were dropped — drives the caller's ellipsis. */
	truncated: boolean;
}

const HIGH_START = 0xd800;
const HIGH_END = 0xdbff;
const LOW_START = 0xdc00;
const LOW_END = 0xdfff;

function assertLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new Error("limit must be a positive safe integer");
	}
}

/**
 * Number of Unicode code points in `value`. An unpaired surrogate counts as one
 * (this must not throw — poison values reach here by definition).
 */
export function countCodePoints(value: string): number {
	let count = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= HIGH_START && code <= HIGH_END) {
			const next = value.charCodeAt(i + 1);
			// NaN (past the end) fails both comparisons — a trailing high
			// surrogate is left alone rather than swallowing a phantom pair.
			if (next >= LOW_START && next <= LOW_END) i++;
		}
		count++;
	}
	return count;
}

/**
 * Keep at most `limit` code points from the START of `value`.
 * Replaces `value.slice(0, limit)` at every boundary that can reach `lead_inbox`.
 */
export function truncateCodePoints(
	value: string,
	limit: number,
): TruncateResult {
	assertLimit(limit);
	let count = 0;
	let i = 0;
	while (i < value.length) {
		if (count === limit) return { text: value.slice(0, i), truncated: true };
		const code = value.charCodeAt(i);
		if (code >= HIGH_START && code <= HIGH_END) {
			const next = value.charCodeAt(i + 1);
			i += next >= LOW_START && next <= LOW_END ? 2 : 1;
		} else {
			i += 1;
		}
		count++;
	}
	return { text: value, truncated: false };
}

/**
 * Keep at most `limit` code points from the END of `value`.
 * Replaces `value.slice(-limit)` — the negative-direction cut (e.g. pane tails),
 * which a `.slice(0, N)` grep cannot even find.
 */
export function truncateCodePointsFromEnd(
	value: string,
	limit: number,
): TruncateResult {
	assertLimit(limit);
	let count = 0;
	let i = value.length;
	while (i > 0) {
		if (count === limit) return { text: value.slice(i), truncated: true };
		const code = value.charCodeAt(i - 1);
		if (code >= LOW_START && code <= LOW_END) {
			const prev = value.charCodeAt(i - 2);
			i -= prev >= HIGH_START && prev <= HIGH_END ? 2 : 1;
		} else {
			i -= 1;
		}
		count++;
	}
	return { text: value, truncated: false };
}

/**
 * Truncate from the start and append `ellipsis` only when characters were
 * actually dropped.
 *
 * Exists because the length COMPARISON is as bug-prone as the cut: the original
 * `args.message.length > 500 ? slice(0,500) + "…" : args.message` compares code
 * UNITS, so a string of 400 emoji (800 code units) got a spurious ellipsis while
 * still being complete. One helper drives both decisions so they cannot drift.
 */
export function truncateWithEllipsis(
	value: string,
	limit: number,
	ellipsis = "…",
): string {
	const { text, truncated } = truncateCodePoints(value, limit);
	return truncated ? `${text}${ellipsis}` : text;
}
