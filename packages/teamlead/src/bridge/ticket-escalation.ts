/**
 * FLY-927 (Task 2.4): the T2 "couldn't fix" decision — PURE.
 *
 * Locked constants (PRD T2): a ticket is deemed un-fixable after 2 ARC
 * attempts OR 5 minutes past first-seen; an owner-assigned ticket nobody
 * claimed within 5 minutes escalates too (unclaimed fallback) — but ONLY when
 * the owner bot is actually configured (env id present). Owner env unset ⇒ no
 * unclaimed fallback ⇒ today's Cass behavior (FLY-928 pure-config flip).
 *
 * The reconcile pass (AlertChannelHub, piggybacked on the existing watchdog
 * onPollComplete — no new timer, FLY-169) runs this per active ticket row.
 * Recovery is checked BEFORE this decision in the same pass, so a recovered
 * ticket resolves quietly and never reaches escalation.
 */

export interface TicketEscalationPolicy {
	/** ARC attempts before "couldn't fix" (T2 locked: 2). */
	maxAttempts: number;
	/** Age past first-seen before "couldn't fix" (T2 locked: 5 min). */
	timeoutMs: number;
	/** NEW-and-unclaimed age before the fallback escalation (5 min). */
	unclaimedMs: number;
	/**
	 * FLY-1082 (Task 2.2): does a REPAIRING ticket under budget get a second
	 * ARC attempt on reconcile? Default true (the legacy nudge-family loop).
	 * FALSE for kinds whose remediation is single-shot/idempotent (pressure-
	 * hold, server-loss coordinator, boot self-check) — a per-tick retry would
	 * both spam the thread and burn the 2-attempt budget in ~1 minute, turning
	 * the slow-variable timeout into a 2-tick escalation.
	 */
	retryOnReconcile?: boolean;
}

export const DEFAULT_TICKET_ESCALATION_POLICY: TicketEscalationPolicy = {
	maxAttempts: 2,
	timeoutMs: 300_000,
	unclaimedMs: 300_000,
};

/**
 * FLY-1082 (Task 2.2): per-kind escalation policy resolver. Legacy kinds keep
 * the locked T2 defaults byte-for-byte; the fleet kinds override where the T2
 * semantics genuinely differ:
 *  - swap_pressure_high: the watermark is a SLOW variable — "couldn't fix" is
 *    "still above threshold after 30 min" (env FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN),
 *    not 5 minutes; the hold is single-shot so no reconcile retry.
 *  - tmux_server_lost / bridge_abnormal_exit: the remediation ran at
 *    detection/boot — retrying it per tick is meaningless; recovery (quiet
 *    resolve) or the timeout escalation decides.
 *  - infra_bot_down keeps the default (a kickstart retry IS meaningful —
 *    2 failures → escalate, per the plan).
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

export type TicketEscalationDecision = "none" | "retry" | "escalate";

export interface TicketEscalationRow {
	ticket_status: string | null;
	attempt_count: number;
	first_seen_at: string | null;
	acked_at: string | null;
}

/** Parse a SQLite `datetime('now')` UTC string to ms (NaN-safe → 0 age). */
function sqliteUtcMs(s: string | null): number | null {
	if (!s) return null;
	const t = Date.parse(`${s.replace(" ", "T")}Z`);
	return Number.isNaN(t) ? null : t;
}

export function decideTicketEscalation(
	row: TicketEscalationRow,
	nowMs: number,
	ownerConfigured: boolean,
	policy: TicketEscalationPolicy = DEFAULT_TICKET_ESCALATION_POLICY,
): TicketEscalationDecision {
	const status = row.ticket_status;
	// Legacy rows (NULL) and terminal states never escalate.
	if (!status || status === "RESOLVED" || status === "ESCALATED") return "none";
	const firstSeen = sqliteUtcMs(row.first_seen_at);
	const age = firstSeen === null ? 0 : nowMs - firstSeen;

	if (status === "REPAIRING" || status === "ACK") {
		// "Couldn't fix" = attempts budget burned OR the timeout window elapsed
		// without a recovery resolve (the recovery check ran before us).
		if (row.attempt_count >= policy.maxAttempts || age > policy.timeoutMs) {
			return "escalate";
		}
		// A Cass-driven REPAIRING ticket under budget gets its second attempt —
		// STILL through every safety gate (the AutoRepairBot refuses on its own).
		// FLY-1082: unless the kind's policy disables reconcile retries
		// (single-shot remediations — see policyForKind).
		if (policy.retryOnReconcile === false) return "none";
		return status === "REPAIRING" ? "retry" : "none";
	}

	// NEW: nobody claimed it. The fallback only arms when the owner bot is
	// actually deployed/configured — otherwise this is the pre-FLY-928 world
	// and the ticket just sits (Cass status quo, zero regression).
	if (ownerConfigured && age > policy.unclaimedMs) return "escalate";
	return "none";
}

/**
 * Is the row's owner bot actually configured (a validated user id in env)?
 * `owner_ref` shapes: `infra_bot:claude` / `infra_bot:codex` / `lead:<id>` / "".
 */
export function ticketOwnerConfigured(
	ownerRef: string | null,
	reg: { claudeBotUserId: string | null; codexBotUserId: string | null },
): boolean {
	if (ownerRef === "infra_bot:claude") return reg.claudeBotUserId !== null;
	if (ownerRef === "infra_bot:codex") return reg.codexBotUserId !== null;
	return false;
}
