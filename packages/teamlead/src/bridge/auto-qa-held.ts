/**
 * FLY-579 P1: the shared "QA-held" predicate.
 *
 * A main session that has finished code review and entered `awaiting_review`
 * is QA-HELD while its auto-spawned QA Runner is still verifying (or has failed
 * verification). While held, EVERY founder-facing review surface must stay
 * silent — the founder is only surfaced once QA is green. This single predicate
 * is consumed by all three suppression points so they cannot drift:
 *
 *   1. event-route always-deliver block (suppress `[Review Required]` delivery)
 *   2. GatePoller (skip relaying the parent's approve_to_ship gate question,
 *      and DON'T evict it as stale)
 *   3. HeartbeatService.checkAwaitingReviewTimeout (skip the founder
 *      `gate_timed_out` escalation)
 *
 * Held iff there is an AutoQaRecord for (execution_id, current pr_head_sha)
 * whose status is NOT `passed`. `passed` releases (founder may be surfaced);
 * `running` / `failed` / `stuck` all hold (QA not green → keep the founder out
 * of it). A `superseded` record never matches because the session's
 * pr_head_sha has moved to the newer record's head.
 *
 * Byte-compat: a session with NO matching record (auto-QA off, or a non-main
 * role, or not awaiting_review) is never held — existing behavior is unchanged.
 */

import type { AutoQaRecord } from "../StateStore.js";
import {
	type CodexGateStore,
	codexHardGateEnabled,
	isCodexGateSatisfied,
	isReviewableRole,
} from "./codex-gate.js";

/** Minimal read surface — keeps the predicate trivially unit-testable. */
export interface AutoQaHeldStore {
	getAutoQaRecord(
		parentExecutionId: string,
		targetPrHeadSha: string,
	): AutoQaRecord | undefined;
}

export interface QaHeldSession {
	execution_id: string;
	session_role?: string;
	status?: string;
	pr_head_sha?: string;
	/** FLY-827: sanctioned codex-skip bypass (needed by isReviewHeld). DB=int, type=bool. */
	codex_skip?: number | boolean;
	/** FLY-869 B: merged-but-unapproved park marker — held from ALL founder surfaces. */
	merge_block_reason?: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * FLY-827: the UNIFIED founder-hold predicate = codex gate hold OR QA hold.
 *
 * A main session in `awaiting_review` is held from founder surfacing while EITHER
 * Codex code review is not satisfied for the current head, OR (once codex passed)
 * QA is not green. All four founder-surface points (event-route always-deliver,
 * GatePoller approve relay, HeartbeatService gate_timed_out, DirectEventSink
 * emitCompleted push) consume THIS predicate so they cannot drift.
 *
 * Missing/invalid pr_head_sha (Codex R2-MED-3): a head-specific Codex review can't
 * run without a head, so under the hard gate (and not codex_skip) an awaiting_review
 * main session with no valid head is HELD (fail-closed — never surface an unmergeable
 * review). Gate-off / codex_skip → fall through to isQaHeld's no-sha behavior (false).
 *
 * Byte-compat: with the hard gate OFF, isReviewHeld === isQaHeld exactly.
 */
export function isReviewHeld(
	store: AutoQaHeldStore & CodexGateStore,
	session: QaHeldSession | undefined,
	env: Record<string, string | undefined> = process.env,
): boolean {
	// FLY-1099 §4.1: isReviewHeld and reviewHoldReason share ONE implementation
	// so the boolean and the reason classification can never drift.
	return reviewHoldReason(store, session, env) !== null;
}

/**
 * FLY-1099 §4.1 (Codex R1 #2): WHY the session is founder-held. Same predicate
 * order as the historical isReviewHeld body (merge_block → role/status gates →
 * codex → QA), pure read.
 *   - `merge_block` — only clearable by same-head approval recovery (FLY-869);
 *     a deferred approval waiting on it would deadlock → NEVER deferrable.
 *   - `codex_pending` / `qa_not_green` — self-clearing holds → deferrable.
 * null = not held.
 */
export type ReviewHoldReason =
	| "merge_block"
	| "codex_pending"
	| "qa_not_green"
	| "qa_evidence_missing"
	| "qa_evidence_unknown"
	| "no_qualified_reviewer";

/**
 * Holds that can safely park an approval until the same review round clears.
 * Every other reason requires a fresh founder action after readiness returns.
 */
export function isDeferrableReviewHoldReason(
	reason: ReviewHoldReason,
): reason is "codex_pending" | "qa_not_green" {
	return reason === "codex_pending" || reason === "qa_not_green";
}

export function reviewHoldReason(
	store: AutoQaHeldStore & CodexGateStore,
	session: QaHeldSession | undefined,
	env: Record<string, string | undefined> = process.env,
): ReviewHoldReason | null {
	if (!session) return null;
	// FLY-869 B (design R2 HIGH-4 + Codex guardrail #1): a merged-but-unapproved
	// parked session (merge_block marker) is held from EVERY founder surface —
	// GatePoller approve-relay, event-route always-deliver, HeartbeatService
	// gate_timed_out, DirectEventSink push — until same-head approval recovery
	// clears the marker. Centralized here so the suppression can never drift.
	if (session.merge_block_reason) return "merge_block";
	// FLY-827 + FLY-793: hold the PR-owning reviewable roles (main + implement);
	// the qa/design roles are verifiers / pre-PR and are never founder-held here.
	if (!isReviewableRole(session.session_role)) return null;
	if (session.status !== "awaiting_review") return null;
	const sha = session.pr_head_sha?.toLowerCase();
	if (!sha || !FULL_SHA.test(sha)) {
		// No valid head: hold under the hard gate (unless codex_skip), else no-op.
		// A head-specific Codex review can't run without a head → codex_pending.
		return codexHardGateEnabled(env) && !session.codex_skip
			? "codex_pending"
			: null;
	}
	// Codex gate first: not satisfied → held (independent of QA policy).
	if (!isCodexGateSatisfied(store, session, sha, env)) return "codex_pending";
	// Codex satisfied → defer to the QA hold (QA-held is main-only; false for
	// implement, which uses the FLY-793 phase QA rather than auto-QA).
	return isQaHeld(store, session) ? "qa_not_green" : null;
}

/**
 * FLY-1041 Chunk 5: the shared pre-write hold guard for EVERY founder
 * approval source (text attribution / ✅ reaction / voice). While
 * `isReviewHeld` holds (codex gate unsatisfied / QA not green / merge_block),
 * NO founder approval may be written by ANY channel — the pre-FLY-1041 text
 * path silently wrote approvals on held sessions (FLY-910 05:47), producing
 * "bound but unshippable" confusion. The kill-switch
 * `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` restores that byte-compatible behavior
 * for all three sources at once (one switch, Codex R1 #1).
 * Returns true = DECLINE the write (held).
 */
export function founderApprovalHoldGuard(
	store: AutoQaHeldStore & CodexGateStore,
	session: QaHeldSession | undefined,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (env.FLYWHEEL_ATTRIBUTION_HOLD_ALIGN === "0") return false;
	return isReviewHeld(store, session, env);
}

export function isQaHeld(
	store: AutoQaHeldStore,
	session: QaHeldSession | undefined,
): boolean {
	if (!session) return false;
	// Only an in-review MAIN session can be QA-held. The QA session itself, and
	// any non-awaiting_review state, are never held.
	if ((session.session_role ?? "main") !== "main") return false;
	if (session.status !== "awaiting_review") return false;
	const sha = session.pr_head_sha;
	if (!sha) return false;
	const record = store.getAutoQaRecord(session.execution_id, sha);
	if (!record) return false;
	return record.status !== "passed";
}
