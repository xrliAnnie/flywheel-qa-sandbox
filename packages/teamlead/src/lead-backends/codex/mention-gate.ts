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
import {
	DEFAULT_ROUNDTABLE_THREAD_BUDGET,
	decideTopicThreadContinuation,
	seedThreadBudget,
	type ThreadBudgetStore,
} from "./roundtable-thread-budget.js";

export interface MentionGateOptions {
	/** This Lead's own Discord bot user id. */
	botUserId: string;
	/** Channels treated as SHARED (mention-gated). Non-shared channels bypass gating. */
	sharedChannelIds: Iterable<string>;
	/** FLY-898: core-room channels gated with the STRICTER id-only rule — a message
	 * is handled ONLY on a real `<@id>` mention or an explicit reply to THIS bot's
	 * own message; a bare NAME in the text is NOT enough (the name regex ③ is
	 * skipped for these). This makes non-CoS leads silent on no-@ core messages
	 * (only the CoS answers those) without the FLY-152 bare-name pile-on. A core
	 * channel is NEVER also in `sharedChannelIds`. Empty (default) → no core gating
	 * (byte-compat). */
	coreStrictChannelIds?: Iterable<string>;
	/** Optional name-mention regexes (e.g. `\bMufasa\b`); applied to non-bot authors. */
	mentionPatterns?: string[];
	/** FLY-314 Phase 2: dynamically-subscribed roundtable topic threads. By default they
	 * are ALSO shared/mention-gated (FLY-220 safety). With `autoContinue` ON (Part(b))
	 * they instead relax the @-requirement under the bounded anti-loop budget. Empty when
	 * off. Membership is implicit — a thread is in this registry only because THIS Lead
	 * participates in it. */
	dynamicSharedChannels?: { has: (channelId: string) => boolean };
	/** FLY-314 Part(b): enable no-@ continuation inside registered topic threads, bounded
	 * by `budgetStore`. Default false → topic threads stay mention-required (byte-compat).
	 * The kill-switch is the absence of this flag. */
	autoContinue?: boolean;
	/** Per-thread bot-only budget store (required when `autoContinue` is true). */
	budgetStore?: ThreadBudgetStore;
	/** Per-thread bot-only continuation budget (conservative default 2). */
	budgetN?: number;
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

/** ①② only: whether `msg` carries an EXACT mention TOKEN for `botUserId` — the
 * authoritative Discord `mentions` array, or a `<@id>` / `<@!id>` token in the
 * content. No name regex, no reply-to-self. Shared by `isMentioned` (byte-compat)
 * and `isIdMentioned`. */
function hasExactMentionToken(
	msg: DiscordInboundMessage,
	botUserId: string,
): boolean {
	// ① authoritative Discord mentions array.
	if (msg.mentions?.includes(botUserId)) return true;
	// ② exact mention token in content (covers <@id> and the legacy nickname <@!id>).
	const content = msg.content;
	return (
		content.includes(`<@${botUserId}>`) || content.includes(`<@!${botUserId}>`)
	);
}

/** Whether `msg` explicitly points at the Lead identified by `botUserId`.
 * `compiled` are the pre-compiled name regexes (use `compileMentionPatterns`). */
export function isMentioned(
	msg: DiscordInboundMessage,
	botUserId: string,
	compiled: RegExp[],
): boolean {
	// ①② exact mention token.
	if (hasExactMentionToken(msg, botUserId)) return true;
	// ③ name regex — NON-BOT authors only (a sibling bot must use an exact id).
	if (!msg.authorBot) {
		for (const re of compiled) {
			if (re.test(msg.content)) return true;
		}
	}
	return false;
}

/** FLY-898 id-only address test for a CORE room: TRUE only on ①② an exact `<@id>`
 * mention OR ③ an explicit reply to THIS bot's own message (`referencedAuthorId`
 * === botUserId). The bare-name regex path is DELIBERATELY absent — "刚 Peter 帮我"
 * must not address Peter. Author-bot vs human is irrelevant here (an exact id / a
 * reply-to-self is unambiguous either way). Missing `referencedAuthorId` → the
 * reply-to-self branch simply does not fire (strict, safe). */
export function isIdMentioned(
	msg: DiscordInboundMessage,
	botUserId: string,
): boolean {
	if (hasExactMentionToken(msg, botUserId)) return true;
	return (
		msg.referencedAuthorId !== undefined && msg.referencedAuthorId === botUserId
	);
}

/** Build the gateway `shouldHandle` predicate: gate only SHARED channels on mention;
 * any other channel is always handled (byte-compat with the chat/core path). */
export function buildMentionGate(
	opts: MentionGateOptions,
): (msg: DiscordInboundMessage) => boolean {
	const shared = new Set(opts.sharedChannelIds);
	// FLY-898: core-room channels use the stricter id-only rule (empty by default).
	const coreStrict = new Set(opts.coreStrictChannelIds);
	const dynamicShared = opts.dynamicSharedChannels;
	const compiled = compileMentionPatterns(opts.mentionPatterns);
	const autoContinue = opts.autoContinue === true && !!opts.budgetStore;
	const budgetN =
		opts.budgetN && opts.budgetN > 0
			? opts.budgetN
			: DEFAULT_ROUNDTABLE_THREAD_BUDGET;
	return (msg) => {
		// FLY-898: a core-room message is handled ONLY when it addresses THIS bot by
		// a real @ / reply-to-self (id-only). Checked FIRST — a core channel is a
		// base channel (never in `shared`), so without this it would fall through to
		// the `!isShared → true` always-handled path. Empty coreStrict → skipped.
		if (coreStrict.has(msg.channelId)) {
			return isIdMentioned(msg, opts.botUserId);
		}
		const isDynamicThread = dynamicShared?.has(msg.channelId) === true;
		const isShared = shared.has(msg.channelId) || isDynamicThread;
		if (!isShared) return true; // chat/core: unchanged
		if (isDynamicThread) {
			// FLY-576: a NON-BOT human (founder/operator) in a registered topic thread —
			// membership is implicit (the thread is in the registry only because THIS Lead
			// joined it) — is handled WITHOUT an @ by DEFAULT. The human message also resets
			// the bot budget (a genuine reset event), so any subsequent bot continuation (when
			// autoContinue is on) starts fresh. A human cannot form a bot-to-bot loop →
			// structurally melee-immune.
			if (!msg.authorBot) {
				if (opts.budgetStore) {
					seedThreadBudget(opts.budgetStore, msg.channelId, budgetN);
				}
				return true;
			}
			// FLY-314 Part(b): a BOT-authored trigger relaxes the @-requirement only under the
			// bounded anti-loop budget (autoContinue). ALL bot triggers — incl exact <@id> /
			// quote-reply — flow through the budget and cannot bypass it (R1#1). With
			// autoContinue OFF (production default) a bot stays mention-required → no melee.
			if (autoContinue && opts.budgetStore) {
				return decideTopicThreadContinuation(
					{ threadId: msg.channelId, authorBot: msg.authorBot },
					opts.budgetStore,
					{ budgetN },
				);
			}
			return isMentioned(msg, opts.botUserId, compiled);
		}
		// The static shared PARENT channel is NOT relaxed (topics are still initiated by an
		// explicit @ / name) — unchanged.
		return isMentioned(msg, opts.botUserId, compiled);
	};
}
