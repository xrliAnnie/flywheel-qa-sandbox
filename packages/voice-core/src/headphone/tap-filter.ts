/**
 * Tap filter — pure predicate deciding whether a Discord gateway message
 * belongs in the headphone FIFO queue (FLY-546 B1-1, plan truth table ①-⑦).
 *
 * The bot-id sets and channel scope come from the Bridge scope contract
 * (`GET /api/voice/scope`) — the daemon never guesses them ad hoc.
 */

export type TapMessage = {
	authorId: string;
	authorIsBot: boolean;
	channelId: string;
	/** true when the message真 @-mentions the canonical founder id. */
	mentionsFounder: boolean;
	/** true when the daemon already resolved this message id to a current ship-gate binding. */
	hasGateBinding: boolean;
};

export type TapConfig = {
	/** per-Lead bot user ids (from leads[].botTokenEnv resolution, Bridge-side). */
	leadBotIds: ReadonlySet<string>;
	/** founder-facing system identities (e.g. gate-poller's global fallback bot). */
	systemBotIds: ReadonlySet<string>;
	/** founder-facing channels: lead chatChannels + issue chat threads + generalChannel. */
	scopeChannelIds: ReadonlySet<string>;
	roundtableChannelIds: ReadonlySet<string>;
	includeRoundtable: boolean;
	/** the headphone daemon's own bot — ALWAYS excluded (echo immunity, FLY-220). */
	selfBotId: string;
	founderId: string;
};

export function shouldEnqueue(msg: TapMessage, cfg: TapConfig): boolean {
	// ⑤ echo immunity: our own relays/receipts must never re-enter the queue.
	if (msg.authorId === cfg.selfBotId) return false;
	// ② the founder's own messages are commands/replies, not queue items.
	if (msg.authorId === cfg.founderId) return false;

	const isLeadBot = cfg.leadBotIds.has(msg.authorId);
	const isSystemBot = cfg.systemBotIds.has(msg.authorId);
	const recognized = isLeadBot || isSystemBot;

	// ④ a direct @ to the founder from a recognized bot is "for her" by
	// definition — it wins over every channel-scope rule (fallback net).
	if (recognized && msg.mentionsFounder) return true;

	// ③ roundtable is Lead-to-Lead noise unless explicitly opted in.
	if (cfg.roundtableChannelIds.has(msg.channelId)) {
		return cfg.includeRoundtable && recognized;
	}

	if (cfg.scopeChannelIds.has(msg.channelId)) {
		// ①/⑥ recognized identities in founder-facing channels.
		if (recognized) return true;
		// ⑦ an unrecognized BOT whose message is the current ship-gate binding:
		// classify by the persisted binding, never by author guessing.
		return msg.authorIsBot && msg.hasGateBinding;
	}

	// ② everything else (out-of-scope channels, bystanders) stays out.
	return false;
}
