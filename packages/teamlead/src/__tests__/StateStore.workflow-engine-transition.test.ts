import { canonicalSubmissionDigest } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { loadBundledWorkflowSeeds } from "../workflow-template.js";

const engineFlags = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

async function engineRun(
	options: { gateCarrier?: boolean } = {},
): Promise<StateStore> {
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
		claimsReadEnrolled: true,
		actor: "lead",
		env: {
			...engineFlags,
			...(options.gateCarrier ? { FLYWHEEL_WORKFLOW_GATE_CARRIER: "1" } : {}),
		},
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

async function openRunnerShipGate(
	store: StateStore,
	options: { forceUnbound?: boolean } = {},
) {
	advance(store, {
		nodeId: "design",
		attempt: 1,
		executionId: "design-1",
		outcome: "design_done",
		successorExecutionId: "implement-1",
	});
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
	).toMatchObject({ ok: true });
	expect(
		store.commitEnrolledCompletion({
			executionId: "implement-1",
			route: "needs_review",
			sourceEventId: "complete-implement-for-helper",
			completionSubmission: { decision: { route: "needs_review" } },
			subjectDigest: "a".repeat(40),
			now: "2026-07-16T01:10:00.000Z",
		}),
	).toMatchObject({ ok: true });
	const qaIntent = store
		.listWorkflowSideEffects("run-1")
		.find((effect) => effect.node_id === "qa");
	const qaAdmission = store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: "qa",
		executionId: qaIntent!.execution_id,
		attempt: 1,
		expiresAt: "2026-07-16T02:00:00.000Z",
		absoluteDeadlineAt: "2026-07-16T03:00:00.000Z",
		now: "2026-07-16T01:12:00.000Z",
		env: engineFlags,
	});
	if (!qaAdmission.ok || !qaAdmission.submissionCredential) {
		throw new Error("QA admission failed");
	}
	if (options.forceUnbound) {
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
		});
	}
	expect(
		store.submitWorkflowDecisionByCredential({
			credential: qaAdmission.submissionCredential,
			clientRequestId: "qa-pass-helper",
			predicate: "qa_passed",
			subjectDigest: "a".repeat(40),
			issuerVendor: "claude",
			issuerModel: "claude-opus-4-8",
			subjectProducerExecutionId: "implement-1",
			subjectProducerVendor: "codex",
			claimExpiresAt: "2026-07-16T02:00:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: "2026-07-16T01:15:00.000Z",
		}),
	).toMatchObject({ ok: true });
	return store.getCurrentWorkflowGateHolder("run-1", "founder_gate")!;
}

describe("engine-owned snapshot transition transaction", () => {
	it("exposes park evidence only for the exact current activation and generation", async () => {
		const store = await engineRun();
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "design",
				executionId: "design-1",
				attempt: 1,
				expiresAt: "2026-07-16T02:00:00.000Z",
				absoluteDeadlineAt: "2026-07-16T03:00:00.000Z",
				now: "2026-07-16T01:00:00.000Z",
				env: engineFlags,
			}),
		).toMatchObject({ ok: true });
		const activation = store.resolveCurrentWorkflowActivation("design-1");
		expect(activation.kind).toBe("current");
		if (activation.kind !== "current") throw new Error("activation missing");
		const opened = store.appendWorkflowEngineParkEvent({
			eventId: "park-design-1",
			projectName: "flywheel",
			executionId: "design-1",
			runId: activation.binding.run_id,
			nodeId: activation.binding.node_id,
			attempt: activation.binding.attempt,
			activationId: activation.binding.activation_id,
			event: "park_opened",
			reason: "waiting",
		});

		expect(store.getCurrentWorkflowEngineParkEvidence("design-1")).toEqual(
			opened,
		);

		store.appendWorkflowEngineParkEvent({
			eventId: "clear-design-1",
			projectName: "flywheel",
			executionId: "design-1",
			runId: activation.binding.run_id,
			nodeId: activation.binding.node_id,
			attempt: activation.binding.attempt,
			activationId: activation.binding.activation_id,
			event: "park_cleared",
			reason: "resumed",
		});
		expect(
			store.getCurrentWorkflowEngineParkEvidence("design-1"),
		).toBeUndefined();
		store.close();
	});

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

	it("parks a ship-capable epoch-1 execution without opening founder review before the Gate", async () => {
		const store = await engineRun({ gateCarrier: true });
		advance(store, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
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
		).toMatchObject({ ok: true });

		expect(
			store.commitEnrolledCompletion({
				executionId: "implement-1",
				route: "needs_review",
				sourceEventId: "complete-implement-1",
				completionSubmission: { decision: { route: "needs_review" } },
				subjectDigest: "a".repeat(40),
				now: "2026-07-16T01:10:00.000Z",
			}),
		).toMatchObject({ ok: true });

		expect(store.getSession("implement-1")?.status).toBe("ship_parked");
		expect(store.getSession("implement-1")?.review_question_id).toBeUndefined();
		expect(store.getWorkflowRun("run-1")?.current_node_id).toBe("qa");
		expect(store.getCurrentWorkflowGateHolder("run-1", "founder_gate")).toBe(
			undefined,
		);
		expect(
			store.workflowGatePresentationDisposition({
				executionId: "implement-1",
				checkpoint: "approve_to_ship",
				questionId: "runner-opened-too-early",
			}),
		).toEqual({ allow: false, reason: "before_gate" });
		expect(
			store.workflowGatePresentationDisposition({
				executionId: "implement-1",
				checkpoint: "question",
				questionId: "ordinary-question",
			}),
		).toEqual({ allow: true, reason: "non_ship" });
		store.close();
	});

	it("atomically binds the parked ship actor and freezes QA proof when the run reaches Gate", async () => {
		const store = await engineRun({ gateCarrier: true });
		advance(store, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
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
		).toMatchObject({ ok: true });
		expect(
			store.commitEnrolledCompletion({
				executionId: "implement-1",
				route: "needs_review",
				sourceEventId: "complete-implement-for-gate",
				completionSubmission: { decision: { route: "needs_review" } },
				subjectDigest: "a".repeat(40),
				now: "2026-07-16T01:10:00.000Z",
			}),
		).toMatchObject({ ok: true });
		const qaIntent = store
			.listWorkflowSideEffects("run-1")
			.find((effect) => effect.node_id === "qa");
		expect(qaIntent?.execution_id).toEqual(expect.any(String));
		const qaAdmission = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "qa",
			executionId: qaIntent!.execution_id,
			attempt: 1,
			expiresAt: "2026-07-16T02:00:00.000Z",
			absoluteDeadlineAt: "2026-07-16T03:00:00.000Z",
			now: "2026-07-16T01:12:00.000Z",
			env: engineFlags,
		});
		expect(qaAdmission).toMatchObject({
			ok: true,
			submissionCredential: expect.any(String),
		});
		if (!qaAdmission.ok || !qaAdmission.submissionCredential) {
			throw new Error("QA admission failed");
		}
		expect(
			store.submitWorkflowDecisionByCredential({
				credential: qaAdmission.submissionCredential,
				clientRequestId: "qa-pass-opens-gate",
				predicate: "qa_passed",
				subjectDigest: "a".repeat(40),
				issuerVendor: "claude",
				issuerModel: "claude-opus-4-8",
				subjectProducerExecutionId: "implement-1",
				subjectProducerVendor: "codex",
				claimExpiresAt: "2026-07-16T02:00:00.000Z",
				now: "2026-07-16T01:15:00.000Z",
			}),
		).toMatchObject({ ok: true });

		const holder = store.getCurrentWorkflowGateHolder("run-1", "founder_gate");
		expect(holder).toMatchObject({
			authority_mode: "runner_ship",
			subject_kind: "git_head",
			carrier_binding_state: "bound",
			source_execution_id: "implement-1",
			head_sha: "a".repeat(40),
			state: "materializing",
			materialization_stage: "question_intent",
		});
		expect(store.getSession("implement-1")).toMatchObject({
			status: "awaiting_review",
			review_question_id: holder!.question_id,
			pr_head_sha: "a".repeat(40),
			awaiting_review_entered_at: "2026-07-16T01:15:00.000Z",
		});
		expect(store.listWorkflowGateHolderEvidence(holder!)).toMatchObject([
			{
				predicate: "qa_passed",
				decision_kind: "qa_verdict",
				node_id: "qa",
				node_attempt: 1,
				subject_kind: "git_head",
				subject_digest: "a".repeat(40),
			},
		]);
		expect(
			store.workflowGatePresentationDisposition({
				executionId: "implement-1",
				checkpoint: "approve_to_ship",
				questionId: holder!.question_id,
			}),
		).toEqual({ allow: true, reason: "holder_authoritative" });
		expect(
			store.workflowGatePresentationDisposition({
				executionId: "implement-1",
				checkpoint: "approve_to_ship",
				questionId: "rogue-runner-question",
			}),
		).toEqual({ allow: false, reason: "holder_mismatch" });
		expect(store.listWorkflowGateHoldersForMaterialization()).toHaveLength(1);
		expect(store.listRunnerShipHoldersForMergeProbe()).toMatchObject([
			{
				runId: "run-1",
				gateNodeId: "founder_gate",
				attempt: 1,
				questionId: holder!.question_id,
				holderState: "materializing",
				subjectDigest: "a".repeat(40),
				sourceExecutionId: "implement-1",
			},
		]);
		expect(
			store.completeWorkflowGateRunAfterShip({
				questionId: holder!.question_id,
				mergedHead: "a".repeat(40),
				now: "2026-07-16T01:15:30.000Z",
			}),
		).toEqual({ ok: false, reason: "rogue_merge_before_approval" });
		const rogueAlert = {
			questionId: holder!.question_id,
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
			now: "2026-07-16T01:15:30.000Z",
		};
		expect(store.recordRunnerShipRogueMerge(rogueAlert)).toEqual({
			ok: true,
			idempotentReplay: false,
		});
		expect(store.recordRunnerShipRogueMerge(rogueAlert)).toEqual({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			store.listWorkflowAlertOutbox()[0]?.payload.metadata.workflowEngine
				.disposition,
		).toBe("runner_ship_merged_before_approval");
		for (const [stage, cardMessageId] of [
			["question_written"],
			["session_bound"],
			["card_posted", "founder-card-1"],
			["card_bound", "founder-card-1"],
			["completed", "founder-card-1"],
		] as const) {
			expect(
				store.advanceWorkflowGateHolderMaterialization({
					questionId: holder!.question_id,
					stage,
					...(cardMessageId ? { cardMessageId } : {}),
					now: "2026-07-16T01:16:00.000Z",
				}),
			).toMatchObject({ ok: true });
		}
		const founderPayload = {
			schema_version: 1,
			run_id: "run-1",
			issue_id: "FLY-1307",
			question_id: holder!.question_id,
			response: { approved: true },
			actor: "founder",
			approved_head: "a".repeat(40),
			classification: "founder_direct_signal",
			authority_id: holder!.question_id,
		};
		expect(
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId: "founder-approves-runner-ship",
				kind: "founder_approval",
				schemaVersion: 1,
				payloadJson: JSON.stringify(founderPayload),
				payloadDigest: canonicalSubmissionDigest(founderPayload),
			}),
		).toMatchObject({ kind: "founder_claim", status: "applied" });
		expect(
			store.getCurrentWorkflowGateHolder("run-1", "founder_gate"),
		).toMatchObject({ state: "approved", authority_mode: "runner_ship" });
		expect(store.getWorkflowRun("run-1")).toMatchObject({
			status: "active",
			current_node_id: "founder_gate",
		});
		expect(
			store.resolveEngineWorkflowShipClaims({
				runId: "run-1",
				subjectKind: "git_head",
				subjectDigest: "a".repeat(40),
				// Gate evidence survives the submission credential/claim TTL.
				now: "2026-07-18T01:15:00.000Z",
			}),
		).toEqual({ valid: true });
		expect(store.listRunnerShipHoldersForMergeProbe()).toMatchObject([
			{
				runId: "run-1",
				holderState: "approved",
				questionId: holder!.question_id,
			},
		]);
		expect(
			store.completeWorkflowGateRunAfterShip({
				questionId: holder!.question_id,
				mergedHead: "a".repeat(40),
				now: "2026-07-18T01:16:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(store.getWorkflowRun("run-1")).toMatchObject({
			status: "completed",
			current_node_id: "founder_gate",
		});
		expect(store.getWorkflowRunNode("run-1", "founder_gate", 1)).toMatchObject({
			state: "done",
		});
		expect(store.getSession("implement-1")?.status).toBe("completed");
		expect(store.listRunnerShipHoldersForMergeProbe()).toEqual([]);
		store.close();
	});

	it("removes runner review authority before founder feedback rework wakes", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store);
		for (const [stage, cardMessageId] of [
			["question_written"],
			["session_bound"],
			["card_posted", "founder-card-feedback"],
			["card_bound", "founder-card-feedback"],
			["completed", "founder-card-feedback"],
		] as const) {
			expect(
				store.advanceWorkflowGateHolderMaterialization({
					questionId: holder.question_id,
					stage,
					...(cardMessageId ? { cardMessageId } : {}),
					now: "2026-07-16T01:16:00.000Z",
				}),
			).toMatchObject({ ok: true });
		}
		const payload = {
			schema_version: 1,
			run_id: "run-1",
			issue_id: "FLY-1307",
			question_id: holder.question_id,
			response: {
				approved: false,
				feedback: "Please tighten the failure-path diagnostics.",
			},
			actor: "founder",
			approved_head: "a".repeat(40),
			classification: "founder_direct_signal",
			authority_id: holder.question_id,
		};
		expect(
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId: "founder-feedback-runner-ship",
				kind: "founder_feedback",
				schemaVersion: 1,
				payloadJson: JSON.stringify(payload),
				payloadDigest: canonicalSubmissionDigest(payload),
			}),
		).toMatchObject({ kind: "founder_feedback", status: "applied" });
		expect(store.getSession("implement-1")).toMatchObject({
			status: "ship_parked",
			review_question_id: undefined,
			awaiting_review_entered_at: undefined,
		});
		expect(
			store.getCurrentWorkflowGateHolder("run-1", "founder_gate"),
		).toBeUndefined();
		expect(store.getWorkflowRun("run-1")).toMatchObject({
			status: "active",
			current_node_id: "implement",
		});
		expect(store.getWorkflowRunNode("run-1", "implement", 2)).toMatchObject({
			state: "pending",
			execution_id: "implement-1",
		});
		expect(
			store.listWorkflowReworkDeliveries({ states: ["pending"] }),
		).toHaveLength(1);
		store.close();
	});

	it("atomically rebinds an unbound Gate carrier and replays without resetting its review window", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store, { forceUnbound: true });
		expect(holder).toMatchObject({
			authority_mode: "runner_ship",
			carrier_binding_state: "unbound",
			materialization_stage: "question_intent",
		});
		expect(store.listWorkflowAlertOutbox()).toEqual([
			expect.objectContaining({
				escalation_uid: `gate_carrier_unbound:${holder.question_id}`,
				run_id: "run-1",
				state: "pending",
				payload: expect.objectContaining({
					leadId: "flywheel-eng-lead",
					eventType: "workflow_engine_escalation",
					metadata: {
						workflowEngine: expect.objectContaining({
							runId: "run-1",
							issueId: "FLY-1307",
							nodeId: "founder_gate",
							executionId: expect.any(String),
							disposition: "gate_carrier_unbound",
							questionId: holder.question_id,
							subjectDigest: "a".repeat(40),
							rebind: {
								stage: "POST /api/workflow/gate-carrier-rebind/stage",
								apply: "POST /api/workflow/gate-carrier-rebind",
							},
						}),
					},
				}),
			}),
		]);
		expect(store.listWorkflowGateHoldersForMaterialization()).toEqual([]);
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "ship_parked",
		});
		const canonical = store.resolveWorkflowGateCarrierRebindCanonical(
			holder.question_id,
			"implement-1",
		);
		expect(canonical).toMatchObject({
			runId: "run-1",
			gateNodeId: "founder_gate",
			holderAttempt: 1,
			questionId: holder.question_id,
			candidateExecutionId: "implement-1",
			subjectDigest: "a".repeat(40),
			requestId: expect.stringMatching(/^gate-carrier-rebind:[0-9a-f]{64}$/),
		});
		if (!canonical) throw new Error("rebind canonical unavailable");
		const request = {
			requestId: canonical.requestId,
			questionId: holder.question_id,
			candidateExecutionId: "implement-1",
			canonicalDigest: canonicalSubmissionDigest(canonical),
			now: "2026-07-16T01:20:00.000Z",
		};
		expect(store.rebindWorkflowGateCarrier(request)).toMatchObject({
			ok: true,
			idempotentReplay: false,
			questionId: holder.question_id,
			sourceExecutionId: "implement-1",
		});
		expect(
			store.getWorkflowGateCarrierRebindReceipt(canonical.requestId),
		).toMatchObject({
			requestId: canonical.requestId,
			canonicalDigest: request.canonicalDigest,
			questionId: holder.question_id,
			runId: "run-1",
			gateNodeId: "founder_gate",
			holderAttempt: 1,
			sourceExecutionId: "implement-1",
			reviewWindowStartedAt: request.now,
		});
		expect(store.getSession("implement-1")).toMatchObject({
			status: "awaiting_review",
			review_question_id: holder.question_id,
			awaiting_review_entered_at: request.now,
		});
		expect(store.listWorkflowGateHoldersForMaterialization()).toHaveLength(1);
		expect(
			store.rebindWorkflowGateCarrier({
				...request,
				now: "2026-07-16T01:50:00.000Z",
			}),
		).toMatchObject({
			ok: true,
			idempotentReplay: true,
			reviewWindowStartedAt: request.now,
		});
		expect(store.getSession("implement-1")?.awaiting_review_entered_at).toBe(
			request.now,
		);
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
			executionId: "implement-1",
			outcome: "implement_done",
			successorExecutionId: "qa-1",
		});
		const gate = advance(store, {
			nodeId: "qa",
			attempt: 2,
			executionId: "qa-1",
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

	it("commits a staged non-founder loop reentry once and replays its immutable receipt", async () => {
		const store = await engineRun();
		advance(store, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "implement",
				executionId: "implement-1",
				attempt: 1,
				expiresAt: "2026-07-16T02:00:00.000Z",
				absoluteDeadlineAt: "2026-07-16T03:00:00.000Z",
				now: "2026-07-16T01:00:00.000Z",
				env: engineFlags,
			}),
		).toMatchObject({ ok: true });
		advance(store, {
			nodeId: "implement",
			attempt: 1,
			executionId: "implement-1",
			outcome: "implement_done",
			successorExecutionId: "qa-1",
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "qa",
				executionId: "qa-1",
				attempt: 1,
				expiresAt: "2026-07-16T02:00:00.000Z",
				absoluteDeadlineAt: "2026-07-16T03:00:00.000Z",
				now: "2026-07-16T01:05:00.000Z",
				env: engineFlags,
			}),
		).toMatchObject({ ok: true });

		const canonical = store.resolveWorkflowLoopReentryCanonical(
			"qa-1",
			"qa_retry",
		);
		expect(canonical).toMatchObject({
			runId: "run-1",
			sourceNodeId: "qa",
			sourceAttempt: 1,
			expectedIteration: 1,
			outcome: "qa_fail",
		});
		if (!canonical) throw new Error("loop canonical missing");
		const canonicalDigest = canonicalSubmissionDigest(canonical);
		const first = store.commitWorkflowLoopReentryRequest({
			canonical,
			canonicalDigest,
			tokenIdentity: "b".repeat(64),
			initiator: "qa-1",
			now: "2026-07-16T01:10:00.000Z",
		});
		expect(first).toMatchObject({
			ok: true,
			idempotentReplay: false,
			receipt: {
				edgeId: "qa_retry",
				targetNodeId: "implement",
				targetAttempt: 2,
				loopIteration: 1,
			},
		});
		expect(store.getWorkflowRun("run-1")?.current_node_id).toBe("implement");
		expect(store.getWorkflowRunNode("run-1", "implement", 2)).toMatchObject({
			state: "pending",
			execution_id: "implement-1",
		});
		expect(
			store.commitWorkflowLoopReentryRequest({
				canonical,
				canonicalDigest,
				tokenIdentity: "c".repeat(64),
				initiator: "qa-1",
				now: "2026-07-16T01:11:00.000Z",
			}),
		).toMatchObject({
			ok: true,
			idempotentReplay: true,
			receipt: first.ok ? first.receipt : {},
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "loop_reentry_request_committed"),
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
			execution_id: "implement-1",
		});
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(2);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "rework_requested"),
		).toHaveLength(1);
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
				executionId: "implement-1",
				outcome: "implement_done",
				successorExecutionId: "qa-1",
			});
			const result = advance(store, {
				nodeId: "qa",
				attempt,
				executionId: "qa-1",
				outcome: "qa_fail",
			});
			if (attempt === 4) {
				expect(result).toMatchObject({ ok: true, escalated: true });
				expect(
					advance(store, {
						nodeId: "qa",
						attempt,
						executionId: "qa-1",
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
