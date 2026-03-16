/**
 * applyTransition() — Unified entry point for ALL status changes.
 * GEO-158: validate via FSM → persist via persistTransition → drain audit.
 */

import type { TransitionContext, TransitionResult, WorkflowFSM } from "flywheel-core";
import type { StateStore, SessionUpsert } from "./StateStore.js";
import type { DirectiveExecutor } from "./DirectiveExecutor.js";

export interface ApplyTransitionOpts {
	store: StateStore;
	fsm: WorkflowFSM;
	executor?: DirectiveExecutor;
}

/**
 * Unified transition entry point: validate → guard → persist → audit.
 * All status changes must go through this function.
 *
 * For first-time writes (no existing session), implicitly starts from "pending".
 */
export function applyTransition(
	opts: ApplyTransitionOpts,
	executionId: string,
	targetStatus: string,
	ctx: TransitionContext,
	sessionFields?: Partial<SessionUpsert>,
): TransitionResult {
	const { store, fsm, executor } = opts;

	// Determine current state (missing session = "pending")
	const existing = store.getSession(executionId);
	const currentState = existing?.status ?? "pending";

	// FSM validate + guard + generate directives
	const result = fsm.transition(currentState, targetStatus, ctx);
	if (!result.ok) return result;

	// Persist via persistTransition (INSERT OR UPDATE, bypasses monotonic guard)
	store.persistTransition(executionId, targetStatus, {
		issue_id: ctx.issueId,
		project_name: ctx.projectName,
		...sessionFields,
	});

	// Drain directives (audit) — best-effort
	if (executor && result.directives.length > 0) {
		executor.drain(result.directives).catch(() => {});
	}

	return result;
}
