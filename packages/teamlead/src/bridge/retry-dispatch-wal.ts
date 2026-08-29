/**
 * FLY-245 D2 — gateway-retry reconcile against the durable intent WAL
 * (plan §5.2.1, Codex R3/R4-HIGH).
 *
 * The production hole this closes: `RetryDispatcher.dispatch()` self-generated
 * a fresh randomUUID with dedup only in an in-memory map, and `handleRetry`
 * persisted the predecessor→successor lineage AFTER dispatch
 * (`actions.ts` dispatch-before-setRetrySuccessor). A crash in that window —
 * or a Bridge restart wiping the inflight map — left a replayed retry with no
 * way to know whether a Runner had already started, so it could start a
 * SECOND one. `retry` is the one non-idempotent lifecycle action (it creates
 * a new execution); generic postconditions can't recover it.
 *
 * The fix, at this layer:
 *   1. the gateway pre-binds the successor execution id; the FIRST attempt
 *      commits the (request id → successor id) binding to the WAL BEFORE any
 *      dispatch — the binding survives every later crash;
 *   2. a REPLAY of a known request id reconciles against AUTHORITATIVE started
 *      evidence (started-evidence.ts — the Runner's self-registered live tmux
 *      identity, never the intent marker):
 *        - evidence started → CONVERGED: repair the lineage
 *          (setRetrySuccessor + mark dispatched) and return the successor —
 *          never a second dispatch;
 *        - provably not started (no row / pending-only / dead window) →
 *          re-drive with the SAME successor id (find-or-create converges);
 *        - unprovable (lookup error / throw) → FAIL-CLOSED;
 *   3. a request id can never bind a second successor id (conflict).
 *
 * Pure decision logic over an injected store + evidence checker; the caller
 * (`handleRetry`) dispatches only on `proceed`.
 */

import type { StateStore } from "../StateStore.js";
import type { StartedEvidence } from "./started-evidence.js";

export interface GatewayRetryArgs {
	gatewayRequestId: string;
	successorExecutionId: string;
	predecessorExecutionId: string;
	projectName: string;
}

export type GatewayRetryReconcile =
	/** Dispatch with the pre-bound successor id (intent WAL is committed). */
	| { kind: "proceed"; firstAttempt: boolean }
	/** The successor already started — lineage repaired, do NOT dispatch. */
	| { kind: "converged"; successorExecutionId: string }
	/** The request id is bound to a DIFFERENT successor id. */
	| { kind: "conflict"; boundSuccessorExecutionId: string }
	/** Could not prove the state — refuse (a blind re-drive could start a
	 * second runner). */
	| { kind: "fail_closed"; detail: string };

export type GatewayRetryStore = Pick<
	StateStore,
	| "getRetryDispatchIntent"
	| "recordRetryDispatchIntent"
	| "setRetrySuccessor"
	| "markRetryDispatchDispatched"
>;

export interface GatewayRetryDeps {
	checkEvidence: (
		executionId: string,
		projectName: string,
	) => Promise<StartedEvidence>;
}

export async function reconcileGatewayRetry(
	store: GatewayRetryStore,
	args: GatewayRetryArgs,
	deps: GatewayRetryDeps,
): Promise<GatewayRetryReconcile> {
	if (
		!args.gatewayRequestId ||
		!args.successorExecutionId ||
		!args.predecessorExecutionId ||
		!args.projectName
	) {
		return { kind: "fail_closed", detail: "missing_identifiers" };
	}

	const existing = store.getRetryDispatchIntent(args.gatewayRequestId);
	if (!existing) {
		// First attempt: commit the binding BEFORE any dispatch. A crash from
		// here on leaves a durable (request id → successor id) row that every
		// replay reconciles against.
		store.recordRetryDispatchIntent(
			args.gatewayRequestId,
			args.successorExecutionId,
			args.predecessorExecutionId,
		);
		return { kind: "proceed", firstAttempt: true };
	}

	if (existing.successor_execution_id !== args.successorExecutionId) {
		return {
			kind: "conflict",
			boundSuccessorExecutionId: existing.successor_execution_id,
		};
	}

	// Replay of a known binding: reconcile against authoritative evidence.
	let evidence: StartedEvidence;
	try {
		evidence = await deps.checkEvidence(
			args.successorExecutionId,
			args.projectName,
		);
	} catch (err) {
		return {
			kind: "fail_closed",
			detail: `evidence_check_threw:${(err as Error).message}`,
		};
	}

	if (evidence.started) {
		// The successor is live — converge: repair the lineage the original
		// crash window may have lost, and never dispatch again.
		store.setRetrySuccessor(
			args.predecessorExecutionId,
			args.successorExecutionId,
		);
		store.markRetryDispatchDispatched(args.gatewayRequestId);
		return {
			kind: "converged",
			successorExecutionId: args.successorExecutionId,
		};
	}
	if (evidence.reason === "lookup_error") {
		return { kind: "fail_closed", detail: "started_evidence_unprovable" };
	}
	// no_row / pending_only / tmux_dead: provably not started — the same-key
	// re-drive is idempotent (find-or-create by execId converges).
	return { kind: "proceed", firstAttempt: false };
}
