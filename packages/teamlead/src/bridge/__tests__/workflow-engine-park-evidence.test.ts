import { CommDB } from "flywheel-comm/db";
import { describe, expect, it } from "vitest";
import type {
	StateStore,
	WorkflowEngineParkOutboxRow,
} from "../../StateStore.js";
import { isExactCurrentWorkflowEnginePark } from "../workflow-engine-park-evidence.js";

const EVIDENCE: WorkflowEngineParkOutboxRow = {
	row_id: 2,
	event_id: "park-opened",
	project_name: "flywheel",
	execution_id: "exec-1",
	run_id: "run-1",
	node_id: "implement",
	attempt: 1,
	activation_id: "activation-1",
	generation: 2,
	event: "park_opened",
	reason: "waiting",
	created_at: "2026-07-24T00:00:00.000Z",
};

describe("exact current workflow engine park evidence", () => {
	it("requires the CommDB projection to match every StateStore activation field and generation", () => {
		const db = new CommDB(":memory:");
		const store = {
			getCurrentWorkflowEngineParkEvidence: () => EVIDENCE,
		} as unknown as StateStore;
		db.applyWorkflowEngineParkEvents("flywheel", [EVIDENCE]);

		expect(
			isExactCurrentWorkflowEnginePark(store, db, "flywheel", "exec-1"),
		).toBe(true);

		db.applyWorkflowEngineParkEvents("flywheel", [
			{
				...EVIDENCE,
				row_id: 3,
				event_id: "stale-other-activation",
				activation_id: "activation-2",
				generation: 3,
			},
		]);
		expect(
			isExactCurrentWorkflowEnginePark(store, db, "flywheel", "exec-1"),
		).toBe(false);
		db.close();
	});
});
