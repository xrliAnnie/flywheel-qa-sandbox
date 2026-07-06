/**
 * FLY-827: codex_review_result event body builder.
 */

import { describe, expect, it } from "vitest";
import { buildCodexReviewResultBody } from "../commands/codex-review-result.js";

const SHA = "a".repeat(40);

describe("buildCodexReviewResultBody", () => {
	it("builds a well-formed code verdict (lower-cased head, required fields)", () => {
		const body = buildCodexReviewResultBody({
			execId: "exec-1",
			issueId: "FLY-1",
			projectName: "proj",
			prHeadSha: SHA.toUpperCase(),
			reviewedTarget: "https://github.com/x/y/pull/1",
			rounds: 3,
			codexThreadId: "thread-1",
			eventId: "evt-1",
		});
		expect(body.event_type).toBe("codex_review_result");
		expect(body.execution_id).toBe("exec-1");
		expect(body.issue_id).toBe("FLY-1");
		expect(body.project_name).toBe("proj");
		expect(body.event_id).toBe("evt-1");
		expect(body.payload).toEqual({
			reviewType: "code",
			status: "APPROVED",
			targetExecutionId: "exec-1",
			prHeadSha: SHA, // lower-cased
			reviewedTarget: "https://github.com/x/y/pull/1",
			rounds: 3,
			codexThreadId: "thread-1",
		});
	});

	it("omits optional fields when absent + generates an event id", () => {
		const body = buildCodexReviewResultBody({
			execId: "exec-1",
			issueId: "FLY-1",
			projectName: "proj",
			prHeadSha: SHA,
		});
		expect(body.event_id).toMatch(/[0-9a-f-]{36}/);
		expect(body.payload.reviewedTarget).toBeUndefined();
		expect(body.payload.rounds).toBeUndefined();
		expect(body.payload.codexThreadId).toBeUndefined();
		expect(body.payload.prHeadSha).toBe(SHA);
	});
});
