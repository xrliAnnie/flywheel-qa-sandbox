import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-1314 codex review question lookup", () => {
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

describe("FLY-1314 immutable three-stage verdict-head ledger", () => {
	it("returns one scoped mapping and fails open when multiple rounds make it ambiguous", async () => {
		const store = await StateStore.create(":memory:");
		store.recordThreeStageVerdictHead({
			qaExecutionId: "qa-1",
			issueId: "FLY-1314",
			projectName: "flywheel",
			verdictEventId: "verdict-1",
			round: 1,
			verdictHead: "a".repeat(40),
		});
		expect(
			store.getUnambiguousThreeStageVerdictHead("qa-1", "FLY-1314"),
		).toMatchObject({
			verdictEventId: "verdict-1",
			round: 1,
			verdictHead: "a".repeat(40),
		});

		store.recordThreeStageVerdictHead({
			qaExecutionId: "qa-1",
			issueId: "FLY-1314",
			projectName: "flywheel",
			verdictEventId: "verdict-2",
			round: 2,
			verdictHead: "b".repeat(40),
		});
		expect(
			store.getUnambiguousThreeStageVerdictHead("qa-1", "FLY-1314"),
		).toBeNull();
		expect(
			store.getUnambiguousThreeStageVerdictHead("qa-1", "OTHER"),
		).toBeNull();
		expect(
			store.getUnambiguousThreeStageVerdictHead("qa-other", "FLY-1314"),
		).toBeNull();
	});

	it("is idempotent for the same verdict event and preserves the original head", async () => {
		const store = await StateStore.create(":memory:");
		const args = {
			qaExecutionId: "qa-1",
			issueId: "FLY-1314",
			projectName: "flywheel",
			verdictEventId: "verdict-1",
			round: 1,
			verdictHead: "a".repeat(40),
		};
		expect(store.recordThreeStageVerdictHead(args)).toBe(true);
		expect(
			store.recordThreeStageVerdictHead({
				...args,
				verdictHead: "b".repeat(40),
			}),
		).toBe(false);
		expect(
			store.getUnambiguousThreeStageVerdictHead("qa-1", "FLY-1314"),
		).toMatchObject({ verdictHead: "a".repeat(40) });
	});
});
