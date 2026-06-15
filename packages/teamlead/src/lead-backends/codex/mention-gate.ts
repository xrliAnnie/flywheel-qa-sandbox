/**
 * FLY-267 判 — mention-gating for a Codex Lead's SHARED channels (e.g. the
 * cross-department `#leads-roundtable`). The Codex gateway processes every non-echo,
 * non-empty message in its allowlisted channels; that is correct for the Lead's OWN
 * chat/core channels (each message there is for it) but would SPAM a shared channel.
 *
 * `buildMentionGate` returns a `shouldHandle(msg)` predicate (the gateway's optional
 * extra-policy hook): messages in a SHARED channel are handled only when they point
 * at THIS Lead; messages in any other (chat/core) channel are always handled, so the
 * existing behavior is byte-compatible.
 *
 * Mention detection (mirrors the Claude plugin's `isMentioned`, EXPLICIT mentions
 * only — reply-to-bot implicit mention is out of scope for FLY-267):
 *   ① the Discord `mentions` array contains this bot's id (authoritative), OR
 *   ② the content carries an exact mention token `<@id>` / `<@!id>` (fallback when
 *      the mentions array isn't populated), OR
 *   ③ a configured name regex matches — but ONLY for NON-BOT authors. A sibling
 *      Lead (a bot) must use an exact mention id; its prose merely containing the
 *      Lead's name must not trigger a reply (FLY-220 bot-to-bot loop hardening).
 */

import type { DiscordInboundMessage } from "./CodexDiscordGateway.js";

export interface MentionGateOptions {
	/** This Lead's own Discord bot user id. */
	botUserId: string;
	/** Channels treated as SHARED (mention-gated). Non-shared channels bypass gating. */
	sharedChannelIds: Iterable<string>;
	/** Optional name-mention regexes (e.g. `\bMufasa\b`); applied to non-bot authors. */
	mentionPatterns?: string[];
}

/** Compile name-mention patterns case-insensitively. A malformed pattern is skipped
 * (logged-free) rather than throwing — a bad config must never crash inbound. */
export function compileMentionPatterns(patterns?: string[]): RegExp[] {
	const out: RegExp[] = [];
	for (const p of patterns ?? []) {
		try {
			out.push(new RegExp(p, "i"));
		} catch {
			// skip invalid regex (never throw on a config typo)
		}
	}
	return out;
}

/** Whether `msg` explicitly points at the Lead identified by `botUserId`.
 * `compiled` are the pre-compiled name regexes (use `compileMentionPatterns`). */
export function isMentioned(
	msg: DiscordInboundMessage,
	botUserId: string,
	compiled: RegExp[],
): boolean {
	// ① authoritative Discord mentions array.
	if (msg.mentions?.includes(botUserId)) return true;
	// ② exact mention token in content (covers <@id> and the legacy nickname <@!id>).
	const content = msg.content;
	if (
		content.includes(`<@${botUserId}>`) ||
		content.includes(`<@!${botUserId}>`)
	) {
		return true;
	}
	// ③ name regex — NON-BOT authors only (a sibling bot must use an exact id).
	if (!msg.authorBot) {
		for (const re of compiled) {
			if (re.test(content)) return true;
		}
	}
	return false;
}

/** Build the gateway `shouldHandle` predicate: gate only SHARED channels on mention;
 * any other channel is always handled (byte-compat with the chat/core path). */
export function buildMentionGate(
	opts: MentionGateOptions,
): (msg: DiscordInboundMessage) => boolean {
	const shared = new Set(opts.sharedChannelIds);
	const compiled = compileMentionPatterns(opts.mentionPatterns);
	return (msg) => {
		if (!shared.has(msg.channelId)) return true; // chat/core: unchanged
		return isMentioned(msg, opts.botUserId, compiled);
	};
}
