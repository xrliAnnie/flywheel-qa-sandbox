/**
 * FLY-927 (Task 2.4): bounded repair-retry decision — PURE.
 *
 * Locked constants (PRD T2): a ticket is deemed un-fixable after 2 ARC
 * attempts OR 5 minutes past first-seen. Exhausted tickets remain visible for
 * duty handling; this helper never creates an automatic escalation.
 *
 * The reconcile pass (AlertChannelHub, piggybacked on the existing GatePoller
 * lead-reconcile rider — no new timer, FLY-169) runs this per active ticket row.
 * Recovery is checked BEFORE this retry decision in the same pass.
 */

export interface TicketEscalationPolicy {
	/** ARC attempts before "couldn't fix" (T2 locked: 2). */
	maxAttempts: number;
	/** Age past first-seen before "couldn't fix" (T2 locked: 5 min). */
	timeoutMs: number;
	/**
	 * FLY-1082 (Task 2.2): does a REPAIRING ticket under budget get a second
	 * ARC attempt on reconcile? Default true (the legacy nudge-family loop).
	 * FALSE for kinds whose remediation is single-shot/idempotent (pressure-
	 * hold, server-loss coordinator, boot self-check) — a per-tick retry would
	 * both spam the thread and burn the 2-attempt budget in ~1 minute.
	 */
	retryOnReconcile?: boolean;
}

export const DEFAULT_TICKET_ESCALATION_POLICY: TicketEscalationPolicy = {
	maxAttempts: 2,
	timeoutMs: 300_000,
};

/**
 * FLY-1082 (Task 2.2): per-kind retry policy resolver. Legacy kinds keep
 * the locked T2 defaults byte-for-byte; the fleet kinds override where the T2
 * semantics genuinely differ:
 *  - swap_pressure_high: the watermark is a SLOW variable — "couldn't fix" is
 *    "still above threshold after 30 min" (env FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN),
 *    not 5 minutes; the hold is single-shot so no reconcile retry.
 *  - tmux_server_lost / bridge_abnormal_exit: the remediation ran at
 *    detection/boot — retrying it per tick is meaningless; recovery quietly
 *    resolves, otherwise the visible ticket remains for duty handling.
 *  - infra_bot_down keeps the default (one kickstart retry is meaningful).
 */
export function policyForKind(
	kind: string,
	env: NodeJS.ProcessEnv = process.env,
): TicketEscalationPolicy {
	if (kind === "swap_pressure_high") {
		const raw = Number(env.FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN);
		const minutes = Number.isFinite(raw) && raw > 0 ? raw : 30;
		return {
			...DEFAULT_TICKET_ESCALATION_POLICY,
			timeoutMs: minutes * 60_000,
			retryOnReconcile: false,
		};
	}
	if (kind === "tmux_server_lost" || kind === "bridge_abnormal_exit") {
		return { ...DEFAULT_TICKET_ESCALATION_POLICY, retryOnReconcile: false };
	}
	return DEFAULT_TICKET_ESCALATION_POLICY;
}

export type TicketEscalationDecision = "none" | "retry";

export interface TicketEscalationRow {
	ticket_status: string | null;
	attempt_count: number;
	first_seen_at: string | null;
	acked_at: string | null;
}

/** Parse a SQLite `datetime('now')` UTC string; missing/invalid fails closed. */
function sqliteUtcMs(s: string | null): number | null {
	if (!s) return null;
	const t = Date.parse(`${s.replace(" ", "T")}Z`);
	return Number.isNaN(t) ? null : t;
}

export function decideTicketEscalation(
	row: TicketEscalationRow,
	nowMs: number,
	policy: TicketEscalationPolicy = DEFAULT_TICKET_ESCALATION_POLICY,
): TicketEscalationDecision {
	const status = row.ticket_status;
	// Legacy rows (NULL) and terminal states never reconcile.
	if (!status || status === "RESOLVED" || status === "ESCALATED") return "none";
	const firstSeen = sqliteUtcMs(row.first_seen_at);
	if (firstSeen === null) return "none";
	const age = nowMs - firstSeen;

	if (status === "REPAIRING" || status === "ACK") {
		// Exhausted or timed-out tickets stay visible in their current state.
		if (row.attempt_count >= policy.maxAttempts || age > policy.timeoutMs) {
			return "none";
		}
		// A Cass-driven REPAIRING ticket under budget gets its second attempt —
		// STILL through every safety gate (the AutoRepairBot refuses on its own).
		// FLY-1082: unless the kind's policy disables reconcile retries
		// (single-shot remediations — see policyForKind).
		if (policy.retryOnReconcile === false) return "none";
		return status === "REPAIRING" ? "retry" : "none";
	}

	// MONITORING and NEW tickets remain visible until an explicit actor changes them.
	return "none";
}
