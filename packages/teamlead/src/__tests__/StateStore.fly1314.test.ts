import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-1314 codex review question lookup", () => {
	it("returns the latest tip of one moved-head lineage", async () => {
		const store = await StateStore.create(":memory:");
		store.insertCodexReviewJob({
			requestId: "request-root",
			executionId: "exec-1",
			issueId: "FLY-2228",
			projectName: "flywheel",
			reviewType: "code",
			questionId: "question-1",
			frozenHeadSha: "a".repeat(40),
		});
		store.claimCodexReviewJobRunning("request-root");
		store.failAndRequeueCodexReviewJobForHeadMove({
			requestId: "request-root",
			successorRequestId: "request-tip",
			currentHeadSha: "b".repeat(40),
		});

		expect(store.getCodexReviewJobByQuestionId("question-1")).toMatchObject({
			request_id: "request-tip",
			head_move_parent_request_id: "request-root",
			status: "pending",
		});
	});

	it("returns one deterministic job and fails open on duplicate question bindings", async () => {
		const store = await StateStore.create(":memory:");
		store.insertCodexReviewJob({
			requestId: "request-1",
			executionId: "exec-1",
			issueId: "FLY-1314",
			projectName: "flywheel",
			reviewType: "code",
			questionId: "question-1",
		});
		expect(store.getCodexReviewJobByQuestionId("question-1")).toMatchObject({
			request_id: "request-1",
			issue_id: "FLY-1314",
		});

		store.insertCodexReviewJob({
			requestId: "request-2",
			executionId: "exec-2",
			issueId: "FLY-OTHER",
			projectName: "flywheel",
			reviewType: "code",
			questionId: "question-1",
		});
		expect(store.getCodexReviewJobByQuestionId("question-1")).toBeNull();
	});
});
