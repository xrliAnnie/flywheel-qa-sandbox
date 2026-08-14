import type { CommDB } from "flywheel-comm/db";
import {
	createFounderReviewStateReader,
	type FounderReviewStateReader,
} from "flywheel-comm/founder-review";
import type { StateStore } from "../StateStore.js";

export function createStateStoreFounderReviewStateReader(input: {
	store: StateStore;
	commDb: CommDB;
}): FounderReviewStateReader {
	return createFounderReviewStateReader({
		db: input.commDb,
		locator: {
			listDeliveredRoundsForRun: (runId) =>
				input.store.listFounderReviewCardBindingsForRun(runId).map((row) => ({
					questionId: row.question_id,
					runId: row.run_id,
					artifactDigest: row.artifact_digest,
				})),
			getExecutionRunId: (executionId) =>
				input.store.getWorkflowExecutionBinding(executionId)?.run_id,
		},
	});
}
