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
}

export const DEFAULT_TICKET_ESCALATION_POLICY: TicketEscalationPolicy = {
	maxAttempts: 2,
	timeoutMs: 300_000,
	unclaimedMs: 300_000,
};

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
		// "Couldn't fix" = attempts budget burned OR the 5-minute window elapsed
		// without a recovery resolve (the recovery check ran before us).
		if (row.attempt_count >= policy.maxAttempts || age > policy.timeoutMs) {
			return "escalate";
		}
		// A Cass-driven REPAIRING ticket under budget gets its second attempt —
		// STILL through every safety gate (the AutoRepairBot refuses on its own).
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
