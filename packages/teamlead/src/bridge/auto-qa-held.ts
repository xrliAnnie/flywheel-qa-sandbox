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
