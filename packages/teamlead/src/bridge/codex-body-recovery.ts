import type { Session, StateStore } from "../StateStore.js";

type RecoveryBodyStore = Pick<
	StateStore,
	| "getSession"
	| "getWorkflowExecutionProcessBody"
	| "getWorkflowRunNodeForExecution"
	| "getWorkflowRun"
	| "listWorkflowRunNodes"
	| "hasCurrentCodexRecoveryExhaustion"
>;
const RECOVERABLE = new Set([
	"running",
	"ship_parked",
	"awaiting_review",
	"design_done",
	"approved_to_ship",
]);

/** Match the existing reowner's binding and intentional-retirement boundary.
 * An unclaimed first attempt still has priority. Runtime unavailability and
 * failed database reads cannot spend the recovery budget or authorize death. */
export function codexBodyRecoveryPending(
	store: RecoveryBodyStore,
	executionId: string,
	nowMs: number,
	isExcluded?: (session: Session) => boolean,
): boolean {
	try {
		const session = store.getSession(executionId);
		if (
			!session ||
			session.adapter_type !== "codex-tmux" ||
			!RECOVERABLE.has(session.status) ||
			session.retry_successor ||
			isExcluded?.(session)
		)
			return false;
		const body = store.getWorkflowExecutionProcessBody(executionId)?.state;
		if (body === "retiring" || body === "standby" || body === "resuming")
			return false;
		const binding = store.getWorkflowRunNodeForExecution(executionId);
		if (binding) {
			const latest = store
				.listWorkflowRunNodes(binding.run_id, binding.node_id)
				.at(-1);
			if (
				store.getWorkflowRun(binding.run_id)?.status !== "active" ||
				latest?.attempt !== binding.attempt ||
				latest.execution_id !== executionId
			)
				return false;
		}
		return !store.hasCurrentCodexRecoveryExhaustion(executionId, nowMs);
	} catch {
		return true;
	}
}
