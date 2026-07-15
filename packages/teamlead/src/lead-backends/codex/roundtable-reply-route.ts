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

import {
	deriveRoundtableThreadName,
	isTopicNoise,
} from "../../bridge/roundtable/roundtable-text.js";

export interface RoundtableReplyRoute {
	kind: "roundtable_thread_from_message";
	parentChannelId: string;
	sourceMessageId: string;
	/** == sourceMessageId (Discord start-thread-from-message invariant). */
	threadId: string;
	/**
	 * FLY-314 fix: descriptive name to give the thread ON CREATE (correct-from-start),
	 * so the Codex-lead path never leaves the generic "Roundtable topic" placeholder.
	 * Derived from the topic message content.
	 */
	threadName?: string;
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
	msg: {
		id: string;
		channelId: string;
		/** FLY-314 fix: topic text → correct-from-start thread name for fresh topics. */
		content?: string;
		/** FLY-314 fix: set on a Discord REPLY → the message this one replies to. */
		referencedMessageId?: string;
	},
	ctx: RoundtableRouteContext,
): ReplyRouteResult {
	// 1. Top-level roundtable message.
	if (msg.channelId === ctx.roundtableParentChannelId) {
		// 1a. FLY-314 fix (Option B) — a Discord REPLY is a follow-up, NOT a fresh
		// topic: it must NEVER open a second thread. There is no async-confirm seam on
		// the Codex durable route (the replyChannelId is persisted at accept time), so:
		//   - if the referenced topic thread is already KNOWN (subscribed) → route the
		//     reply INTO it synchronously (registry is this process's source of truth;
		//     thread.id == source message id). NO replyRoute → no create, no budget seed,
		//     no subscribe. The reply lands in the thread, not the parent → the Bridge
		//     poller never sees it and cannot re-thread it.
		//   - if the referenced thread is UNKNOWN → fall back to the parent (accepted
		//     narrow residual; full closure = Option A, deferred). Still NO replyRoute.
		if (msg.referencedMessageId) {
			return {
				replyChannelId: ctx.registry.has(msg.referencedMessageId)
					? msg.referencedMessageId
					: msg.channelId,
			};
		}
		// 1a'. Noise gate (Codex code review R1 HIGH) — a top-level message that passes
		// the mention gate but is pure emoji / a short ack ("ok <@bot>", "👍 <@bot>") is
		// not a topic; do NOT open a thread for it. Reply in the parent, no replyRoute.
		// Same invariant as the Bridge poller + plugin: noise opens no thread in ANY
		// of the 3 creators. (The gateway already drops EMPTY content upstream.)
		if (isTopicNoise(msg.content ?? "")) {
			return { replyChannelId: msg.channelId };
		}
		// 1b. Fresh topic → open/continue its topic thread (== msg.id) with a durable
		// replyRoute so delivery can ensure the thread exists first, carrying a
		// correct-from-start descriptive name.
		return {
			replyChannelId: msg.id,
			replyRoute: {
				kind: "roundtable_thread_from_message",
				parentChannelId: ctx.roundtableParentChannelId,
				sourceMessageId: msg.id,
				threadId: msg.id,
				threadName: deriveRoundtableThreadName(msg.content ?? ""),
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
