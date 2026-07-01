/**
 * FLY-637-ext: lead-pending escalation — pure exponential-backoff policy.
 *
 * direction A (PR #386) made the watchdog "report once". This extension adds the
 * one missing case: a runner BLOCKED on a lead-facing `question` gate that the
 * Lead sits on without answering. The watchdog already covers the other two
 * cases (FLY-605 founder-facing gates; FLY-195 frozen runners), so this is a
 * narrow, GatePoller-local addition.
 *
 * Policy (Annie 2026-06-29): a `question` gate that stays pending past `graceMs`
 * (default 20min) with no progress → nudge the owning Lead. Each subsequent nudge
 * waits an exponentially-growing interval (`graceMs × factor^n`, capped at
 * `capMs`). After `pageAnnieRounds` lead-nudges (default 3) the next eligible
 * escalation pages Annie ONCE (final fallback), then keeps nudging the Lead at
 * the cap. `pageAnnieRounds = 0` ⇒ never page Annie (config flip, Codex R1 #4).
 *
 * This module is PURE (no I/O, injected clock); the GatePoller owns the durable
 * `lead_pending_escalation` row + the actual event/alert emission.
 */

import { createHash } from "node:crypto";

/** Durable per-(execution, question) escalation state. */
export interface LeadNudgeRow {
	/** sha16(questionId|session_stage) — changes ⇒ external progress ⇒ reset. */
	stuck_key: string;
	/** How many lead-nudges have been sent for this episode. */
	nudge_count: number;
	last_nudge_at_ms: number;
	/** Earliest ms for the next escalation = last_nudge + min(base×factor^n, cap). */
	next_eligible_at_ms: number;
	/** True once Annie has been paged (page-once). */
	paged_annie: boolean;
}

export interface LeadNudgePolicy {
	/** `FLYWHEEL_LEAD_NUDGE_GRACE_MS` — pending-time before the FIRST nudge. */
	graceMs: number;
	/** `FLYWHEEL_LEAD_NUDGE_BACKOFF_FACTOR` — interval multiplier (default 2). */
	backoffFactor: number;
	/** `FLYWHEEL_LEAD_NUDGE_CAP_MS` — max interval between nudges. */
	capMs: number;
	/** `FLYWHEEL_LEAD_NUDGE_PAGE_ANNIE_ROUNDS` — lead-nudges before paging Annie; 0 = never. */
	pageAnnieRounds: number;
}

export type LeadNudgeAction =
	| { kind: "wait" }
	/** stuck_key changed (external progress) → persist a fresh, grace-delayed row. */
	| { kind: "reset"; nextRow: LeadNudgeRow }
	| { kind: "nudge"; nudgeCount: number; nextRow: LeadNudgeRow }
	| { kind: "page_annie"; nextRow: LeadNudgeRow };

/** Episode identity for a blocking question gate (questionId + current stage). */
export function computeStuckKey(
	questionId: string,
	stage: string | null,
): string {
	return createHash("sha256")
		.update(`${questionId}|${stage ?? ""}`)
		.digest("hex")
		.slice(0, 16);
}

/**
 * Decide whether to nudge the Lead, page Annie, or wait — from the prior durable
 * row + the current stuck_key + clocks. Pure; the caller persists `nextRow` only
 * AFTER the user-visible event is accepted (FLY-637-ext R1 #5).
 *
 * @param prev               last persisted row for this (execution, question), or undefined
 * @param stuckKey           computeStuckKey(questionId, stage) NOW
 * @param questionCreatedAtMs when the gate question was raised (for the first-nudge grace)
 * @param nowMs              injected clock
 */
export function decideLeadNudge(
	prev: LeadNudgeRow | undefined,
	stuckKey: string,
	questionCreatedAtMs: number,
	nowMs: number,
	policy: LeadNudgePolicy,
): LeadNudgeAction {
	// A changed stuck_key means external progress (stage advanced) — start a fresh
	// episode and restart the grace clock from NOW. Codex code R1 #2: the original
	// `question.created_at` is old, so the first-sighting branch below would nudge
	// immediately; a reset row seeds `next_eligible = now + grace` so the caller
	// honors a real fresh grace before the next nudge.
	if (prev !== undefined && prev.stuck_key !== stuckKey) {
		return {
			kind: "reset",
			nextRow: {
				stuck_key: stuckKey,
				nudge_count: 0,
				last_nudge_at_ms: nowMs,
				next_eligible_at_ms: nowMs + policy.graceMs,
				paged_annie: false,
			},
		};
	}

	const prevCount = prev?.nudge_count ?? 0;
	const paged = prev?.paged_annie ?? false;
	// First sighting (no row): grace from the question's creation. Any persisted row
	// (incl. a count-0 reset row): the row's own `next_eligible_at_ms`.
	const eligible =
		prev === undefined
			? nowMs - questionCreatedAtMs >= policy.graceMs
			: nowMs >= prev.next_eligible_at_ms;

	if (!eligible) return { kind: "wait" };

	const newCount = prevCount + 1;
	const nextInterval = Math.min(
		policy.capMs,
		policy.graceMs * policy.backoffFactor ** newCount,
	);
	// `>=` (not `===`): a page that was NOT accepted leaves `paged_annie` false, so
	// the next eligible escalation re-attempts the page until it lands (Codex code
	// R1 #1) — instead of advancing past the page step and never paging Annie.
	const shouldPage =
		policy.pageAnnieRounds > 0 &&
		newCount >= policy.pageAnnieRounds + 1 &&
		!paged;
	const nextRow: LeadNudgeRow = {
		stuck_key: stuckKey,
		nudge_count: newCount,
		last_nudge_at_ms: nowMs,
		next_eligible_at_ms: nowMs + nextInterval,
		paged_annie: paged || shouldPage,
	};
	return shouldPage
		? { kind: "page_annie", nextRow }
		: { kind: "nudge", nudgeCount: newCount, nextRow };
}

// ── env readers (used by the GatePoller wiring) ──

function parsePositiveIntEnv(
	raw: string | undefined,
	fallback: number,
): number {
	const n = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `FLYWHEEL_LEAD_PENDING_ESCALATION=0` disables the whole feature (byte-compat). */
export function leadPendingEscalationEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.FLYWHEEL_LEAD_PENDING_ESCALATION !== "0";
}

export function readLeadNudgePolicy(
	env: NodeJS.ProcessEnv = process.env,
): LeadNudgePolicy {
	// pageAnnieRounds uses NON-negative parse: 0 is the explicit "never page" value.
	const roundsRaw = Number.parseInt(
		env.FLYWHEEL_LEAD_NUDGE_PAGE_ANNIE_ROUNDS ?? "",
		10,
	);
	const pageAnnieRounds =
		Number.isFinite(roundsRaw) && roundsRaw >= 0 ? roundsRaw : 3;
	return {
		graceMs: parsePositiveIntEnv(env.FLYWHEEL_LEAD_NUDGE_GRACE_MS, 20 * 60_000),
		backoffFactor: parsePositiveIntEnv(
			env.FLYWHEEL_LEAD_NUDGE_BACKOFF_FACTOR,
			2,
		),
		capMs: parsePositiveIntEnv(env.FLYWHEEL_LEAD_NUDGE_CAP_MS, 120 * 60_000),
		pageAnnieRounds,
	};
}
