import { describe, expect, it } from "vitest";
import { WORKFLOW_TRANSITIONS } from "../workflow-fsm.js";

describe("WORKFLOW_TRANSITIONS — FLY-793 design_done", () => {
	it("running can transition to design_done (three-stage Design phase handoff)", () => {
		expect(WORKFLOW_TRANSITIONS.running).toContain("design_done");
	});

	it("design_done is a non-terminal state with finalization/failure exits", () => {
		expect(WORKFLOW_TRANSITIONS.design_done).toEqual([
			"completed",
			"blocked",
			"failed",
			"terminated",
		]);
	});

	it("byte-compat: running keeps all its prior targets", () => {
		for (const t of [
			"awaiting_review",
			"completed",
			"blocked",
			"failed",
			"terminated",
		]) {
			expect(WORKFLOW_TRANSITIONS.running).toContain(t);
		}
	});

	it("byte-compat: existing terminal states unchanged", () => {
		expect(WORKFLOW_TRANSITIONS.completed).toEqual([]);
		// FLY-945 Fix C intentionally added awaiting_review (review re-request
		// after an expired approval); the pre-existing targets are unchanged.
		expect(WORKFLOW_TRANSITIONS.approved_to_ship).toEqual([
			"awaiting_review",
			"completed",
			"blocked",
			"failed",
			"terminated",
		]);
	});
});
