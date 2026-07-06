/**
 * FLY-245 D2 — gateway-side retry reconciler (plan §5.2.1, R4-HIGH).
 *
 * `retry` is the one NON-idempotent lifecycle action: it creates a new
 * execution, so the generic §5.2.1 postconditions (status-equals /
 * resource-absent) cannot recover it. D-f ships a fail-closed
 * `needs_reconfirm` placeholder; THIS is the real verifier the recovery wiring
 * (Phase F) plugs in for `retry` rows:
 *
 *   - no successor bound yet → `retry_safe`: nothing can have started (the
 *     Bridge only accepts dispatches carrying the pre-bound id), so the
 *     re-drive — which binds first, then dispatches — is safe;
 *   - successor bound + AUTHORITATIVE started evidence (the Runner's
 *     self-registered non-`:pending` LIVE tmux identity, never the intent
 *     marker, never an early `session_started` event) → `reached`: the action
 *     landed, never start a second runner;
 *   - successor bound + provably not started (no row / pending-only / dead
 *     window) → `retry_safe`: re-driving with the SAME pre-bound execId is
 *     idempotent — the Bridge's find-or-create converges to exactly one
 *     started execution;
 *   - unprovable (CommDB lookup error / thrown probe) → `needs_reconfirm`
 *     (fail-closed; a blind re-drive could start a second runner).
 */

import type { StartedEvidence } from "../../../bridge/started-evidence.js";
import type {
	LifecycleRequestRecord,
	PostconditionVerdict,
} from "./lifecycle-requests.js";

export interface RetryDispatchPostconditionDeps {
	/** Authoritative started-evidence check (bridge/started-evidence.ts;
	 * injectable for tests). */
	checkEvidence: (
		executionId: string,
		projectName: string,
	) => Promise<StartedEvidence>;
}

export function makeRetryDispatchPostcondition(
	deps: RetryDispatchPostconditionDeps,
): (row: LifecycleRequestRecord) => Promise<PostconditionVerdict> {
	return async (row: LifecycleRequestRecord) => {
		if (!row.successorExecId) {
			return "retry_safe";
		}
		let evidence: StartedEvidence;
		try {
			evidence = await deps.checkEvidence(row.successorExecId, row.project);
		} catch {
			return "needs_reconfirm";
		}
		if (evidence.started) {
			return "reached";
		}
		if (evidence.reason === "lookup_error") {
			return "needs_reconfirm";
		}
		return "retry_safe";
	};
}
