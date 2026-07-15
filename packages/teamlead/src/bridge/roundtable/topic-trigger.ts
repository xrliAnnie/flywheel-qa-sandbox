/**
 * FLY-314 — pluggable "is this a topic?" trigger for #leads-roundtable.
 *
 * The trigger SEMANTICS are a deferred PRODUCT decision (the founder picks). This
 * module makes the trigger a config-selected pure predicate so the choice is a
 * zero-code config flip. Default `disabled` → even a running poller opens no thread
 * (the byte-compat / canary state).
 *
 * Echo immunity (skip the poller's own bot) is the MANAGER's job (it has botUserId)
 * — the trigger stays a pure, side-effect-free predicate over the message.
 */

/** Normalized roundtable message (the manager maps raw Discord → this shape). */
export interface RoundtableMessage {
	id: string;
	channelId: string;
	authorId: string;
	authorBot: boolean;
	content: string;
	/** Explicit @-mentioned user ids (Discord `mentions` array). */
	mentions: string[];
	/** Discord `mention_everyone` (true for @everyone / @here). */
	mentionEveryone: boolean;
	/**
	 * FLY-314 fix: the referenced message id when this message is a Discord REPLY
	 * (`message_reference.message_id`). Present → the message is a follow-up in an
	 * ongoing discussion, NOT a fresh topic; the manager's follow-up gate skips it
	 * so a reply never opens a second thread. Undefined for a plain top-level post.
	 */
	referencedMessageId?: string;
}

export type RoundtableTriggerMode =
	| "disabled"
	| "explicit_prefix"
	| "any_lead_mention"
	| "broadcast"
	| "any_top_level";

export interface RoundtableTriggerConfig {
	mode: RoundtableTriggerMode;
	/** `explicit_prefix`: content must start with one of these (after trimStart). */
	prefixes?: string[];
	/** `broadcast`: minimum explicit @-mentions (in addition to @everyone). Default 2. */
	minMentions?: number;
	/** `any_lead_mention`: which user ids count as "a Lead". */
	leadUserIds?: string[];
}

/**
 * Build the topic predicate. Pure: no side effects, no Discord, no clock.
 * A malformed/unknown mode degrades to "never trigger" (safe default).
 */
export function buildTopicTrigger(
	cfg: RoundtableTriggerConfig,
): (msg: RoundtableMessage) => boolean {
	switch (cfg.mode) {
		case "explicit_prefix": {
			const prefixes = (cfg.prefixes ?? []).filter((p) => p.length > 0);
			return (msg) => {
				const c = msg.content.trimStart();
				return prefixes.some((p) => c.startsWith(p));
			};
		}
		case "any_lead_mention": {
			const leads = new Set(cfg.leadUserIds ?? []);
			if (leads.size === 0) return () => false;
			return (msg) => msg.mentions.some((id) => leads.has(id));
		}
		case "broadcast": {
			const min = cfg.minMentions ?? 2;
			return (msg) => msg.mentionEveryone || msg.mentions.length >= min;
		}
		case "any_top_level":
			return () => true;
		default:
			// "disabled" and any unknown mode → never open a thread.
			return () => false;
	}
}
