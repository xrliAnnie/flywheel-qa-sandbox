/**
 * FLY-927 (Task 1.4, T1): fixed-window token bucket for unified-alert-channel
 * ROOT messages — the "20/min, overflow batches" cap. Pure logic (caller
 * injects `nowMs`); state is in-process only (a Bridge restart resets the
 * window — the queue is the persistence layer, so an alert can at worst be
 * sent sooner, never lost).
 *
 * Counting scope (the caller's contract): only root messages POSTed to the
 * unified alert channel consume tokens. Hub thread narration, issue-thread
 * routing, and meta-alerts never do.
 */

export interface AlertRateLimiter {
	/** Allowed → consume one token and return true; refused → caller queues. */
	tryAcquire(nowMs: number): boolean;
	/** Record an overflowed (queued) alert's kind for the next summary line. */
	noteOverflow(kind: string): void;
	/**
	 * The pending overflow counts (kind → count), or null when none. Does NOT
	 * clear — the caller clears ONLY after the aggregate summary actually posts,
	 * so a transiently-failed summary is retried next drain round (at-least-once,
	 * and never a summary-of-summaries recursion: the summary itself is a plain
	 * message, not an overflow-noted alert).
	 */
	peekOverflow(): Map<string, number> | null;
	clearOverflow(): void;
}

export function createAlertRateLimiter(perMinute: number): AlertRateLimiter {
	let windowStart = -1;
	let tokens = 0;
	const overflow = new Map<string, number>();
	return {
		tryAcquire(nowMs: number): boolean {
			const window = Math.floor(nowMs / 60_000);
			if (window !== windowStart) {
				windowStart = window;
				tokens = perMinute;
			}
			if (tokens <= 0) return false;
			tokens--;
			return true;
		},
		noteOverflow(kind: string): void {
			overflow.set(kind, (overflow.get(kind) ?? 0) + 1);
		},
		peekOverflow(): Map<string, number> | null {
			return overflow.size > 0 ? new Map(overflow) : null;
		},
		clearOverflow(): void {
			overflow.clear();
		},
	};
}

/**
 * The aggregate overflow summary line. Deliberately starts with 🎫 (echo-strippable
 * by `ALERT_ECHO_START`) and carries NO `(<leadId> / <kind>)` anchor, so an echo of
 * this line can never re-classify as an alert (FLY-220 family).
 */
export function formatOverflowSummary(overflow: Map<string, number>): string {
	const total = [...overflow.values()].reduce((a, b) => a + b, 0);
	const parts = [...overflow.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([kind, n]) => `${kind}×${n}`)
		.join("、");
	return `🎫 速率攒批:${total} 条告警已入队(${parts}),将随队列陆续投递。`;
}

/** Parse FLYWHEEL_ALERT_RATE_PER_MIN — unset/invalid/≤0 ⇒ null = no limiting. */
export function rateLimitPerMinuteFromEnv(
	env: NodeJS.ProcessEnv,
): number | null {
	const raw = env.FLYWHEEL_ALERT_RATE_PER_MIN;
	if (!raw) return null;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}
