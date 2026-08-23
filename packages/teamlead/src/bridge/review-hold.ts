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
	isCodexGateSatisfied,
	isReviewableRole,
} from "./codex-gate.js";
import {
	SHIP_RELEVANT_CLASSIFIER_VERSION,
	SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS,
} from "./ship-relevant-diff.js";

/** Minimal read surface — keeps the predicate trivially unit-testable. */
export interface AutoQaHeldStore {
	getAutoQaRecord(
		parentExecutionId: string,
		targetPrHeadSha: string,
	): AutoQaRecord | undefined;
	getShipRelevantDiffSnapshot?(
		parentExecutionId: string,
		targetPrHeadSha: string,
	):
		| {
				pr_number: number;
				classifier_version: number;
				ship_relevant: 0 | 1;
				computed_at: string;
		  }
		| undefined;
}

export interface QaHeldSession {
	execution_id: string;
	session_role?: string;
	status?: string;
	pr_head_sha?: string;
	pr_number?: number;
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
 * run without a head, so an awaiting_review session with no valid head is held
 * fail-closed unless the PR-owning implement session carries sanctioned codex_skip.
 * Main sessions remain evidence-unknown because they also need PR identity for QA.
 */
export function isReviewHeld(
	store: AutoQaHeldStore & CodexGateStore,
	session: QaHeldSession | undefined,
): boolean {
	// FLY-1099 §4.1: isReviewHeld and reviewHoldReason share ONE implementation
	// so the boolean and the reason classification can never drift.
	return reviewHoldReason(store, session) !== null;
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
	const mainRole = (session.session_role ?? "main") === "main";
	try {
		const sha = session.pr_head_sha?.toLowerCase();
		if (!sha || !FULL_SHA.test(sha)) {
			// FLY-1251: a main review with no objective PR head cannot be classified
			// as docs-only or matched to QA evidence. Unknown must hold regardless of
			// Codex evidence. Implement is Codex-held unless it carries the sanctioned
			// session-level skip.
			if (mainRole) return "qa_evidence_unknown";
			return session.codex_skip ? null : "codex_pending";
		}
		if (mainRole && session.pr_number == null) {
			return "qa_evidence_unknown";
		}
		// Codex gate first: not satisfied → held (independent of QA policy).
		if (!isCodexGateSatisfied(store, session, sha)) return "codex_pending";

		const record = store.getAutoQaRecord(session.execution_id, sha);
		if (record) return record.status === "passed" ? null : "qa_not_green";

		// FLY-793 implement owns a PR but delegates its verification to the phase
		// pipeline. FLY-1251's stopgap is intentionally main-only.
		if (!mainRole) return null;

		const snapshot = store.getShipRelevantDiffSnapshot?.(
			session.execution_id,
			sha,
		);
		if (
			!snapshot ||
			snapshot.pr_number !== session.pr_number ||
			snapshot.classifier_version !== SHIP_RELEVANT_CLASSIFIER_VERSION
		) {
			return "qa_evidence_missing";
		}
		const computedAt = Date.parse(snapshot.computed_at);
		const ageMs = Date.now() - computedAt;
		if (
			!Number.isFinite(computedAt) ||
			ageMs < -SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS ||
			ageMs > SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS
		) {
			return "qa_evidence_unknown";
		}
		return snapshot.ship_relevant === 0 ? null : "qa_evidence_missing";
	} catch (error) {
		// A main-session evidence read is an authorization predicate. Any read
		// failure therefore closes the founder surface. Other roles retain their
		// historical exception behavior.
		if (mainRole) return "qa_evidence_unknown";
		throw error;
	}
}

/**
 * FLY-1041 Chunk 5: the shared pre-write hold guard for EVERY founder
 * approval source (text attribution / ✅ reaction / voice). While
 * `isReviewHeld` holds (codex gate unsatisfied / QA not green / merge_block),
 * NO founder approval may be written by ANY channel — the pre-FLY-1041 text
 * path silently wrote approvals on held sessions (FLY-910 05:47), producing
 * "bound but unshippable" confusion. FLY-1251 removes the silent env bypass:
 * authorization holds are fail-closed in every founder-write channel.
 * Returns true = DECLINE the write (held).
 */
export function founderApprovalHoldGuard(
	store: AutoQaHeldStore & CodexGateStore,
	session: QaHeldSession | undefined,
): boolean {
	return isReviewHeld(store, session);
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
