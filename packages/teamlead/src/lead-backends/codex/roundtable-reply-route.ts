/**
 * FLY-314 Phase 2 — reply-in-thread route resolution (write side).
 *
 * By the time this runs the message has already passed the gateway filters
 * (echo + allowlist + mention-gate), so the only job here is to decide WHERE the
 * Lead's reply goes, and to emit durable route metadata when a thread must be
 * ensured before delivery.
 *
 * ORDERED route table (Codex design review R2#2 — must preserve FLY-267 for OTHER
 * shared channels, not silently send them to chat):
 *   1. roundtable parent  → the topic thread (== msg.id), with a durable replyRoute
 *      so delivery can ensure the thread exists first (the Bridge poller may not
 *      have created it yet).
 *   2. a subscribed topic thread (registry) → reply back into that same thread.
 *   3. any OTHER static cross-dept channel → reply to the source channel (FLY-267).
 *   4. otherwise → undefined (the outbound sender uses the default chat channel).
 *
 * The `replyRoute` is the durable contract (R2#1/R3#1): `replyChannelId ===
 * sourceMessageId` is NOT a reliable signal, so a thread that must be ensured carries
 * an explicit `kind`. Cases 2/3/4 set no `replyRoute` (the thread already exists / no
 * ensure needed).
 */

export interface RoundtableReplyRoute {
	kind: "roundtable_thread_from_message";
	parentChannelId: string;
	sourceMessageId: string;
	/** == sourceMessageId (Discord start-thread-from-message invariant). */
	threadId: string;
}

export interface ReplyRouteResult {
	replyChannelId?: string;
	replyRoute?: RoundtableReplyRoute;
}

export interface RoundtableRouteContext {
	roundtableParentChannelId: string;
	/** Subscribed topic threads (RoundtableThreadRegistry). */
	registry: { has: (channelId: string) => boolean };
	/** Other configured cross-dept/shared channels (FLY-267), EXCLUDING the
	 * roundtable parent (which is handled by case 1). */
	staticCrossDept: { has: (channelId: string) => boolean };
}

/** Resolve where a (already-gate-passed) message's reply should go. */
export function resolveRoundtableReplyRoute(
	msg: { id: string; channelId: string },
	ctx: RoundtableRouteContext,
): ReplyRouteResult {
	// 1. Top-level roundtable message → open/continue its topic thread (== msg.id).
	if (msg.channelId === ctx.roundtableParentChannelId) {
		return {
			replyChannelId: msg.id,
			replyRoute: {
				kind: "roundtable_thread_from_message",
				parentChannelId: ctx.roundtableParentChannelId,
				sourceMessageId: msg.id,
				threadId: msg.id,
			},
		};
	}
	// 2. A message inside a subscribed topic thread → reply back into that thread.
	if (ctx.registry.has(msg.channelId)) {
		return { replyChannelId: msg.channelId };
	}
	// 3. Any OTHER static cross-dept channel → keep FLY-267 source-channel reply.
	if (ctx.staticCrossDept.has(msg.channelId)) {
		return { replyChannelId: msg.channelId };
	}
	// 4. chat/core → default chat channel.
	return {};
}
