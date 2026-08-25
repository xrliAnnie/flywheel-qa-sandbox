import { describe, expect, it } from "vitest";
import { isRunnerStopReport } from "../runner-stop-report.js";

describe("isRunnerStopReport", () => {
	const trusted = {
		id: `rstop-${"a".repeat(32)}`,
		kind: "report",
		content:
			"RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-2017 exec=exec-1 route=- detail=parked",
	};

	it("requires the complete trusted triple", () => {
		expect(isRunnerStopReport(trusted)).toBe(true);
		expect(isRunnerStopReport({ ...trusted, id: "rstop-near-match" })).toBe(
			false,
		);
		expect(isRunnerStopReport({ ...trusted, kind: "question" })).toBe(false);
		expect(
			isRunnerStopReport({ ...trusted, content: "RUNNER-STOPPED truncated" }),
		).toBe(false);
	});
});
