/**
 * FLY-1329 (A2): activity evidence for an `absent` liveness downgrade.
 *
 * When `handoff()` parks a phase on `absent` (A1), an operator reading the alert
 * needs to know which of two very different things probably happened:
 *
 *   - the runner is ALIVE and our CommDB `tmux_window` mapping went stale (the
 *     FLY-1319 shape) — the park saved a working session; or
 *   - the runner really is gone and left no dead-pin (e.g. tmux server loss) —
 *     the park left a corpse for the existing reconcile paths to collect.
 *
 * Recent activity distinguishes them. But it is EVIDENCE FOR A HUMAN, never an
 * input to the verdict — `decideDestructive` deliberately does not take it. A
 * verdict that swung on "was there traffic in the last 10 minutes" would be
 * unreproducible, and would re-introduce exactly the class of bug FLY-1319 was:
 * destroying a live session because a weak signal looked like death. The window
 * below only changes wording.
 */

// FLY-2101: founder 2026-08-27 v4 fixed the former runtime flag at 10 minutes.
const ACTIVITY_WINDOW_MS = 600_000;

export function activityWindowMs(): number {
	return ACTIVITY_WINDOW_MS;
}

export interface ActivityEvidence {
	/** StateStore `sessions.heartbeat_at`, epoch ms; null when unknown. */
	heartbeatAtMs: number | null;
	/** Newest CommDB message from this exec, epoch ms; null when unknown/none. */
	lastMessageAtMs: number | null;
	/**
	 * FLY-1329 (A2, Codex R1 LOW-5): a within-window "recent CommDB message"
	 * boolean, for callers that can only cheaply probe `hasRecentMessagesFrom`
	 * rather than read a precise timestamp. When true, the runner had traffic
	 * inside the window even if its heartbeat is stale — which is exactly the
	 * FLY-1319 shape (a live parked runner still sending `ask`s while its window
	 * mapping went stale). Without this, that runner is mislabelled likely-dead.
	 */
	hasRecentMessageInWindow?: boolean;
}

export interface ActivityVerdictText {
	/** `likely-alive` | `likely-dead` | `unknown` — for the alert body only. */
	assessment: "likely-alive" | "likely-dead" | "unknown";
	/** Prose for the alert body, naming the evidence that produced it. */
	detail: string;
}

function ago(nowMs: number, thenMs: number): string {
	const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
	if (s < 90) return `${s}s ago`;
	return `${Math.round(s / 60)}m ago`;
}

/**
 * Summarize activity evidence into alert wording. Pure.
 *
 * `unknown` when we have no timestamps at all — say so plainly rather than
 * implying a reading we do not have.
 */
export function describeActivityEvidence(
	evidence: ActivityEvidence,
	nowMs: number,
	windowMs: number = activityWindowMs(),
): ActivityVerdictText {
	const recentMessage = evidence.hasRecentMessageInWindow === true;
	const stamps = [evidence.heartbeatAtMs, evidence.lastMessageAtMs].filter(
		(t): t is number => typeof t === "number" && Number.isFinite(t),
	);
	if (stamps.length === 0 && !recentMessage) {
		return {
			assessment: "unknown",
			detail:
				"no heartbeat and no CommDB messages on record — cannot say whether the runner is alive",
		};
	}
	const parts: string[] = [];
	if (evidence.heartbeatAtMs != null) {
		parts.push(`heartbeat ${ago(nowMs, evidence.heartbeatAtMs)}`);
	}
	if (evidence.lastMessageAtMs != null) {
		parts.push(`last CommDB message ${ago(nowMs, evidence.lastMessageAtMs)}`);
	}
	if (recentMessage) {
		parts.push(
			`a CommDB message within the ${Math.round(windowMs / 60000)}m window`,
		);
	}
	// A recent CommDB message is on its own enough for likely-alive (the FLY-1319
	// shape: a live runner still sending `ask`s while its heartbeat went stale).
	const withinByStamp =
		stamps.length > 0 && nowMs - Math.max(...stamps) <= windowMs;
	const within = recentMessage || withinByStamp;
	return {
		assessment: within ? "likely-alive" : "likely-dead",
		detail: within
			? `${parts.join(", ")} — within the ${Math.round(windowMs / 60000)}m activity window, so the runner is LIKELY ALIVE and the window lookup is probably stale (the FLY-1319 shape)`
			: `${parts.join(", ")} — outside the ${Math.round(windowMs / 60000)}m activity window, so the runner is LIKELY DEAD without a dead-pin; the park leaves it for the existing reconcile paths`,
	};
}
