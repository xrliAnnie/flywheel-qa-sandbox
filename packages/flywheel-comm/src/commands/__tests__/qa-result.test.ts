import { describe, expect, it } from "vitest";
import { buildQaResultBody } from "../qa-result.js";

/**
 * FLY-579 P1: the QA verdict event body. Field-aligned with the Bridge
 * consumer (event-route.ts event_type === "qa_result" → onQaResult).
 */
describe("buildQaResultBody", () => {
	it("builds a pass verdict event keyed to the QA exec, targeting the parent", () => {
		const body = buildQaResultBody({
			status: "pass",
			qaExecutionId: "qa-1",
			targetExecutionId: "main-1",
			issueId: "FLY-9",
			projectName: "proj",
			prHeadSha: "f".repeat(40),
			summary: "verified the flow end to end",
			eventId: "evt-1",
		});
		expect(body).toEqual({
			event_id: "evt-1",
			execution_id: "qa-1",
			issue_id: "FLY-9",
			project_name: "proj",
			event_type: "qa_result",
			source: "flywheel-comm",
			payload: {
				status: "pass",
				targetExecutionId: "main-1",
				qaExecutionId: "qa-1",
				prHeadSha: "f".repeat(40),
				summary: "verified the flow end to end",
			},
		});
	});

	it("omits optional prHeadSha/summary when absent", () => {
		const body = buildQaResultBody({
			status: "fail",
			qaExecutionId: "qa-2",
			targetExecutionId: "main-2",
			issueId: "FLY-9",
			projectName: "proj",
			eventId: "evt-2",
		});
		expect(body.payload).toEqual({
			status: "fail",
			targetExecutionId: "main-2",
			qaExecutionId: "qa-2",
		});
		expect("prHeadSha" in body.payload).toBe(false);
		expect("summary" in body.payload).toBe(false);
	});

	it("the QA exec is the event execution_id (not the parent) — so it links to the QA session", () => {
		const body = buildQaResultBody({
			status: "pass",
			qaExecutionId: "qa-3",
			targetExecutionId: "main-3",
			issueId: "FLY-9",
			projectName: "proj",
		});
		expect(body.execution_id).toBe("qa-3");
		expect(body.payload.targetExecutionId).toBe("main-3");
		expect(body.event_id).toBeTruthy();
	});
});
