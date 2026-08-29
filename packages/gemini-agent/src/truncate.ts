/**
 * FLY-1018 tool-result budget (plan §2.5, design principle 7).
 *
 * No compaction machinery — a single per-result cap: keep the head,
 * replace the tail with an explicit "[truncated N chars]" marker so the
 * model always knows content was dropped.
 */

export interface TruncateResult {
	body: string;
	truncated: boolean;
}

export function truncateResult(body: string, capChars: number): TruncateResult {
	if (body.length <= capChars) {
		return { body, truncated: false };
	}
	const dropped = body.length - capChars;
	return {
		body: `${body.slice(0, capChars)}\n...[truncated ${dropped} chars]`,
		truncated: true,
	};
}
