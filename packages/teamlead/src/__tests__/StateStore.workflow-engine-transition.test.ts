import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { loadBundledWorkflowSeeds } from "../workflow-template.js";

const engineFlags = {
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
};

async function engineRun(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	const seed = loadBundledWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1307",
		projectName: "flywheel",
		taskCategory: "code",
		claimsReadEnrolled: false,
		actor: "lead",
		startReservation: {
			idempotencyKey: "start-1",
			selectionDigest: "selection-1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-07-16T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	return store;
}

function advance(
	store: StateStore,
	input: {
		nodeId: string;
		attempt: number;
		executionId: string;
		outcome: "design_done" | "implement_done" | "qa_pass" | "qa_fail";
		successorExecutionId?: string;
	},
) {
	return store.commitWorkflowTransitionTx({
		runId: "run-1",
		...input,
		now: "2026-07-16T01:00:00.000Z",
	});
}

describe("engine-owned snapshot transition transaction", () => {
	it("commits completion and the selected successor in one idempotent operation", async () => {
		const store = await engineRun();
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "design",
			executionId: "design-1",
			attempt: 1,
			expiresAt: "2026-07-16T02:00:00.000Z",
			absoluteDeadlineAt: "2026-07-16T03:00:00.000Z",
			now: "2026-07-16T01:00:00.000Z",
			env: engineFlags,
		});
		expect(admitted).toMatchObject({ ok: true, idempotentReplay: false });

		const completed = store.commitEnrolledCompletion({
			executionId: "design-1",
			route: "phase_design_complete",
			sourceEventId: "complete-design-1",
			completionSubmission: { decision: { route: "phase_design_complete" } },
			now: "2026-07-16T01:05:00.000Z",
		});
		expect(completed).toMatchObject({ ok: true, idempotentReplay: false });
		const intents = store.listWorkflowSideEffects("run-1");
		expect(intents).toHaveLength(1);
		expect(intents[0]).toMatchObject({
			kind: "dispatch",
			node_id: "implement",
			attempt: 1,
			execution_id: expect.any(String),
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "edge_traversed"),
		).toHaveLength(1);

		expect(
			store.commitEnrolledCompletion({
				executionId: "design-1",
				route: "phase_design_complete",
				sourceEventId: "complete-design-retry",
				completionSubmission: {
					decision: { route: "phase_design_complete" },
				},
				now: "2026-07-16T01:06:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: true });
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(1);
		store.close();
	});

	it("admits only the engine-reserved successor execution", async () => {
		const store = await engineRun();
		const transition = advance(store, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
		expect(transition.ok).toBe(true);

		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "implement",
				executionId: "forged-implement",
				attempt: 1,
				expiresAt: "2026-07-16T02:00:00.000Z",
				absoluteDeadlineAt: "2026-07-16T03:00:00.000Z",
				now: "2026-07-16T01:05:00.000Z",
				env: engineFlags,
			}),
		).toMatchObject({ ok: false, reason: "successor_not_reserved" });
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "implement",
				executionId: "implement-1",
				attempt: 1,
				expiresAt: "2026-07-16T02:00:00.000Z",
				absoluteDeadlineAt: "2026-07-16T03:00:00.000Z",
				now: "2026-07-16T01:05:00.000Z",
				env: engineFlags,
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		expect(store.getWorkflowExecutionBinding("implement-1")).toMatchObject({
			run_id: "run-1",
			node_id: "implement",
			attempt: 1,
		});
		store.close();
	});

	it("atomically commits one legal edge and one durable successor intent with exact replay", async () => {
		const store = await engineRun();
		const first = advance(store, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
		expect(first).toMatchObject({
			ok: true,
			idempotentReplay: false,
			edgeId: "design_done",
			targetNodeId: "implement",
			targetAttempt: 1,
			successorExecutionId: "implement-1",
		});
		expect(store.getWorkflowRunNode("run-1", "design", 1)?.state).toBe("done");
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "pending",
			execution_id: "implement-1",
		});
		expect(store.listWorkflowSideEffects("run-1")).toMatchObject([
			{
				kind: "dispatch",
				node_id: "implement",
				attempt: 1,
				execution_id: "implement-1",
				state: "intent_recorded",
			},
		]);

		const replay = advance(store, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
		expect(replay).toMatchObject({ ok: true, idempotentReplay: true });
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "edge_traversed"),
		).toHaveLength(1);
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(1);
		store.close();
	});

	it("interprets qa_fail as a bounded first-class loop and qa_pass as the gate edge", async () => {
		const store = await engineRun();
		advance(store, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
		advance(store, {
			nodeId: "implement",
			attempt: 1,
			executionId: "implement-1",
			outcome: "implement_done",
			successorExecutionId: "qa-1",
		});

		const loop = advance(store, {
			nodeId: "qa",
			attempt: 1,
			executionId: "qa-1",
			outcome: "qa_fail",
			successorExecutionId: "implement-2",
		});
		expect(loop).toMatchObject({
			ok: true,
			loopIteration: 1,
			edgeId: "qa_retry",
			targetNodeId: "implement",
			targetAttempt: 2,
		});

		advance(store, {
			nodeId: "implement",
			attempt: 2,
			executionId: "implement-2",
			outcome: "implement_done",
			successorExecutionId: "qa-2",
		});
		const gate = advance(store, {
			nodeId: "qa",
			attempt: 2,
			executionId: "qa-2",
			outcome: "qa_pass",
		});
		expect(gate).toMatchObject({
			ok: true,
			edgeId: "qa_pass",
			targetNodeId: "founder_gate",
			targetAttempt: 1,
			gateOpened: true,
		});
		expect(store.getWorkflowRunNode("run-1", "founder_gate", 1)?.state).toBe(
			"review",
		);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "gate_opened"),
		).toHaveLength(1);
		store.close();
	});

	it("atomically consumes a QA credential, writes the claim, and advances its loop", async () => {
		const store = await engineRun();
		advance(store, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
		advance(store, {
			nodeId: "implement",
			attempt: 1,
			executionId: "implement-1",
			outcome: "implement_done",
			successorExecutionId: "qa-1",
		});
		const admission = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "qa",
			executionId: "qa-1",
			attempt: 1,
			expiresAt: "2026-07-16T02:00:00.000Z",
			absoluteDeadlineAt: "2026-07-16T03:00:00.000Z",
			now: "2026-07-16T01:00:00.000Z",
			env: engineFlags,
		});
		expect(admission).toMatchObject({
			ok: true,
			submissionCredential: expect.any(String),
		});
		if (!admission.ok || !admission.submissionCredential) {
			throw new Error("QA admission failed");
		}
		const submission = {
			credential: admission.submissionCredential,
			clientRequestId: "qa-result-1",
			predicate: "qa_failed",
			subjectDigest: "a".repeat(40),
			issuerVendor: "claude",
			issuerModel: "claude-opus-4-8",
			subjectProducerExecutionId: "implement-1",
			subjectProducerVendor: "codex",
			claimExpiresAt: "2026-07-16T02:00:00.000Z",
			now: "2026-07-16T01:05:00.000Z",
		};
		expect(store.submitWorkflowDecisionByCredential(submission)).toMatchObject({
			ok: true,
			idempotentReplay: false,
		});
		expect(store.getWorkflowRunNode("run-1", "implement", 2)).toMatchObject({
			state: "pending",
			execution_id: expect.any(String),
		});
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(3);
		expect(store.submitWorkflowDecisionByCredential(submission)).toMatchObject({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "edge_traversed"),
		).toHaveLength(3);
		store.close();
	});

	it("fails closed on an illegal outcome and on a competing successor writer", async () => {
		const store = await engineRun();
		expect(
			advance(store, {
				nodeId: "design",
				attempt: 1,
				executionId: "design-1",
				outcome: "qa_pass",
				successorExecutionId: "wrong",
			}),
		).toEqual({ ok: false, reason: "illegal_transition" });
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(0);

		expect(
			advance(store, {
				nodeId: "design",
				attempt: 1,
				executionId: "design-1",
				outcome: "design_done",
				successorExecutionId: "implement-winner",
			}).ok,
		).toBe(true);
		expect(
			advance(store, {
				nodeId: "design",
				attempt: 1,
				executionId: "design-1",
				outcome: "design_done",
				successorExecutionId: "implement-loser",
			}),
		).toEqual({ ok: false, reason: "transition_conflict" });
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(1);
		store.close();
	});

	it("refuses a legal edge from a node that is not the run's current node", async () => {
		const store = await engineRun();
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "qa",
			attempt: 1,
			state: "running",
			executionId: "forged-qa",
		});
		expect(
			advance(store, {
				nodeId: "qa",
				attempt: 1,
				executionId: "forged-qa",
				outcome: "qa_pass",
			}),
		).toEqual({ ok: false, reason: "node_attempt_not_current" });
		expect(store.getWorkflowRun("run-1")?.current_node_id).toBe("design");
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(0);
		store.close();
	});

	it("replays loop-limit escalation without reopening the held run", async () => {
		const store = await engineRun();
		advance(store, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			advance(store, {
				nodeId: "implement",
				attempt,
				executionId: `implement-${attempt}`,
				outcome: "implement_done",
				successorExecutionId: `qa-${attempt}`,
			});
			const result = advance(store, {
				nodeId: "qa",
				attempt,
				executionId: `qa-${attempt}`,
				outcome: "qa_fail",
				...(attempt <= 3
					? { successorExecutionId: `implement-${attempt + 1}` }
					: {}),
			});
			if (attempt === 4) {
				expect(result).toMatchObject({ ok: true, escalated: true });
				expect(
					advance(store, {
						nodeId: "qa",
						attempt,
						executionId: `qa-${attempt}`,
						outcome: "qa_fail",
					}),
				).toMatchObject({
					ok: true,
					idempotentReplay: true,
					escalated: true,
				});
			}
		}
		store.close();
	});
});
