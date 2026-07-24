import { describe, expect, it } from "vitest";
import {
	ACTION_DEFINITIONS,
	WORKFLOW_TRANSITIONS,
	WorkflowFSM,
} from "../workflow-fsm.js";

describe("FLY-1441 ship_parked lifecycle", () => {
	const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);

	it("separates pre-Gate parking, Gate review, feedback rework, and terminal disposal", () => {
		expect(fsm.canTransition("running", "ship_parked")).toBe(true);
		expect(fsm.canTransition("ship_parked", "awaiting_review")).toBe(true);
		expect(fsm.canTransition("awaiting_review", "ship_parked")).toBe(true);
		expect(fsm.canTransition("ship_parked", "running")).toBe(true);
		expect(fsm.canTransition("ship_parked", "completed")).toBe(true);
		expect(fsm.canTransition("ship_parked", "terminated")).toBe(true);
		expect(fsm.isTerminal("ship_parked")).toBe(false);
	});

	it("allows manual termination without making ship_parked founder-review eligible", () => {
		const terminate = ACTION_DEFINITIONS.find(
			(definition) => definition.action === "terminate",
		);
		const approve = ACTION_DEFINITIONS.find(
			(definition) => definition.action === "approve",
		);
		expect(terminate?.fromStates).toContain("ship_parked");
		expect(approve?.fromStates).not.toContain("ship_parked");
	});
});
