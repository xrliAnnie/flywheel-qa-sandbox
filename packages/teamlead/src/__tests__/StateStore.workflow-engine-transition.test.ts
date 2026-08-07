import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSubmissionDigest } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../StateStore.js";
import { loadBundledWorkflowSeeds } from "../workflow-template.js";

const engineFlags = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

async function engineRun(
	options: { gateCarrier?: boolean; dbPath?: string } = {},
): Promise<StateStore> {
	const store = await StateStore.create(options.dbPath ?? ":memory:");
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
			...(options.forceUnbound
				? {}
				: {
						prBinding: {
							prNumber: 1624,
							headSha: "a".repeat(40),
							targetRepoIdentity: "__main__",
							probeRepoSlug: "xrliAnnie/flywheel",
							targetRepoPath: "/tmp/flywheel",
							worktreeBindingGeneration: "generation-1",
						},
					}),
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

function bindRunnerShipAuthority(
	store: StateStore,
	holder: { question_id: string },
	prNumber = 1624,
) {
	store.upsertSession({
		execution_id: "implement-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "awaiting_review",
		pr_number: prNumber,
	});
	store.setReviewBinding("implement-1", {
		questionId: holder.question_id,
		prHeadSha: "a".repeat(40),
		shipTarget: {
			runId: "run-1",
			targetRepoPath: "/tmp/flywheel",
			targetRepoIdentity: "__main__",
			probeRepoSlug: "xrliAnnie/flywheel",
			worktreeBindingGeneration: "generation-1",
		},
	});
	return {
		repoIdentity: "__main__",
		probeRepoSlug: "xrliAnnie/flywheel",
		prNumber,
	};
}

function approveRunnerShipGate(
	store: StateStore,
	holder: { question_id: string },
) {
	for (const [stage, cardMessageId] of [
		["question_written"],
		["session_bound"],
		["card_posted", "founder-card-helper"],
		["card_bound", "founder-card-helper"],
		["completed", "founder-card-helper"],
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
		response: { approved: true },
		actor: "founder",
		approved_head: "a".repeat(40),
		classification: "founder_direct_signal",
		authority_id: holder.question_id,
	};
	expect(
		store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: `founder-approves-${holder.question_id}`,
			kind: "founder_approval",
			schemaVersion: 1,
			payloadJson: JSON.stringify(payload),
			payloadDigest: canonicalSubmissionDigest(payload),
		}),
	).toMatchObject({ kind: "founder_claim", status: "applied" });
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
				prBinding: {
					prNumber: 1624,
					headSha: "a".repeat(40),
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					targetRepoPath: "/tmp/flywheel",
					worktreeBindingGeneration: "generation-1",
				},
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
				prBinding: {
					prNumber: 1624,
					headSha: "a".repeat(40),
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					targetRepoPath: "/tmp/flywheel",
					worktreeBindingGeneration: "generation-1",
				},
				now: "2026-07-16T01:10:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.getCurrentWorkflowNodePrBindingForHead("run-1", "a".repeat(40)),
		).toMatchObject({
			node_id: "implement",
			attempt: 1,
			head_sha: "a".repeat(40),
		});
		expect(store.getSession("implement-1")).toMatchObject({
			status: "ship_parked",
			pr_head_sha: "a".repeat(40),
		});
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
		expect(
			store.getWorkflowShipTargetBinding(holder!.question_id),
		).toMatchObject({
			run_id: "run-1",
			frozen_head_sha: "a".repeat(40),
			target_repo_identity: "__main__",
			probe_repo_slug: "xrliAnnie/flywheel",
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
		const observedAuthority = bindRunnerShipAuthority(store, holder!);
		expect(
			store.recordRunnerShipMergedObserved({
				questionId: holder!.question_id,
				expectedHolderState: "materializing",
				expectedHolderHead: "a".repeat(40),
				expectedAuthority: observedAuthority,
				mergedHead: "a".repeat(40),
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-16T01:15:20.000Z",
			}),
		).toEqual({ status: "persisted" });
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
				expectedHolderState: "materializing",
				expectedHolderHead: "a".repeat(40),
				expectedObservationHead: "a".repeat(40),
				observedAuthority,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
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
				expectedHolderState: "approved",
				expectedHolderHead: "a".repeat(40),
				expectedObservationHead: "a".repeat(40),
				observedAuthority,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
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
		expect(
			store.resolveWorkflowGateCarrierRebindCanonical(
				holder.question_id,
				"implement-1",
			),
		).toBeUndefined();
		const rebindDb = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		rebindDb.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha,
			    target_repo_identity, probe_repo_slug, target_repo_path,
			    worktree_binding_generation, receipt_id, bound_at)
			 VALUES ('run-1', 'implement', 1, 1624, ?, '__main__',
			         'xrliAnnie/flywheel', '/tmp/flywheel', 'generation-1',
			         'late-pr-binding', '2026-07-16T01:19:00.000Z')`,
			["a".repeat(40)],
		);
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
		expect(
			store.getWorkflowShipTargetBinding(holder.question_id),
		).toMatchObject({
			run_id: "run-1",
			frozen_head_sha: "a".repeat(40),
			target_repo_identity: "__main__",
			probe_repo_slug: "xrliAnnie/flywheel",
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

	it("persists a resolved merge dead-end across restart and rearms on holder state change", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1624-runner-ship-"));
		const dbPath = join(dir, "teamlead.db");
		try {
			let store = await engineRun({ dbPath, gateCarrier: true });
			const holder = await openRunnerShipGate(store);
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "FLY-1307",
				project_name: "flywheel",
				status: "awaiting_review",
				pr_number: 1624,
				pr_head_sha: "a".repeat(40),
				review_question_id: holder.question_id,
			});
			store.setReviewBinding("implement-1", {
				questionId: holder.question_id,
				prHeadSha: "a".repeat(40),
				shipTarget: {
					runId: "run-1",
					targetRepoPath: "/tmp/flywheel",
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					worktreeBindingGeneration: "generation-1",
				},
			});

			const candidate = store.listRunnerShipHoldersForMergeProbe()[0]!;
			expect(candidate).toMatchObject({
				authority: {
					status: "resolved",
					repoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					prNumber: 1624,
				},
				fingerprint: "__main__:xrliAnnie/flywheel:1624",
			});
			expect(
				store.recordRunnerShipMergedObserved({
					questionId: holder.question_id,
					expectedHolderState: "materializing",
					expectedHolderHead: "a".repeat(40),
					expectedAuthority: {
						repoIdentity: "__main__",
						probeRepoSlug: "xrliAnnie/flywheel",
						prNumber: 1624,
					},
					mergedHead: "b".repeat(40),
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
					now: "2026-07-16T01:20:00.000Z",
				}),
			).toEqual({ status: "persisted" });
			expect(
				store.recordRunnerShipMergeDeadEnd({
					questionId: holder.question_id,
					expectedHolderState: "materializing",
					expectedHolderHead: "a".repeat(40),
					expectedAuthority: {
						repoIdentity: "__main__",
						probeRepoSlug: "xrliAnnie/flywheel",
						prNumber: 1624,
					},
					expectedObservationHead: "b".repeat(40),
					mergedHead: "b".repeat(40),
					deadEndKind: "head_mismatch",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
					now: "2026-07-16T01:20:01.000Z",
				}),
			).toEqual({ ok: true, idempotentReplay: false });
			expect(store.listRunnerShipHoldersForMergeProbe()).toEqual([]);
			store.close();

			store = await StateStore.create(dbPath);
			expect(store.listRunnerShipHoldersForMergeProbe()).toEqual([]);
			const db = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			db.run(
				"UPDATE workflow_gate_holder SET state = 'approved' WHERE question_id = ?",
				[holder.question_id],
			);
			expect(store.listRunnerShipHoldersForMergeProbe()).toMatchObject([
				{
					holderState: "approved",
					mergedObserved: {
						status: "valid",
						headSha: "b".repeat(40),
					},
				},
			]);
			store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not rematerialize holders whose workflow run is completed", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store);
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			"UPDATE workflow_run SET status = 'completed' WHERE run_id = 'run-1'",
		);

		expect(holder.materialization_stage).toBe("question_intent");
		expect(store.listWorkflowGateHoldersForMaterialization()).toEqual([]);
		store.close();
	});

	it("distinguishes legacy, unavailable, and conflicting runner-ship repository authority", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store, { forceUnbound: true });
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			`UPDATE workflow_gate_holder
			    SET source_execution_id = 'implement-1',
			        carrier_binding_state = 'bound'
			  WHERE question_id = ?`,
			[holder.question_id],
		);
		db.run("DELETE FROM workflow_alert_outbox");
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "awaiting_review",
			pr_number: 1624,
			pr_head_sha: "a".repeat(40),
			review_question_id: holder.question_id,
		});
		expect(store.listRunnerShipHoldersForMergeProbe()[0]?.authority).toEqual({
			status: "legacy_missing",
			prNumber: 1624,
		});

		store.upsertSession({
			execution_id: "another-pr",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "completed",
			pr_number: 1625,
			pr_head_sha: "a".repeat(40),
		});
		db.run(
			"UPDATE sessions SET pr_head_sha = ? WHERE execution_id = 'another-pr'",
			["a".repeat(40)],
		);
		expect(store.listRunnerShipHoldersForMergeProbe()[0]?.authority).toEqual({
			status: "unavailable",
		});

		store.setReviewBinding("implement-1", {
			questionId: holder.question_id,
			prHeadSha: "a".repeat(40),
			shipTarget: {
				runId: "run-1",
				targetRepoPath: "/tmp/flywheel",
				targetRepoIdentity: "__main__",
				probeRepoSlug: "xrliAnnie/flywheel",
				worktreeBindingGeneration: "generation-1",
			},
		});
		db.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
			    probe_repo_slug, target_repo_path, worktree_binding_generation,
			    receipt_id, bound_at)
			 VALUES ('run-1', 'implement', 1, 1624, ?, 'nested',
			         'xrliAnnie/nested', '/tmp/nested', 'generation-1',
			         'conflicting-binding', '2026-07-16T01:19:00.000Z')`,
			["a".repeat(40)],
		);
		const conflict = store.listRunnerShipHoldersForMergeProbe()[0]!;
		expect(conflict.authority).toMatchObject({
			status: "authority_conflict",
			digest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		if (conflict.authority.status !== "authority_conflict") {
			throw new Error("authority conflict missing");
		}
		expect(
			store.recordRunnerShipAuthorityConflict({
				questionId: holder.question_id,
				expectedDigest: conflict.authority.digest,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-16T01:20:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.recordRunnerShipAuthorityConflict({
				questionId: holder.question_id,
				expectedDigest: conflict.authority.digest,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-16T01:20:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		store.close();
	});

	it("atomically quarantines conflicting heads in one observation lineage", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store);
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "awaiting_review",
			pr_number: 1624,
			pr_head_sha: "a".repeat(40),
			review_question_id: holder.question_id,
		});
		store.setReviewBinding("implement-1", {
			questionId: holder.question_id,
			prHeadSha: "a".repeat(40),
			shipTarget: {
				runId: "run-1",
				targetRepoPath: "/tmp/flywheel",
				targetRepoIdentity: "__main__",
				probeRepoSlug: "xrliAnnie/flywheel",
				worktreeBindingGeneration: "generation-1",
			},
		});
		const base = {
			questionId: holder.question_id,
			expectedHolderState: "materializing",
			expectedHolderHead: "a".repeat(40),
			expectedAuthority: {
				repoIdentity: "__main__",
				probeRepoSlug: "xrliAnnie/flywheel",
				prNumber: 1624,
			},
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
			now: "2026-07-16T01:20:00.000Z",
		};
		expect(
			store.recordRunnerShipMergedObserved({
				...base,
				mergedHead: "b".repeat(40),
			}),
		).toEqual({ status: "persisted" });
		expect(
			store.recordRunnerShipMergedObserved({
				...base,
				mergedHead: "c".repeat(40),
			}),
		).toEqual({ status: "quarantined" });
		expect(store.listRunnerShipHoldersForMergeProbe()).toEqual([]);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "runner_ship_observation_quarantine"),
		).toHaveLength(1);
		expect(
			store
				.listWorkflowAlertOutbox()
				.filter(
					(row) =>
						row.payload.metadata.workflowEngine.disposition ===
						"observation_corrupt",
				),
		).toHaveLength(1);
		store.close();
	});

	it("rejects a dead-end write when the trusted observation head changes", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store);
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "awaiting_review",
			pr_number: 1624,
			pr_head_sha: "a".repeat(40),
			review_question_id: holder.question_id,
		});
		store.setReviewBinding("implement-1", {
			questionId: holder.question_id,
			prHeadSha: "a".repeat(40),
			shipTarget: {
				runId: "run-1",
				targetRepoPath: "/tmp/flywheel",
				targetRepoIdentity: "__main__",
				probeRepoSlug: "xrliAnnie/flywheel",
				worktreeBindingGeneration: "generation-1",
			},
		});
		const authority = {
			repoIdentity: "__main__",
			probeRepoSlug: "xrliAnnie/flywheel",
			prNumber: 1624,
		};
		store.recordRunnerShipMergedObserved({
			questionId: holder.question_id,
			expectedHolderState: "materializing",
			expectedHolderHead: "a".repeat(40),
			expectedAuthority: authority,
			mergedHead: "b".repeat(40),
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: "2026-07-16T01:20:00.000Z",
		});
		expect(
			store.recordRunnerShipMergeDeadEnd({
				questionId: holder.question_id,
				expectedHolderState: "materializing",
				expectedHolderHead: "a".repeat(40),
				expectedAuthority: authority,
				expectedObservationHead: "c".repeat(40),
				mergedHead: "c".repeat(40),
				deadEndKind: "head_mismatch",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-16T01:20:01.000Z",
			}),
		).toEqual({ ok: false, reason: "observation_stale" });
		expect(store.listWorkflowAlertOutbox()).toEqual([]);
		store.close();
	});

	it("completes only a resolved approved authority with current persisted merge evidence", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store);
		const authority = bindRunnerShipAuthority(store, holder);
		expect(
			store.recordRunnerShipMergedObserved({
				questionId: holder.question_id,
				expectedHolderState: "materializing",
				expectedHolderHead: "a".repeat(40),
				expectedAuthority: authority,
				mergedHead: "a".repeat(40),
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-16T01:20:00.000Z",
			}),
		).toEqual({ status: "persisted" });
		approveRunnerShipGate(store, holder);
		const alertIdentity = {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved" as const,
		};
		expect(
			store.completeWorkflowGateRunAfterShip({
				questionId: holder.question_id,
				mergedHead: "a".repeat(40),
				now: "2026-07-18T01:16:00.000Z",
				expectedHolderState: "awaiting_review",
				expectedHolderHead: "a".repeat(40),
				expectedObservationHead: "a".repeat(40),
				observedAuthority: authority,
				alertIdentity,
			}),
		).toEqual({ ok: false, reason: "candidate_changed" });
		expect(store.listWorkflowAlertOutbox()).toEqual([]);
		expect(
			store.completeWorkflowGateRunAfterShip({
				questionId: holder.question_id,
				mergedHead: "a".repeat(40),
				now: "2026-07-18T01:16:00.000Z",
				expectedHolderState: "approved",
				expectedHolderHead: "a".repeat(40),
				expectedObservationHead: "a".repeat(40),
				observedAuthority: authority,
				alertIdentity,
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(store.getWorkflowRun("run-1")?.status).toBe("completed");
		expect(
			store.completeWorkflowGateRunAfterShip({
				questionId: holder.question_id,
				mergedHead: "a".repeat(40),
				now: "2026-07-18T01:16:00.000Z",
				expectedHolderState: "approved",
				expectedHolderHead: "a".repeat(40),
				expectedObservationHead: "a".repeat(40),
				observedAuthority: authority,
				alertIdentity,
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(
			store.completeWorkflowGateRunAfterShip({
				questionId: holder.question_id,
				mergedHead: "a".repeat(40),
				now: "2026-07-18T01:16:00.000Z",
				expectedHolderState: "approved",
				expectedHolderHead: "a".repeat(40),
				expectedObservationHead: "a".repeat(40),
				observedAuthority: {
					...authority,
					probeRepoSlug: "xrliAnnie/not-flywheel",
				},
				alertIdentity,
			}),
		).toEqual({ ok: false, reason: "completion_raced" });
		store.close();
	});

	it("completes an approved run without mutating an already-terminal carrier", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store);
		const authority = bindRunnerShipAuthority(store, holder);
		expect(
			store.recordRunnerShipMergedObserved({
				questionId: holder.question_id,
				expectedHolderState: "materializing",
				expectedHolderHead: "a".repeat(40),
				expectedAuthority: authority,
				mergedHead: "a".repeat(40),
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-16T01:20:00.000Z",
			}),
		).toEqual({ status: "persisted" });
		approveRunnerShipGate(store, holder);
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			`UPDATE sessions
			    SET status = 'blocked', terminal_at = '2026-07-16T02:00:00.000Z',
			        last_activity_at = '2026-07-16T02:00:00.000Z'
			  WHERE execution_id = 'implement-1'`,
		);
		const carrierBefore = store.getSession("implement-1");

		expect(
			store.completeWorkflowGateRunAfterShip({
				questionId: holder.question_id,
				mergedHead: "a".repeat(40),
				now: "2026-07-18T01:16:00.000Z",
				expectedHolderState: "approved",
				expectedHolderHead: "a".repeat(40),
				expectedObservationHead: "a".repeat(40),
				observedAuthority: authority,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(store.getWorkflowRun("run-1")?.status).toBe("completed");
		expect(store.getWorkflowRunNode("run-1", "founder_gate", 1)?.state).toBe(
			"done",
		);
		expect(store.getSession("implement-1")).toEqual(carrierBefore);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.find((event) => event.kind === "run_completed")?.payload,
		).toMatchObject({ carrierDisposition: "carrier_already_terminal:blocked" });
		store.close();
	});

	it("durably backs off a failing completion episode and dead-ends it after five attempts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1648-completion-backoff-"));
		const dbPath = join(dir, "teamlead.db");
		let store: StateStore | undefined;
		try {
			store = await engineRun({ dbPath, gateCarrier: true });
			const holder = await openRunnerShipGate(store);
			const authority = bindRunnerShipAuthority(store, holder);
			expect(
				store.recordRunnerShipMergedObserved({
					questionId: holder.question_id,
					expectedHolderState: "materializing",
					expectedHolderHead: "a".repeat(40),
					expectedAuthority: authority,
					mergedHead: "a".repeat(40),
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
					now: "2026-07-16T01:20:00.000Z",
				}),
			).toEqual({ status: "persisted" });
			approveRunnerShipGate(store, holder);
			const db = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			db.run(
				"UPDATE sessions SET status = 'running' WHERE execution_id = 'implement-1'",
			);
			const alertIdentity = {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			};
			const firstAt = Date.parse("2026-07-18T01:16:00.000Z");
			const dueOffsets = [0, 60_000, 180_000, 420_000, 900_000];
			const firstCandidate = store.listRunnerShipHoldersForMergeProbe(
				new Date(firstAt).toISOString(),
			)[0]!;
			expect(firstCandidate.completionContextDigest).toMatch(/^[0-9a-f]{64}$/);

			for (let index = 0; index < dueOffsets.length; index += 1) {
				const now = new Date(firstAt + dueOffsets[index]!).toISOString();
				if (index === 1 || index === 2) {
					expect(
						store.recordRunnerShipCompletionException({
							questionId: holder.question_id,
							expectedContextDigest: firstCandidate.completionContextDigest,
							errorCode: "completion_exception",
							boundedDetail: `synthetic exception ${index}`,
							mergedHead: "a".repeat(40),
							alertIdentity,
							now,
						}),
					).toMatchObject({ status: "recorded", attempt: index + 1 });
				} else {
					expect(
						store.completeWorkflowGateRunAfterShip({
							questionId: holder.question_id,
							mergedHead: "a".repeat(40),
							now,
							expectedHolderState: "approved",
							expectedHolderHead: "a".repeat(40),
							expectedObservationHead: "a".repeat(40),
							observedAuthority: authority,
							alertIdentity,
						}),
					).toEqual({ ok: false, reason: "carrier_session_mismatch" });
				}

				if (index === 0) {
					store.close();
					store = await StateStore.create(dbPath);
					expect(
						store.recordRunnerShipCompletionException({
							questionId: holder.question_id,
							expectedContextDigest: firstCandidate.completionContextDigest,
							errorCode: "completion_exception",
							boundedDetail: "concurrent duplicate",
							mergedHead: "a".repeat(40),
							alertIdentity,
							now: new Date(firstAt + 1).toISOString(),
						}),
					).toEqual({ status: "not_due" });
				}
				if (index < dueOffsets.length - 1) {
					const nextDue = firstAt + dueOffsets[index + 1]!;
					expect(
						store.listRunnerShipHoldersForMergeProbe(
							new Date(nextDue - 1).toISOString(),
						),
					).toEqual([]);
					expect(
						store.listRunnerShipHoldersForMergeProbe(
							new Date(nextDue).toISOString(),
						)[0]?.completionContextDigest,
					).toBe(firstCandidate.completionContextDigest);
				}
			}

			expect(
				store.listRunnerShipHoldersForMergeProbe(
					new Date(firstAt + 86_400_000).toISOString(),
				),
			).toEqual([]);
			const completionEvents = store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind.startsWith("runner_ship_completion_"));
			expect(
				completionEvents.filter(
					(event) => event.kind === "runner_ship_completion_attempt",
				),
			).toHaveLength(5);
			expect(
				completionEvents.filter(
					(event) => event.kind === "runner_ship_completion_failure",
				),
			).toHaveLength(1);
			expect(
				completionEvents.filter(
					(event) => event.kind === "runner_ship_completion_deadend",
				),
			).toHaveLength(1);
			expect(store.listWorkflowAlertOutbox()).toHaveLength(1);

			const repairedDb = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			repairedDb.run(
				"UPDATE sessions SET status = 'approved_to_ship' WHERE execution_id = 'implement-1'",
			);
			const repaired = store.listRunnerShipHoldersForMergeProbe(
				new Date(firstAt + 86_400_000).toISOString(),
			)[0];
			expect(repaired?.completionContextDigest).toMatch(/^[0-9a-f]{64}$/);
			expect(repaired?.completionContextDigest).not.toBe(
				firstCandidate.completionContextDigest,
			);
			expect(
				store.recordRunnerShipCompletionException({
					questionId: holder.question_id,
					expectedContextDigest: firstCandidate.completionContextDigest,
					errorCode: "completion_exception",
					boundedDetail: "stale exception after repair",
					mergedHead: "a".repeat(40),
					alertIdentity,
					now: new Date(firstAt + 86_400_000).toISOString(),
				}),
			).toEqual({ status: "candidate_changed" });

			store.appendWorkflowRunEvent({
				runId: "run-1",
				eventUid: `runner_ship_completion_attempt:${repaired!.completionContextDigest}:1`,
				kind: "runner_ship_completion_attempt",
				payload: "malformed-attempt-ledger",
			});
			const alertsBeforeCorruptMarker = store.listWorkflowAlertOutbox().length;
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
			expect(
				store.listRunnerShipHoldersForMergeProbe(
					new Date(firstAt + 86_400_001).toISOString(),
				),
			).toEqual([]);
			expect(
				store
					.listWorkflowRunEvents("run-1")
					.filter(
						(event) => event.kind === "runner_ship_completion_ledger_corrupt",
					),
			).toEqual([
				expect.objectContaining({
					event_uid: `runner_ship_completion_ledger_corrupt:${repaired!.completionContextDigest}`,
					payload: {
						digest: repaired!.completionContextDigest,
						reason: "malformed_attempt_payload",
					},
				}),
			]);
			expect(errorLog).toHaveBeenCalledWith(
				expect.stringContaining(
					'"event":"runner_ship_completion_ledger_corrupt"',
				),
			);
			expect(store.listWorkflowAlertOutbox()).toHaveLength(
				alertsBeforeCorruptMarker,
			);
			expect(
				store.recordRunnerShipCompletionException({
					questionId: holder.question_id,
					expectedContextDigest: repaired!.completionContextDigest,
					errorCode: "completion_exception",
					boundedDetail: "malformed ledger must fail closed",
					mergedHead: "a".repeat(40),
					alertIdentity,
					now: new Date(firstAt + 86_400_001).toISOString(),
				}),
			).toEqual({ status: "dead_ended", attempt: 5 });
			expect(errorLog).toHaveBeenCalledTimes(1);
			errorLog.mockRestore();
		} finally {
			store?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses completion when the merged head differs from the founder-frozen Gate head", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store);
		const authority = bindRunnerShipAuthority(store, holder);
		expect(
			store.recordRunnerShipMergedObserved({
				questionId: holder.question_id,
				expectedHolderState: "materializing",
				expectedHolderHead: "a".repeat(40),
				expectedAuthority: authority,
				mergedHead: "b".repeat(40),
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-16T01:20:00.000Z",
			}),
		).toEqual({ status: "persisted" });
		approveRunnerShipGate(store, holder);

		expect(
			store.completeWorkflowGateRunAfterShip({
				questionId: holder.question_id,
				mergedHead: "b".repeat(40),
				now: "2026-07-18T01:16:00.000Z",
				expectedHolderState: "approved",
				expectedHolderHead: "a".repeat(40),
				expectedObservationHead: "b".repeat(40),
				observedAuthority: authority,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toEqual({ ok: false, reason: "subject_mismatch" });
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.listWorkflowAlertOutbox()).toEqual([]);
		store.close();
	});

	it("records legacy merge anomalies once and refuses them after a durable binding appears", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store, { forceUnbound: true });
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			`UPDATE workflow_gate_holder
			    SET source_execution_id = 'implement-1',
			        carrier_binding_state = 'bound'
			  WHERE question_id = ?`,
			[holder.question_id],
		);
		db.run("DELETE FROM workflow_alert_outbox");
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "awaiting_review",
			pr_number: 1624,
		});
		const anomaly = {
			questionId: holder.question_id,
			expectedHolderState: "materializing",
			expectedHolderHead: "a".repeat(40),
			observed: {
				prNumber: 1624,
				mergedHead: "b".repeat(40),
				anomaly: "head_mismatch" as const,
			},
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
			now: "2026-07-16T01:20:00.000Z",
		};
		expect(store.recordRunnerShipLegacyMergeAnomaly(anomaly)).toEqual({
			ok: true,
			idempotentReplay: false,
		});
		expect(store.recordRunnerShipLegacyMergeAnomaly(anomaly)).toEqual({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			store.listWorkflowAlertOutbox()[0]?.payload.metadata.workflowEngine
				.disposition,
		).toBe("runner_ship_legacy_merge_anomaly");
		bindRunnerShipAuthority(store, holder);
		expect(store.recordRunnerShipLegacyMergeAnomaly(anomaly)).toEqual({
			ok: false,
			reason: "binding_present",
		});
		store.close();
	});

	it("deduplicates enrichment failures by durable projection rather than volatile errors", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store);
		const authority = bindRunnerShipAuthority(store, holder);
		store.recordRunnerShipMergedObserved({
			questionId: holder.question_id,
			expectedHolderState: "materializing",
			expectedHolderHead: "a".repeat(40),
			expectedAuthority: authority,
			mergedHead: null,
			rawHeadRefOid: "",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: "2026-07-16T01:20:00.000Z",
		});
		const fingerprint = "__main__:xrliAnnie/flywheel:1624";
		const first = store.recordRunnerShipHeadEnrichmentFailure({
			questionId: holder.question_id,
			fingerprint,
			error: "timeout-A",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: "2026-07-16T01:21:00.000Z",
		});
		expect(first).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.recordRunnerShipHeadEnrichmentFailure({
				questionId: holder.question_id,
				fingerprint,
				error: "spawn-B",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-16T01:22:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(
			store.listWorkflowAlertOutbox()[0]?.payload.metadata.workflowEngine
				.disposition,
		).toBe("runner_ship_head_enrichment_failed");
		store.close();
	});

	it("deduplicates hydrated-head revalidation failures after a null-to-valid upgrade", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store);
		const authority = bindRunnerShipAuthority(store, holder);
		const alertIdentity = {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved" as const,
		};
		for (const mergedHead of [null, "a".repeat(40)]) {
			store.recordRunnerShipMergedObserved({
				questionId: holder.question_id,
				expectedHolderState: "materializing",
				expectedHolderHead: "a".repeat(40),
				expectedAuthority: authority,
				mergedHead,
				alertIdentity,
				now: "2026-07-16T01:20:00.000Z",
			});
		}
		const input = {
			questionId: holder.question_id,
			fingerprint: "__main__:xrliAnnie/flywheel:1624",
			expectedHydratedHead: "a".repeat(40),
			error: "nonzero-A",
			alertIdentity,
			now: "2026-07-16T01:21:00.000Z",
		};
		expect(store.recordRunnerShipHydrationRevalidationFailure(input)).toEqual({
			ok: true,
			idempotentReplay: false,
		});
		expect(
			store.recordRunnerShipHydrationRevalidationFailure({
				...input,
				error: "timeout-B",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(
			store.listWorkflowAlertOutbox()[0]?.payload.metadata.workflowEngine
				.disposition,
		).toBe("runner_ship_hydration_reval_failed");
		store.close();
	});

	it("projects malformed observation payloads as corruption and atomically quarantines them", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store);
		bindRunnerShipAuthority(store, holder);
		const fingerprint = "__main__:xrliAnnie/flywheel:1624";
		store.appendWorkflowRunEvent({
			runId: "run-1",
			eventUid: `runner_ship_merged_observed:${holder.question_id}:${fingerprint}`,
			kind: "runner_ship_merged_observed",
			nodeId: "founder_gate",
			executionId: "implement-1",
			payload: "malformed-ledger-payload",
		});
		const conflict =
			store.listRunnerShipHoldersForMergeProbe()[0]?.observationConflict;
		expect(conflict).toMatchObject({
			fingerprint,
			digest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		if (!conflict) throw new Error("corrupt projection missing");
		expect(
			store.recordRunnerShipMergedObservationConflict({
				questionId: holder.question_id,
				fingerprint,
				expectedDigest: conflict.digest,
				conflictingHeads: conflict.conflictingHeads,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-16T01:21:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(store.listRunnerShipHoldersForMergeProbe()).toHaveLength(0);
		expect(
			store.listWorkflowAlertOutbox()[0]?.payload.metadata.workflowEngine
				.disposition,
		).toBe("observation_corrupt");
		store.close();
	});

	it("uses the event_uid index for the global observation projection range scan", async () => {
		const store = await engineRun({ gateCarrier: true });
		const db = (
			store as unknown as {
				db: {
					exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
				};
			}
		).db;
		const plan = db.exec(
			`EXPLAIN QUERY PLAN
			 SELECT run_id, event_uid, kind, payload
			   FROM workflow_run_event
			  WHERE (event_uid >= 'runner_ship_merged_observed:'
			         AND event_uid < 'runner_ship_merged_observed;')
			     OR (event_uid >= 'runner_ship_observation_quarantine:'
			         AND event_uid < 'runner_ship_observation_quarantine;')
			  ORDER BY event_uid`,
		)[0];
		const detailIndex = plan?.columns.indexOf("detail") ?? -1;
		const details =
			detailIndex < 0
				? ""
				: (plan?.values ?? [])
						.map((row) => String(row[detailIndex]))
						.join("\n");
		expect(details).toContain("USING INDEX");
		expect(details).not.toContain("SCAN workflow_run_event");
		const anomalyPlan = db.exec(
			`EXPLAIN QUERY PLAN
			 SELECT 1 AS x FROM workflow_run_event
			  WHERE run_id = 'run-1'
			    AND event_uid >= 'runner_ship_legacy_merge_anomaly:q:approved:head:12:'
			    AND event_uid < 'runner_ship_legacy_merge_anomaly:q:approved:head:12;'
			  LIMIT 1`,
		)[0];
		const anomalyDetailIndex = anomalyPlan?.columns.indexOf("detail") ?? -1;
		const anomalyDetails =
			anomalyDetailIndex < 0
				? ""
				: (anomalyPlan?.values ?? [])
						.map((row) => String(row[anomalyDetailIndex]))
						.join("\n");
		expect(anomalyDetails).toContain("USING INDEX");
		expect(anomalyDetails).not.toContain("SCAN workflow_run_event");
		const retryPlan = db.exec(
			`EXPLAIN QUERY PLAN
			 SELECT payload FROM workflow_run_event
			  WHERE run_id = 'run-1'
			    AND kind = 'runner_ship_completion_attempt'
			    AND event_uid >= 'runner_ship_completion_attempt:digest:'
			    AND event_uid < 'runner_ship_completion_attempt:digest;'
			  ORDER BY seq DESC LIMIT 1`,
		)[0];
		const retryDetailIndex = retryPlan?.columns.indexOf("detail") ?? -1;
		const retryDetails =
			retryDetailIndex < 0
				? ""
				: (retryPlan?.values ?? [])
						.map((row) => String(row[retryDetailIndex]))
						.join("\n");
		expect(retryDetails).toContain("USING INDEX");
		expect(retryDetails).not.toContain("SCAN workflow_run_event");
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
