/**
 * FLY-314 Phase 2 — RoundtableThreadRegistry: the single mutable source of truth
 * for "which roundtable topic threads is this Lead currently participating in".
 *
 * Codex design review R1 caught the core failure mode: a Lead must poll the thread
 * channel (RestPoll), accept its messages (CodexDiscordGateway allowlist), gate
 * bot-to-bot replies in it (mention-gate shared-channel set), AND route replies
 * back into it (resolveReplyChannelId). If each of those kept its own static set,
 * a dynamically-subscribed thread would be dropped by one of them. So ALL FOUR
 * consult THIS registry.
 *
 * Insertion-ordered (a JS Set preserves insertion order) so a subscription cap can
 * evict the OLDEST active thread. Membership here = "actively subscribed"; the
 * durable per-channel cursor lives in the cursor store, NOT here (R1#10: a cap
 * eviction drops the active polling slot but keeps the cursor for resume).
 *
 * When the reply-in-thread feature is OFF the registry simply stays empty and the
 * four consumers fall back to their existing static behavior (byte-compat).
 */
export class RoundtableThreadRegistry {
	private readonly threads = new Set<string>();

	/** Subscribe a thread. Returns true if it was newly added. */
	add(threadId: string): boolean {
		if (!threadId || this.threads.has(threadId)) return false;
		this.threads.add(threadId);
		return true;
	}

	/** Unsubscribe a thread. Returns true if it was present. */
	remove(threadId: string): boolean {
		return this.threads.delete(threadId);
	}

	has(threadId: string): boolean {
		return this.threads.has(threadId);
	}

	get size(): number {
		return this.threads.size;
	}

	/** Snapshot of subscribed thread ids, oldest-first. */
	list(): string[] {
		return [...this.threads];
	}

	/** The oldest-subscribed thread id (for cap eviction), or undefined if empty. */
	oldest(): string | undefined {
		for (const id of this.threads) return id;
		return undefined;
	}
}
