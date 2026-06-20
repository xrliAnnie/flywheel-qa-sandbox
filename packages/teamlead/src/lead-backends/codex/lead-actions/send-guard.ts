/**
 * FLY-350 — lead-actions proactive-send loop-safety (pure).
 *
 * A model-initiated `discord_send` bypasses the normal LeadInputRouter, so the
 * MCP child must carry its OWN guards against the FLY-220 self-amplifying
 * bot↔bot echo loop (a Lead posting → a sibling mention-gate firing → a reply →
 * the Lead posting again). Two pure mechanisms, both injectable-clock for tests:
 *
 *   1. SlidingWindowRateLimiter — at most N sends per channel per window. Over
 *      the cap → the send is REFUSED (fail-soft; the tool returns an error, it
 *      does not throw the process).
 *   2. Idempotency — a deterministic key over (channelId, text); a repeat within
 *      the TTL is a no-op (returns the prior message id) so a same-turn retry or
 *      an echoed-identical message cannot double-post.
 *
 * Durable audit is a separate concern (assembly glue); these guards are the
 * in-process loop-safety net and are exhaustively unit-tested.
 */

import { createHash } from "node:crypto";

/** Deterministic idempotency key for a proactive send. Stable across calls so a
 * retry of the same (channel, text) collapses to one post. */
export function deriveSendIdempotencyKey(
	channelId: string,
	text: string,
): string {
	return createHash("sha256")
		.update(channelId)
		.update("\0")
		.update(text)
		.digest("hex");
}

export interface RateLimitOptions {
	/** Max sends allowed per channel within the window. */
	maxPerWindow: number;
	/** Sliding window length in ms. */
	windowMs: number;
}

/**
 * Per-channel sliding-window rate limiter. `tryAcquire` records the send and
 * returns true when allowed; false when the channel is over the cap for the
 * current window. Pure aside from internal state; pass `nowMs` so tests control
 * the clock.
 */
export class SlidingWindowRateLimiter {
	private readonly maxPerWindow: number;
	private readonly windowMs: number;
	private readonly hits = new Map<string, number[]>();

	constructor(opts: RateLimitOptions) {
		if (!(opts.maxPerWindow > 0)) {
			throw new Error("SlidingWindowRateLimiter: maxPerWindow must be > 0");
		}
		if (!(opts.windowMs > 0)) {
			throw new Error("SlidingWindowRateLimiter: windowMs must be > 0");
		}
		this.maxPerWindow = opts.maxPerWindow;
		this.windowMs = opts.windowMs;
	}

	/** Prune timestamps older than the window for a channel. */
	private prune(channelId: string, nowMs: number): number[] {
		const cutoff = nowMs - this.windowMs;
		const kept = (this.hits.get(channelId) ?? []).filter((t) => t > cutoff);
		this.hits.set(channelId, kept);
		return kept;
	}

	/** True if a send to `channelId` is allowed at `nowMs` (and records it).
	 * False if the channel is at the cap — the caller refuses the send. */
	tryAcquire(channelId: string, nowMs: number): boolean {
		const kept = this.prune(channelId, nowMs);
		if (kept.length >= this.maxPerWindow) return false;
		kept.push(nowMs);
		this.hits.set(channelId, kept);
		return true;
	}
}

export interface IdempotencyEntry {
	messageId: string;
	atMs: number;
}

/**
 * In-process idempotency cache for proactive sends. A repeated key within the
 * TTL returns the prior result (so the actual Discord call is skipped). Pass
 * `nowMs` so tests control expiry.
 */
export class SendIdempotencyCache {
	private readonly ttlMs: number;
	private readonly entries = new Map<string, IdempotencyEntry>();

	constructor(ttlMs: number) {
		if (!(ttlMs > 0)) {
			throw new Error("SendIdempotencyCache: ttlMs must be > 0");
		}
		this.ttlMs = ttlMs;
	}

	/** Return the prior message id if this key was recorded within the TTL. */
	get(key: string, nowMs: number): string | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (nowMs - entry.atMs > this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.messageId;
	}

	/** Record a successful send. */
	record(key: string, messageId: string, nowMs: number): void {
		this.entries.set(key, { messageId, atMs: nowMs });
	}
}
