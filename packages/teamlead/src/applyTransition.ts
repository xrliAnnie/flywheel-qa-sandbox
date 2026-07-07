/**
 * applyTransition() — Unified entry point for ALL status changes.
 * GEO-158: validate via FSM → persist via persistTransition → drain audit.
 */

import type {
	TransitionContext,
	TransitionResult,
	WorkflowFSM,
} from "flywheel-core";
import type { DirectiveExecutor } from "./DirectiveExecutor.js";
import type { SessionUpsert, StateStore } from "./StateStore.js";

export interface ApplyTransitionOpts {
	store: StateStore;
	fsm: WorkflowFSM;
	executor?: DirectiveExecutor;
	/**
	 * FLY-907 (Step 4.1): optional post-persist hook — called synchronously
	 * after a SUCCESSFUL transition is persisted, before returning. The Bridge
	 * composition root wires it (on BOTH ApplyTransitionOpts instances — the
	 * shared one and the stale-blocker guard's own) to enqueue a unified
	 * issue-display refresh, so every status write path that funnels through
	 * applyTransition (kill/terminate/retry/reject/close-runner/crash-reaper/
	 * heartbeat reconcile/marker reconcilers/completion routes/founder consent)
	 * becomes a display trigger. The hook body MUST only enqueue (microseconds)
	 * — it is invoked inside a try/catch so it can never break a transition.
	 */
	onTransition?: (
		executionId: string,
		targetStatus: string,
		ctx: TransitionContext,
	) => void;
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

	// FLY-907: display-refresh hook — after persist, never throws into callers.
	if (opts.onTransition) {
		try {
			opts.onTransition(executionId, targetStatus, ctx);
		} catch (err) {
			console.warn(
				`[applyTransition] onTransition hook threw for ${executionId}: ${(err as Error).message}`,
			);
		}
	}

	return result;
}
