import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

const BASE = {
	threadId: "thread-1448",
	msgId: "msg-1448",
	questionId: "question-a",
	projectName: "flywheel",
	leadId: "flywheel-eng-lead",
	executionId: "exec-a",
	disposedAtMs: 1_000,
	deadlineAtMs: 181_000,
} as const;

describe("StateStore founder decision convergence", () => {
	it("creates one durable intent per thread/message/question without resetting it", async () => {
		const store = await freshStore();

		expect(store.ensureFounderDecisionConvergence(BASE)).toMatchObject({
			created: true,
			row: {
				classification: "none",
				resolved_at_ms: null,
				alerted_at_ms: null,
			},
		});
		expect(
			store.ensureFounderDecisionConvergence({
				...BASE,
				deadlineAtMs: 999_000,
			}),
		).toMatchObject({
			created: false,
			row: { deadline_at_ms: 181_000 },
		});
	});

	it("classifies and resolves each candidate question independently", async () => {
		const store = await freshStore();
		store.ensureFounderDecisionConvergence(BASE);
		store.ensureFounderDecisionConvergence({
			...BASE,
			questionId: "question-b",
			executionId: "exec-b",
		});

		store.classifyFounderDecisionConvergence({
			threadId: BASE.threadId,
			msgId: BASE.msgId,
			questionId: BASE.questionId,
			classification: "approve",
			cardReferenceValid: true,
		});
		store.resolveFounderDecisionConvergence({
			threadId: BASE.threadId,
			msgId: BASE.msgId,
			questionId: BASE.questionId,
			resolution: "response",
			resolvedAtMs: 2_000,
		});

		expect(store.listFounderDecisionConvergence()).toEqual([
			expect.objectContaining({
				question_id: "question-a",
				classification: "approve",
				card_reference_valid: 1,
				resolution: "response",
			}),
			expect.objectContaining({
				question_id: "question-b",
				classification: "none",
				resolution: null,
			}),
		]);
	});

	it("claims one overdue definite decision for alerting but never claims unclear chat", async () => {
		const store = await freshStore();
		for (const [questionId, classification] of [
			["question-a", "reject"],
			["question-b", "unclear"],
		] as const) {
			store.ensureFounderDecisionConvergence({
				...BASE,
				questionId,
				executionId: `exec-${questionId}`,
			});
			store.classifyFounderDecisionConvergence({
				threadId: BASE.threadId,
				msgId: BASE.msgId,
				questionId,
				classification,
				cardReferenceValid: false,
			});
		}

		expect(store.claimOverdueFounderDecisionAlerts(181_001)).toEqual([
			expect.objectContaining({
				question_id: "question-a",
				classification: "reject",
				alerted_at_ms: 181_001,
			}),
		]);
		expect(store.claimOverdueFounderDecisionAlerts(181_002)).toEqual([]);
		expect(
			store
				.listFounderDecisionConvergence()
				.find((row) => row.question_id === "question-b")?.alerted_at_ms,
		).toBeNull();
	});
});
