/**
 * FLY-827: codex_review_result event body builder.
 */

import { describe, expect, it } from "vitest";
import {
	buildCodexReviewFailureMarker,
	buildCodexReviewResultBody,
} from "../commands/codex-review-result.js";

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

it("keeps failed-delivery markers opaque", () => {
	const marker = buildCodexReviewFailureMarker({
		execId: "exec-1",
		requestId: "evt-1",
		body: { codexThreadId: "private-thread", reviewedTarget: "private-url" },
		lastError: "Bridge returned 503",
		timestamp: "2026-07-14T00:00:00.000Z",
	});
	expect(marker).toMatchObject({
		execution_id: "exec-1",
		client_request_id: "evt-1",
		body_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
	});
	expect(JSON.stringify(marker)).not.toContain("private-thread");
	expect(JSON.stringify(marker)).not.toContain("private-url");
});
