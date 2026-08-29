/**
 * FLY-314 — shared roundtable text helpers (PURE, no I/O).
 *
 * Two concerns, ONE canonical implementation so the Bridge poller (creator 1),
 * the Codex-lead reply-in-thread path (creator 2), and — mirrored — the Claude
 * plugin (creator 3) all name topic threads and classify noise identically
 * (avoids the semantics drift risk called out in the FLY-314 fix plan §6 risk 3).
 *
 *  - `deriveRoundtableThreadName`: a descriptive thread name from the topic
 *    message content, stripping Discord markup so the sidebar reads as the topic
 *    (not raw `<@id>` noise). Falls back to the placeholder ONLY when there is no
 *    usable text (mentions-only / whitespace).
 *  - `isTopicNoise`: is this message too thin to warrant its own topic thread?
 *    Strips Discord markup AND Unicode pictographs (Codex R1 MEDIUM#4: a length
 *    rule alone misses `👍👍`), then requires a minimum of semantic (letter/number)
 *    characters. Used as a mode-independent pre-gate so pure-emoji / one-word
 *    acknowledgements never open a thread regardless of the trigger mode.
 */

/** The generic name the Belle plugin hard-codes and the placeholder fallback. */
export const ROUNDTABLE_PLACEHOLDER_NAME = "Roundtable topic";

/**
 * FLY-802: roundtable topic threads auto-archive after 1h of inactivity —
 * Discord's shortest `auto_archive_duration` (valid enum: 60/1440/4320/10080
 * minutes). 1h so a finished topic collapses out of the sidebar (archived, NOT
 * deleted — messages stay + search finds them + a new message unarchives it)
 * instead of piling up. Shared by BOTH create paths (the Bridge poller +
 * `ensureThreadFromMessage`) so the value can't drift between them — the same
 * one-canonical-value discipline the placeholder name above already follows.
 * Deliberately distinct from issue chat threads (3 days, FLY-292) and alert
 * threads (1 day) — this constant is roundtable-topic-only.
 */
export const ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES = 60;

/** Minimum semantic (letter/number) characters for a message to be a real topic. */
export const MIN_TOPIC_CHARS = 3;

/** Strip Discord custom-emoji / user / role / channel markup + collapse whitespace. */
function stripDiscordMarkup(content: string): string {
	return content
		.replace(/<a?:\w+:\d+>/g, "") // custom emoji <:x:1> / <a:x:1>
		.replace(/<@[!&]?\d+>/g, "") // user <@1>/<@!1> + role <@&1> mentions
		.replace(/<#\d+>/g, "") // channel mentions <#1>
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * A descriptive thread name from the topic content. Mirrors the Bridge poller's
 * original inline cleaner. Falls back to the placeholder when there is no usable
 * text. Capped to Discord's 100-char thread-name limit.
 */
export function deriveRoundtableThreadName(content: string): string {
	const cleaned = stripDiscordMarkup(content).slice(0, 90);
	return (cleaned || ROUNDTABLE_PLACEHOLDER_NAME).slice(0, 100);
}

/**
 * Is `content` too thin to open its own topic thread? Strips Discord markup and
 * Unicode pictographs, then requires >= `minChars` semantic (letter/number)
 * characters. Empty / whitespace / emoji-only / 1-2 char acks → noise.
 */
export function isTopicNoise(
	content: string,
	minChars: number = MIN_TOPIC_CHARS,
): boolean {
	const stripped = stripDiscordMarkup(content).replace(
		/\p{Extended_Pictographic}/gu,
		"",
	);
	const semantic = (stripped.match(/[\p{L}\p{N}]/gu) ?? []).length;
	return semantic < minChars;
}
