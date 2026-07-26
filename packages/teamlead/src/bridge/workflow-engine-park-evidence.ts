import type { CommDB } from "flywheel-comm/db";
import type { StateStore } from "../StateStore.js";

/**
 * StateStore is the activation authority; CommDB is only a projection. Both
 * sides must identify the same open activation and generation before a park
 * may authorize a runner wake.
 */
export function isExactCurrentWorkflowEnginePark(
	store: StateStore,
	db: CommDB,
	projectName: string,
	executionId: string,
): boolean {
	const evidence = store.getCurrentWorkflowEngineParkEvidence(executionId);
	if (!evidence || evidence.project_name !== projectName) return false;
	const projection = db.getWorkflowEnginePark(executionId);
	return (
		projection?.state === "open" &&
		projection.run_id === evidence.run_id &&
		projection.node_id === evidence.node_id &&
		projection.attempt === evidence.attempt &&
		projection.activation_id === evidence.activation_id &&
		projection.generation === evidence.generation &&
		projection.source_row_id === evidence.row_id
	);
}
