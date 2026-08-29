/**
 * Headphone-mode passphrases + disposition vocabulary (FLY-546 B1-1).
 *
 * Matching is EXACT over a normalized form — never substring, never NLP
 * (PRD §13: passphrases are precise phrases; a sentence that merely
 * mentions one must not trigger). The word sets are plain arrays so a
 * daemon config can override them — configurable ≠ fuzzy: whatever the
 * set contains is still matched exactly.
 */

/** Enter headphone mode. */
export const OPEN_WORD: readonly string[] = ["芝麻开门", "/headphone on"];
/** Optional spoken exit (main exit = leaving the VC, Annie ruling ④). */
export const STOP_WORD: readonly string[] = ["芝麻关门"];
/** Finish the current item without replying. */
export const SKIP: readonly string[] = ["不用", "跳过", "skip", "下一条"];
/** Dictate a reply to be relayed. */
export const REPLY: readonly string[] = ["要回", "回复"];
/** Affirmative (readback confirm / exit confirm / hear-full-text). */
export const CONFIRM: readonly string[] = ["确认", "对"];
/** Negative (readback reject / approval decline). */
export const DENY: readonly string[] = ["不对", "取消", "不批"];
/** §14 c-tier approval intent on a ship-gate item (leads to explicit readback). */
export const APPROVE_INTENT: readonly string[] = [
	"ship 吧",
	"批准",
	"可以 ship",
	"发布吧",
];
/** Put the current item back and go idle without exiting the mode. */
export const PAUSE: readonly string[] = ["暂停", "待会", "先停一下"];

/**
 * NFKC + lowercase + strip leading/trailing punctuation/whitespace +
 * collapse internal whitespace. Applied to BOTH sides, so "/headphone on"
 * (leading slash stripped on both) still matches its own constant.
 */
export function normalizePhrase(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
		.replace(/\s+/gu, " ");
}

export function matchPhrase(
	utterance: string,
	phrases: readonly string[],
): boolean {
	const norm = normalizePhrase(utterance);
	if (norm.length === 0) return false;
	return phrases.some((p) => normalizePhrase(p) === norm);
}
