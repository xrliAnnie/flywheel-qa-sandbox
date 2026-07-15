/**
 * confirm-heuristics — the shared yes/no read for the huddle's two
 * confirmation surfaces (FLY-545 QA kickback R1 + Codex R8/R9 hardening).
 *
 * History of the leak class this module closes:
 *  - R1 (QA): AFFIRM anchored to the start → 「对,不过第二条改成下周三」 read as
 *    unconditional consent (wrong artifact landed / b-tier executed).
 *  - R8 (Codex): a correction-MARKER blacklist can't close the class —
 *    「对,漏一条 action」 carries no marker word.
 *  - R9 (Codex): residue-by-global-deletion destroys syntax — 「可以是可以」
 *    (concessive, implies 但是…) and 「是吧」 (modal doubt) reduced to empty.
 *
 * Final strategy — structure-preserving segment judgment:
 *  1. the utterance must OPEN with a yes token (AFFIRM_RE);
 *  2. split on punctuation/whitespace separators only — modal particles
 *     (吧/嘛/呀/啊/哦/呢…) are NOT strippable filler, they fail closed;
 *  3. every segment must be, in whole, a sequence of agreement tokens;
 *  4. the concessive frame 「X是X」 (可以是可以/行是行/好是好) is explicitly
 *     refused even though it is built entirely of agreement tokens.
 *
 * Fail-closed by design: mis-reading a correction as consent costs a wrong
 * artifact or an unwanted action; mis-reading an exotic clean yes as
 * qualified only costs a re-ask.
 */

/** leading yes tokens (natural responses to 「…对吗?」). */
export const AFFIRM_RE =
	/^(对|是|确认|批准|同意|可以|好的|好|行|没问题|没错|嗯对|嗯|就这样|yes|yep|ok|okay|sure|confirm)/i;

/** hard no / hold-off openers. */
export const DENY_RE = /^(不|别|等等|先不|取消|不对|不要|no|nope|cancel|wait)/i;

/** punctuation/whitespace separators — the ONLY strippable characters. */
const SEPARATOR_RE = /[\s,,。.!!、~~::;;··…\-—]+/;

/** a whole segment that is nothing but agreement tokens (longest-first so
 * 好的 wins over 好, 嗯对 over 嗯, 是的 over 是). */
const AGREEMENT_SEGMENT_RE =
	/^(?:没问题|没毛病|没错|就这么办|就这样办|就这样|嗯对|嗯嗯|好的|对的|可以|确认|批准|同意|是的|是这样|okay|yes|yep|sure|confirm|ok|对|是|好|行|嗯)+$/i;

/** 「X是X」 concessive frame — grammatically pure agreement tokens, but the
 * idiom concedes and implies a coming 但是 (Codex R9: 可以是可以/行是行). X is
 * unbounded (Codex R11: a 4-char cap missed 确认没问题是确认没问题); utterances
 * here are short, so backtracking cost is negligible. */
const CONCESSIVE_RE = /(.+)是\1/;

/**
 * True only for a clean, unqualified yes: opens with a yes token, every
 * segment is wholly agreement vocabulary, and no concessive frame.
 * 「对,没问题」 lands; 「对,不过…」/「对,漏一条 action」/「是吧」/「可以是可以」
 * do not.
 */
export function isUnconditionalAffirm(text: string): boolean {
	const t = text.trim();
	if (!AFFIRM_RE.test(t)) return false;
	const segments = t.split(SEPARATOR_RE).filter(Boolean);
	if (segments.length === 0) return false;
	// concessive guard runs on the separator-normalized join (Codex R10:
	// 「可以是,可以」/「行 是行」 hid the X是X frame behind a separator).
	if (CONCESSIVE_RE.test(segments.join(""))) return false;
	return segments.every((seg) => AGREEMENT_SEGMENT_RE.test(seg));
}

/** True when a leading yes carries ANY content beyond clean agreement — a
 * correction/qualification/concession, so explicitly not consent. */
export function isQualifiedAffirm(text: string): boolean {
	const t = text.trim();
	return AFFIRM_RE.test(t) && !isUnconditionalAffirm(t);
}
