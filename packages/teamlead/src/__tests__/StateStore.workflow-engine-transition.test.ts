import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSubmissionDigest } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../StateStore.js";
import { importWorkflowMenuSeeds } from "../workflow-menu.js";
import {
	parseWorkflowRunSnapshot,
	resolveWorkflowGateAuthority,
} from "../workflow-run-snapshot.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const engineFlags = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};
const menuEngineFlags = {
	...engineFlags,
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_GATE_CARRIER: "1",
};

async function engineRun(
	options: { gateCarrier?: boolean; dbPath?: string } = {},
): Promise<StateStore> {
	const store = await StateStore.create(options.dbPath ?? ":memory:");
	const seed = legacyWorkflowSeeds().find(
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
	if (!options.gateCarrier) {
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_run SET gate_carrier_epoch = 0 WHERE run_id = 'run-1'",
		);
	}
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	store.upsertSession({
		execution_id: "design-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "design",
	});
	return store;
}

async function compiledCodeEngineRun(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	importWorkflowMenuSeeds(store, menuEngineFlags);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: "tpl_code",
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1765",
		projectName: "flywheel",
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: REPO_ROOT,
		env: menuEngineFlags,
		startReservation: {
			idempotencyKey: "start-1",
			selectionDigest: "selection-1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-08-14T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	store.upsertSession({
		execution_id: "design-1",
		issue_id: "FLY-1765",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "design",
	});
	return store;
}

async function compiledGenericEngineRun(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	importWorkflowMenuSeeds(store, menuEngineFlags);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "generic",
		templateId: "tpl_generic_menu",
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-2027",
		projectName: "flywheel",
		taskCategory: "generic",
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: REPO_ROOT,
		env: menuEngineFlags,
		startReservation: {
			idempotencyKey: "start-generic",
			selectionDigest: "selection-generic",
			nodeId: "execute",
			attempt: 1,
			executionId: "generic-1",
			createdAt: "2026-08-24T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "execute",
		attempt: 1,
		state: "running",
		executionId: "generic-1",
	});
	const admission = store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: "execute",
		executionId: "generic-1",
		attempt: 1,
		expiresAt: "2026-08-24T02:00:00.000Z",
		absoluteDeadlineAt: "2026-08-25T00:00:00.000Z",
		now: "2026-08-24T00:01:00.000Z",
		env: menuEngineFlags,
	});
	if (!admission.ok)
		throw new Error(`generic admission failed: ${admission.reason}`);
	store.upsertSession({
		execution_id: "generic-1",
		issue_id: "FLY-2027",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "execute",
	});
	return store;
}

function completeCompiledCodeImplement(store: StateStore) {
	advance(store, {
		nodeId: "design",
		attempt: 1,
		executionId: "design-1",
		outcome: "design_done",
		successorExecutionId: "implement-1",
	});
	const admission = store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: "implement",
		executionId: "implement-1",
		attempt: 1,
		expiresAt: "2026-08-14T02:00:00.000Z",
		absoluteDeadlineAt: "2026-08-15T00:00:00.000Z",
		now: "2026-08-14T01:05:00.000Z",
		env: menuEngineFlags,
	});
	if (!admission.ok)
		throw new Error(`implement admission failed: ${admission.reason}`);
	store.upsertSession({
		execution_id: "implement-1",
		issue_id: "FLY-1765",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "implement",
	});
	const beforeCompletion = store.getSession("implement-1");
	const completion = store.commitEnrolledCompletion({
		executionId: "implement-1",
		route: "needs_review",
		sourceEventId: "complete-implement-1",
		completionSubmission: { decision: { route: "needs_review" } },
		subjectDigest: "a".repeat(40),
		prBinding: {
			prNumber: 1765,
			headSha: "a".repeat(40),
			targetRepoIdentity: "__main__",
			probeRepoSlug: "xrliAnnie/flywheel",
			targetRepoPath: "/tmp/flywheel-FLY-1765",
			worktreeBindingGeneration: "generation-1",
		},
		now: "2026-08-14T01:10:00.000Z",
	});
	return { beforeCompletion, completion };
}

function prepareCompiledReworkReplacement(store: StateStore) {
	const open = store.getCurrentWorkflowEngineParkEvidence("implement-1")!;
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "qa",
		attempt: 1,
		state: "running",
		executionId: "qa-1",
	});
	const failed = store.commitWorkflowTransitionTx({
		runId: "run-1",
		nodeId: "qa",
		attempt: 1,
		executionId: "qa-1",
		outcome: "qa_fail",
		subjectDigest: "a".repeat(40),
		now: "2026-08-14T01:31:00.000Z",
	});
	if (!failed.ok || !failed.reworkRequestId) {
		throw new Error("QA fail did not create rework");
	}
	const claim = store.claimWorkflowReworkDelivery({
		requestId: failed.reworkRequestId,
		ownerId: "coordinator",
		now: "2026-08-14T01:32:00.000Z",
		leaseExpiresAt: "2026-08-14T01:33:00.000Z",
	});
	if (!claim.ok) throw new Error(claim.reason);
	expect(
		store.advanceWorkflowReworkDelivery({
			requestId: failed.reworkRequestId,
			ownerId: "coordinator",
			generation: claim.generation,
			from: "pending",
			to: "replacement_pending",
			now: "2026-08-14T01:32:10.000Z",
			error: "persisted_target_dead",
			releaseOwner: true,
		}),
	).toEqual({ ok: true });
	return {
		open,
		replacement: {
			requestId: failed.reworkRequestId,
			deadExecutionId: "implement-1",
			newExecutionId: "implement-2",
			reason: "persisted_target_dead",
			observedAt: "2026-08-14T01:33:00.000Z",
		},
	};
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
	options: {
		forceUnbound?: boolean;
		delayCarrier?: boolean;
		gateEntryHead?: string;
		runnerHead?: string;
		omitGateEntryBinding?: boolean;
		expectedTransitionRefusal?: string;
	} = {},
) {
	const gateEntryHead = options.gateEntryHead ?? "a".repeat(40);
	const runnerHead = options.runnerHead ?? "a".repeat(40);
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
	store.upsertSession({
		execution_id: "implement-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "running",
	});
	expect(
		store.commitEnrolledCompletion({
			executionId: "implement-1",
			route: "needs_review",
			sourceEventId: "complete-implement-for-helper",
			completionSubmission: { decision: { route: "needs_review" } },
			subjectDigest: runnerHead,
			...(options.forceUnbound
				? {}
				: {
						prBinding: {
							prNumber: 1624,
							headSha: runnerHead,
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
	store.upsertSession({
		execution_id: qaIntent!.execution_id,
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "qa",
	});
	if (options.forceUnbound) {
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
		});
	} else if (options.delayCarrier) {
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "completed",
			pr_number: 1624,
			pr_head_sha: "a".repeat(40),
		});
	}
	const submission = store.submitWorkflowDecisionByCredential({
		credential: qaAdmission.submissionCredential,
		clientRequestId: "qa-pass-helper",
		predicate: "qa_passed",
		subjectDigest: gateEntryHead,
		issuerVendor: "claude",
		issuerModel: "claude-opus-4-8",
		subjectProducerExecutionId: "implement-1",
		subjectProducerVendor: "codex",
		claimExpiresAt: "2026-07-16T02:00:00.000Z",
		...(options.forceUnbound || options.omitGateEntryBinding
			? {}
			: {
					gateEntryBinding: {
						kind: "worktree" as const,
						prNumber: 1624,
						headSha: gateEntryHead,
						targetRepoIdentity: "__main__",
						probeRepoSlug: "xrliAnnie/flywheel",
						targetRepoPath: "/tmp/flywheel",
						worktreeBindingGeneration: "generation-1",
						expectedProducerMirrorHead: runnerHead,
					},
				}),
		alertIdentity: {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved",
		},
		now: "2026-07-16T01:15:00.000Z",
	});
	if (options.expectedTransitionRefusal) {
		expect(submission).toMatchObject({
			ok: false,
			reason: "transition_refused",
			detail: { transitionReason: options.expectedTransitionRefusal },
		});
		return store.getCurrentWorkflowGateHolder("run-1", "founder_gate")!;
	}
	expect(submission).toMatchObject({ ok: true });
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
	if (!store.getWorkflowShipTargetBinding(holder.question_id)) {
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
	}
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

async function approvedCarrierRun() {
	const store = await engineRun({ gateCarrier: true });
	const holder = await openRunnerShipGate(store);
	bindRunnerShipAuthority(store, holder);
	approveRunnerShipGate(store, holder);
	store.upsertSession({
		execution_id: "implement-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "awaiting_review",
		pr_number: 1624,
		pr_head_sha: "a".repeat(40),
		review_question_id: holder.question_id,
	});
	return { store, holder };
}

const carrierAlertIdentity = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved" as const,
};

describe("engine-owned snapshot transition transaction", () => {
	it("co-writes the W1 start attachment and immutable typed receipt", async () => {
		const store = await engineRun();
		const attachment = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
		})[0];
		expect(attachment).toMatchObject({
			run_id: "run-1",
			target_node_id: "design",
			target_attempt: 1,
			transition_uid: "resume_origin:run-1",
			receipt_kind: "start_reservation",
			carrier_kind: "git_checkpoint",
			anchor_commit: null,
		});
		expect(
			store.getWorkflowResumeAttachmentState(attachment!.attachment_id),
		).toMatchObject({ state: "intent", revision: 0 });
		const receipt = store
			.listWorkflowRunEvents("run-1")
			.find((event) => event.event_uid === "resume_origin:run-1");
		expect(receipt?.kind).toBe("start_reservation");
		expect(attachment?.receipt_digest).toBe(
			canonicalSubmissionDigest(receipt!.payload),
		);
	});

	it("keeps a legacy transition committed when its resume-only diagnostic UID conflicts", async () => {
		const store = await engineRun();
		const transitionUid = `workflow_transition:${canonicalSubmissionDigest({
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
			outcome: "design_done",
		})}`;
		store.appendWorkflowRunEvent({
			runId: "run-1",
			eventUid: `resume_target_unrecoverable:${transitionUid}`,
			kind: "preseeded_resume_evidence_conflict",
			payload: { conflict: true },
		});

		expect(
			advance(store, {
				nodeId: "design",
				attempt: 1,
				executionId: "design-1",
				outcome: "design_done",
				successorExecutionId: "implement-1",
			}),
		).toMatchObject({
			ok: true,
			targetNodeId: "implement",
			successorExecutionId: "implement-1",
		});
		expect(store.getWorkflowRun("run-1")?.current_node_id).toBe("implement");
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "pending",
			execution_id: "implement-1",
		});
		store.close();
	});

	it("advances a git attachment by revision and becomes ready only after every required stamp", async () => {
		const store = await engineRun();
		const attachment = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
		})[0]!;
		const anchor = "c".repeat(40);
		expect(
			store.advanceWorkflowResumeAttachment({
				attachmentId: attachment.attachment_id,
				expectedRevision: 0,
				action: { kind: "stamp_anchor", anchorCommit: anchor },
				now: "2026-07-16T00:01:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "intent", revision: 1 });
		expect(
			store.advanceWorkflowResumeAttachment({
				attachmentId: attachment.attachment_id,
				expectedRevision: 0,
				action: { kind: "ref_prepared" },
				now: "2026-07-16T00:02:00.000Z",
			}),
		).toEqual({ ok: false, reason: "revision_conflict" });
		expect(
			store.advanceWorkflowResumeAttachment({
				attachmentId: attachment.attachment_id,
				expectedRevision: 1,
				action: { kind: "ref_prepared" },
				now: "2026-07-16T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "ref_prepared", revision: 2 });
		expect(
			store.advanceWorkflowResumeAttachment({
				attachmentId: attachment.attachment_id,
				expectedRevision: 2,
				action: { kind: "store_pushed", storeLocator: "store:ref:g1" },
				now: "2026-07-16T00:03:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "store_pushed", revision: 3 });
		expect(
			store.advanceWorkflowResumeAttachment({
				attachmentId: attachment.attachment_id,
				expectedRevision: 3,
				action: { kind: "stamp_envelope", envelopeJson: '{"s3":"digest"}' },
				now: "2026-07-16T00:04:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "store_pushed", revision: 4 });
		expect(
			store.advanceWorkflowResumeAttachment({
				attachmentId: attachment.attachment_id,
				expectedRevision: 4,
				action: { kind: "stamp_runtime", runtimeSemanticsDigest: "runtime" },
				now: "2026-07-16T00:05:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "ready", revision: 5 });
		expect(
			store.advanceWorkflowResumeAttachment({
				attachmentId: attachment.attachment_id,
				expectedRevision: 5,
				action: { kind: "stamp_runtime", runtimeSemanticsDigest: "changed" },
				now: "2026-07-16T00:06:00.000Z",
			}),
		).toEqual({ ok: false, reason: "state_conflict" });
	});

	it("backs off checkpoint reconciliation and invalidates only an exact exhausted revision", async () => {
		const store = await engineRun();
		const attachment = store.listWorkflowResumeAttachments({
			runId: "run-1",
		})[0]!;
		let revision = 0;
		let nextAttemptAt: string | null = null;
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			const retry = store.recordWorkflowResumeAttachmentRetry({
				attachmentId: attachment.attachment_id,
				expectedState: "intent",
				expectedRevision: revision,
				error: "anchor_pending",
				now: `2026-07-16T00:0${attempt}:00.000Z`,
			});
			expect(retry).toMatchObject({ ok: true, attemptCount: attempt });
			if (!retry.ok) throw new Error(retry.reason);
			revision = retry.revision;
			nextAttemptAt = retry.nextAttemptAt;
		}
		expect(
			store.invalidateWorkflowResumeAttachment({
				attachmentId: attachment.attachment_id,
				runId: "run-1",
				nodeId: "design",
				attempt: 1,
				reason: "anchor_unreachable",
				authority: {
					kind: "attachment_reconciler",
					expectedState: "intent",
					expectedAttemptCount: 5,
					expectedNextAttemptAt: nextAttemptAt,
					expectedRevision: revision - 1,
				},
				now: "2026-07-16T00:10:00.000Z",
			}),
		).toEqual({ ok: false, reason: "revision_conflict" });
		expect(
			store.invalidateWorkflowResumeAttachment({
				attachmentId: attachment.attachment_id,
				runId: "run-1",
				nodeId: "design",
				attempt: 1,
				reason: "anchor_unreachable",
				authority: {
					kind: "attachment_reconciler",
					expectedState: "intent",
					expectedAttemptCount: 5,
					expectedNextAttemptAt: nextAttemptAt,
					expectedRevision: revision,
				},
				now: "2026-07-16T00:10:00.000Z",
			}),
		).toEqual({ ok: true, revision: revision + 1 });
		expect(
			store.advanceWorkflowResumeAttachment({
				attachmentId: attachment.attachment_id,
				expectedRevision: revision + 1,
				action: { kind: "stamp_anchor", anchorCommit: "d".repeat(40) },
				now: "2026-07-16T00:11:00.000Z",
			}),
		).toEqual({ ok: false, reason: "state_conflict" });
	});

	it("co-writes the W2 executable target attachment against the exact edge receipt", async () => {
		const store = await engineRun();
		const head = "b".repeat(40);
		const transition = store.commitWorkflowTransitionTx({
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			subjectDigest: head,
			successorExecutionId: "implement-1",
			now: "2026-07-16T01:00:00.000Z",
		});
		expect(transition).toMatchObject({
			ok: true,
			targetNodeId: "implement",
			targetAttempt: 1,
		});
		const attachment = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
		})[0];
		expect(attachment).toMatchObject({
			receipt_kind: "edge_traversed",
			carrier_kind: "git_checkpoint",
			anchor_commit: head,
		});
		const receipt = store
			.listWorkflowRunEvents("run-1")
			.find((event) => event.event_uid === attachment?.transition_uid);
		expect(receipt?.kind).toBe("edge_traversed");
		expect(attachment?.receipt_digest).toBe(
			canonicalSubmissionDigest(receipt!.payload),
		);
	});

	it("uses a state-only W2 attachment for the current approval gate", async () => {
		const store = await engineRun({ gateCarrier: true });
		await openRunnerShipGate(store);
		const gate = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "founder_gate",
			attempt: 1,
		})[0];
		expect(gate).toMatchObject({
			receipt_kind: "edge_traversed",
			carrier_kind: "state_only_checkpoint",
			anchor_ref: null,
			anchor_commit: null,
			repo_identity: null,
		});
		expect(
			store.getWorkflowResumeAttachmentState(gate!.attachment_id)?.state,
		).toBe("intent");
		expect(gate?.runtime_semantics_digest).toBeTruthy();
		expect(
			store.advanceWorkflowResumeAttachment({
				attachmentId: gate!.attachment_id,
				expectedRevision: 0,
				action: { kind: "stamp_envelope", envelopeJson: '{"s3":"digest"}' },
				now: "2026-07-16T01:20:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "ready", revision: 1 });
	});

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
		const admittedAttachment = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
		})[0]!;
		expect(
			store.getWorkflowResumeAttachmentState(admittedAttachment.attachment_id),
		).toMatchObject({
			state: "intent",
			runtime_semantics_stamped: expect.stringMatching(/^[0-9a-f]{64}$/),
			revision: 1,
		});
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
		expect(completed).toMatchObject({
			ok: true,
			idempotentReplay: false,
			completionDisposition: "terminal_no_gate",
		});
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
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(`
			DROP TRIGGER workflow_run_event_no_delete;
			DELETE FROM workflow_run_event
			 WHERE run_id = 'run-1' AND kind = 'completion_disposition';
			CREATE TRIGGER workflow_run_event_no_delete
			BEFORE DELETE ON workflow_run_event
			BEGIN SELECT RAISE(ABORT, 'workflow_run_event is append-only'); END
		`);

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
		).toMatchObject({
			ok: true,
			idempotentReplay: true,
			completionDisposition: "terminal_no_gate",
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "completion_disposition"),
		).toHaveLength(1);
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
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "implement",
		});

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
		).toMatchObject({
			ok: true,
			completionDisposition: "terminal_no_gate",
		});

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

	it("keeps the compiled tpl_code implement actor rework-reachable after completion", async () => {
		const store = await compiledCodeEngineRun();
		const { beforeCompletion, completion } =
			completeCompiledCodeImplement(store);
		const run = store.getWorkflowRun("run-1")!;
		expect(run).toMatchObject({ engine_owned: 1, gate_carrier_epoch: 1 });
		const snapshot = parseWorkflowRunSnapshot(run.snapshot);
		expect(resolveWorkflowGateAuthority(snapshot)).toEqual({
			mode: "land",
			subjectKind: "git_head",
		});
		expect(
			snapshot.resolved.nodes.find((node) => node.id === "implement"),
		).toMatchObject({ capabilities: { creates_pr: true } });
		expect(beforeCompletion).toMatchObject({
			status: "running",
			terminal_at: undefined,
		});
		expect(completion).toMatchObject({
			ok: true,
			completionDisposition: "terminal_no_gate",
		});

		expect(store.getSession("implement-1")).toMatchObject({
			status: "ship_parked",
			terminal_at: undefined,
		});
		expect(
			store.getCurrentWorkflowEngineParkEvidence("implement-1"),
		).toMatchObject({
			event: "park_opened",
			reason: "rework_reachable_wait",
			run_id: "run-1",
			node_id: "implement",
			attempt: 1,
		});
		expect(store.getWorkflowRun("run-1")?.current_node_id).toBe("qa");
		store.close();
	});

	it("parks a capable generic producer for durable rework reachability", async () => {
		const store = await compiledGenericEngineRun();
		const run = store.getWorkflowRun("run-1")!;
		const snapshot = parseWorkflowRunSnapshot(run.snapshot);
		expect(resolveWorkflowGateAuthority(snapshot)).toEqual({
			mode: "land",
			subjectKind: "git_head",
		});
		expect(
			snapshot.resolved.nodes.find((node) => node.id === "execute"),
		).toMatchObject({
			type: "generic",
			capabilities: { creates_pr: true, keepalive_park: true },
		});

		expect(
			store.commitEnrolledCompletion({
				executionId: "generic-1",
				route: "needs_review",
				sourceEventId: "complete-generic-1",
				completionSubmission: { decision: { route: "needs_review" } },
				subjectDigest: "a".repeat(40),
				prBinding: {
					prNumber: 2027,
					headSha: "a".repeat(40),
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					targetRepoPath: "/tmp/flywheel-FLY-2027",
					worktreeBindingGeneration: "generation-1",
				},
				now: "2026-08-24T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true, completionDisposition: "engine_gate_handoff" });
		expect(store.getSession("generic-1")).toMatchObject({
			status: "ship_parked",
			terminal_at: undefined,
		});
		expect(
			store.getCurrentWorkflowEngineParkEvidence("generic-1"),
		).toMatchObject({
			event: "park_opened",
			reason: "rework_reachable_wait",
			run_id: "run-1",
			node_id: "execute",
		});
		store.close();
	});

	it("keeps no_code terminal for a capable generic producer without opening a park", async () => {
		const store = await compiledGenericEngineRun();
		const baselineJson = '{"repositories":[],"version":1}';
		const baselineDigest = canonicalSubmissionDigest(JSON.parse(baselineJson));
		store.bindWorktreeOnce("generic-1", {
			path: "/tmp/flywheel-FLY-2027",
			branch: "flywheel-FLY-2027",
			generation: "generation-1",
			repoBaselineSetJson: baselineJson,
			repoBaselineSetDigest: baselineDigest,
		});

		expect(
			store.commitEnrolledCompletion({
				executionId: "generic-1",
				route: "no_code",
				sourceEventId: "complete-generic-no-code",
				completionSubmission: { decision: { route: "no_code" } },
				noCodeAttestation: {
					worktreeBindingGeneration: "generation-1",
					baselineDigest,
					currentDigest: baselineDigest,
				},
				now: "2026-08-24T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true, completionDisposition: "terminal_no_gate" });
		expect(store.getSession("generic-1")?.status).toBe("completed");
		expect(
			store.getCurrentWorkflowEngineParkEvidence("generic-1"),
		).toBeUndefined();
		store.close();
	});

	it("keeps a rework-reachable implement outside land gate holder authority", async () => {
		const store = await compiledCodeEngineRun();
		completeCompiledCodeImplement(store);
		const qaExecutionId = store
			.listWorkflowSideEffects("run-1")
			.find((effect) => effect.node_id === "qa")!.execution_id;
		const qaAdmission = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "qa",
			executionId: qaExecutionId,
			attempt: 1,
			expiresAt: "2026-08-14T03:00:00.000Z",
			absoluteDeadlineAt: "2026-08-15T00:00:00.000Z",
			now: "2026-08-14T01:15:00.000Z",
			env: menuEngineFlags,
		});
		if (!qaAdmission.ok || !qaAdmission.submissionCredential) {
			throw new Error("QA admission failed");
		}
		store.upsertSession({
			execution_id: qaExecutionId,
			issue_id: "FLY-1765",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "qa",
		});
		const passed = store.submitWorkflowDecisionByCredential({
			credential: qaAdmission.submissionCredential,
			clientRequestId: "qa-pass-land-authority",
			predicate: "qa_passed",
			subjectDigest: "a".repeat(40),
			issuerVendor: "claude",
			issuerModel: "claude-opus-4-8",
			subjectProducerExecutionId: "implement-1",
			subjectProducerVendor: "codex",
			claimExpiresAt: "2026-08-14T03:00:00.000Z",
			gateEntryBinding: {
				kind: "worktree",
				prNumber: 1765,
				headSha: "a".repeat(40),
				targetRepoIdentity: "__main__",
				probeRepoSlug: "xrliAnnie/flywheel",
				targetRepoPath: "/tmp/flywheel-FLY-1765",
				worktreeBindingGeneration: "generation-1",
				expectedProducerMirrorHead: "a".repeat(40),
			},
			now: "2026-08-14T01:18:00.000Z",
		});
		expect(passed).toMatchObject({ ok: true });
		const holder = store.getCurrentWorkflowGateHolder("run-1", "founder_gate");
		expect(holder).toMatchObject({
			authority_mode: "land",
			source_execution_id: qaExecutionId,
		});
		expect(holder?.source_execution_id).not.toBe("implement-1");
		expect(
			store.workflowGatePresentationDisposition({
				executionId: "implement-1",
				checkpoint: "approve_to_ship",
				questionId: holder!.question_id,
			}),
		).toEqual({ allow: false, reason: "holder_mismatch" });
		expect(store.getSession("implement-1")?.status).toBe("ship_parked");
		store.close();
	});

	it.each([
		["parked session", false],
		["session already finalized", true],
	] as const)(
		"settles the current rework park when land completes with a %s",
		async (_label, finalizerFirst) => {
			const store = await compiledCodeEngineRun();
			completeCompiledCodeImplement(store);
			const open = store.getCurrentWorkflowEngineParkEvidence("implement-1")!;
			const before = store.getSession("implement-1")!;
			const db = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			if (finalizerFirst) {
				db.run(
					`UPDATE sessions
					    SET status = 'completed', terminal_at = '2026-08-14 01:20:00',
					        lifecycle_revision = 17
					  WHERE execution_id = 'implement-1'`,
				);
			}
			db.run(
				"UPDATE workflow_run SET current_node_id = 'land' WHERE run_id = 'run-1'",
			);
			store.upsertWorkflowRunNode({
				runId: "run-1",
				nodeId: "land",
				attempt: 1,
				state: "pending",
				executionId: "land-1",
			});
			const operation = store.ensureLandOperation({
				runId: "run-1",
				issueId: "FLY-1765",
				projectName: "flywheel",
				prNumber: 1765,
				approvedHead: "a".repeat(40),
				now: "2026-08-14T01:21:00.000Z",
			});
			const claim = store.claimLandOperation({
				operationId: operation.operation_id,
				ownerId: "land-worker",
				now: "2026-08-14T01:22:00.000Z",
				leaseExpiresAt: "2026-08-14T01:30:00.000Z",
			})!;
			expect(
				store.recordLandLinearDoneDisposition({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					disposition: "done",
					reason: "already_completed",
					executionId: "land-1",
					now: "2026-08-14T01:22:30.000Z",
				}),
			).toEqual({ ok: true, idempotentReplay: false });
			expect(
				store.recordLandOperationStep({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					step: "finalization_completed",
					receipt: { outcome: "completed" },
					now: "2026-08-14T01:23:00.000Z",
				}),
			).toEqual({ ok: true, idempotentReplay: false });

			expect(
				store.completeWorkflowLandNode({
					runId: "run-1",
					nodeId: "land",
					attempt: 1,
					executionId: "land-1",
					operationId: operation.operation_id,
					now: "2026-08-14T01:24:00.000Z",
				}),
			).toEqual({ ok: true, idempotentReplay: false });

			const settled = store.getSession("implement-1")!;
			expect(settled.status).toBe("completed");
			if (finalizerFirst) {
				expect(settled).toMatchObject({
					terminal_at: "2026-08-14 01:20:00",
					lifecycle_revision: 17,
				});
			} else {
				expect(settled.terminal_at).toEqual(expect.any(String));
				expect(settled.lifecycle_revision).toBe(
					(before.lifecycle_revision ?? 0) + 1,
				);
			}
			expect(
				store.getCurrentWorkflowEngineParkEvidence("implement-1"),
			).toBeUndefined();
			const settlementEvents = store
				.listWorkflowEngineParkEventsAfter("flywheel", 0)
				.filter((event) => event.event_id.startsWith("engine-park-settle:"));
			expect(settlementEvents).toEqual([
				expect.objectContaining({
					event_id: `engine-park-settle:implement-1:${open.generation}`,
					event: "park_cleared",
					reason: "rework_reachable_wait",
					generation: open.generation + 1,
				}),
			]);

			expect(
				store.completeWorkflowLandNode({
					runId: "run-1",
					nodeId: "land",
					attempt: 1,
					executionId: "land-1",
					operationId: operation.operation_id,
					now: "2026-08-14T01:25:00.000Z",
				}),
			).toEqual({ ok: true, idempotentReplay: true });
			expect(
				store
					.listWorkflowEngineParkEventsAfter("flywheel", 0)
					.filter((event) => event.event_id.startsWith("engine-park-settle:")),
			).toHaveLength(1);
			store.close();
		},
	);

	it("settles a rework park when an operator terminates the run", async () => {
		const store = await compiledCodeEngineRun();
		completeCompiledCodeImplement(store);
		const open = store.getCurrentWorkflowEngineParkEvidence("implement-1")!;

		expect(
			store.terminateWorkflowRunByOperator({
				runId: "run-1",
				reason: "operator cancelled the run",
				clientRequestId: "terminate-1",
				principal: "founder",
				evidence: [],
				now: "2026-08-14T01:30:00.000Z",
			}),
		).toEqual({ ok: true, status: "terminated", idempotentReplay: false });
		expect(store.getSession("implement-1")?.status).toBe("completed");
		expect(
			store.getCurrentWorkflowEngineParkEvidence("implement-1"),
		).toBeUndefined();
		expect(
			store
				.listWorkflowEngineParkEventsAfter("flywheel", 0)
				.find(
					(event) =>
						event.event_id ===
						`engine-park-settle:implement-1:${open.generation}`,
				),
		).toMatchObject({ event: "park_cleared" });
		store.close();
	});

	it("settles a runner-ship park on terminal run closeout and preserves its reason", async () => {
		const store = await compiledCodeEngineRun();
		completeCompiledCodeImplement(store);
		const reworkOpen =
			store.getCurrentWorkflowEngineParkEvidence("implement-1")!;
		store.appendWorkflowEngineParkEvent({
			eventId: "runner-ship-open",
			projectName: "flywheel",
			executionId: "implement-1",
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			activationId: reworkOpen.activation_id,
			event: "park_opened",
			reason: "runner_ship_gate_wait",
			createdAt: "2026-08-14T01:29:00.000Z",
		});
		const runnerShipOpen =
			store.getCurrentWorkflowEngineParkEvidence("implement-1")!;

		expect(
			store.terminateWorkflowRunByOperator({
				runId: "run-1",
				reason: "operator cancelled the run",
				clientRequestId: "terminate-runner-ship",
				principal: "founder",
				evidence: [],
				now: "2026-08-14T01:30:00.000Z",
			}),
		).toEqual({ ok: true, status: "terminated", idempotentReplay: false });
		expect(store.getSession("implement-1")?.status).toBe("completed");
		expect(
			store.getCurrentWorkflowEngineParkEvidence("implement-1"),
		).toBeUndefined();
		expect(
			store
				.listWorkflowEngineParkEventsAfter("flywheel", 0)
				.find(
					(event) =>
						event.event_id ===
						`engine-park-settle:implement-1:${runnerShipOpen.generation}`,
				),
		).toMatchObject({
			event: "park_cleared",
			reason: "runner_ship_gate_wait",
			generation: runnerShipOpen.generation + 1,
		});
		store.close();
	});

	it("fails closed when a canonical park-settlement id carries a different tuple", async () => {
		const store = await compiledCodeEngineRun();
		completeCompiledCodeImplement(store);
		const open = store.getCurrentWorkflowEngineParkEvidence("implement-1")!;
		store.appendWorkflowEngineParkEvent({
			eventId: `engine-park-settle:implement-1:${open.generation}`,
			projectName: "flywheel",
			executionId: "implement-1",
			runId: "run-1",
			nodeId: "qa",
			attempt: 1,
			activationId: open.activation_id,
			event: "park_cleared",
			reason: "rework_reachable_wait",
			createdAt: "2026-08-14T01:29:00.000Z",
		});

		expect(() =>
			store.terminateWorkflowRunByOperator({
				runId: "run-1",
				reason: "operator cancelled the run",
				clientRequestId: "terminate-conflicting-settlement",
				principal: "founder",
				evidence: [],
				now: "2026-08-14T01:30:00.000Z",
			}),
		).toThrow("workflow_engine_park_settlement_conflict");
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.getSession("implement-1")?.status).toBe("ship_parked");
		store.close();
	});

	it("settles the old actor park in the same transaction that materializes its replacement", async () => {
		const store = await compiledCodeEngineRun();
		completeCompiledCodeImplement(store);
		const { open, replacement } = prepareCompiledReworkReplacement(store);
		expect(
			store.materializeWorkflowReworkReplacement(replacement),
		).toMatchObject({
			ok: true,
			idempotentReplay: false,
		});
		const replacementAttachments = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "implement",
			attempt: 2,
		});
		expect(replacementAttachments.at(-1)).toMatchObject({
			receipt_kind: "rework_replacement",
			anchor_commit: "a".repeat(40),
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.find(
					(event) =>
						event.event_uid === replacementAttachments.at(-1)?.transition_uid,
				),
		).toMatchObject({ kind: "rework_replacement" });
		expect(store.getSession("implement-1")?.status).toBe("completed");
		expect(
			store.getCurrentWorkflowEngineParkEvidence("implement-1"),
		).toBeUndefined();
		expect(
			store
				.listWorkflowEngineParkEventsAfter("flywheel", 0)
				.find(
					(event) =>
						event.event_id ===
						`engine-park-settle:implement-1:${open.generation}`,
				),
		).toMatchObject({ event: "park_cleared" });
		expect(
			store.materializeWorkflowReworkReplacement(replacement),
		).toMatchObject({
			ok: true,
			idempotentReplay: true,
		});
		store.close();
	});

	it("does not consume a runner-ship park while materializing an active rework replacement", async () => {
		const store = await compiledCodeEngineRun();
		completeCompiledCodeImplement(store);
		const { open, replacement } = prepareCompiledReworkReplacement(store);
		store.appendWorkflowEngineParkEvent({
			eventId: "runner-ship-during-rework",
			projectName: "flywheel",
			executionId: "implement-1",
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			activationId: open.activation_id,
			event: "park_opened",
			reason: "runner_ship_gate_wait",
			createdAt: "2026-08-14T01:32:30.000Z",
		});

		expect(
			store.materializeWorkflowReworkReplacement(replacement),
		).toMatchObject({ ok: true, idempotentReplay: false });
		expect(store.getSession("implement-1")?.status).toBe("ship_parked");
		expect(
			store.getCurrentWorkflowEngineParkEvidence("implement-1"),
		).toBeUndefined();
		expect(
			store
				.listWorkflowEngineParkEventsAfter("flywheel", 0)
				.find((event) => event.event_id === "runner-ship-during-rework"),
		).toMatchObject({ reason: "runner_ship_gate_wait", event: "park_opened" });
		expect(
			store
				.listWorkflowEngineParkEventsAfter("flywheel", 0)
				.some((event) => event.event_id.startsWith("engine-park-settle:")),
		).toBe(false);
		store.close();
	});

	it("audits an invalid terminal park settlement during legacy-ledger finalization", async () => {
		const store = await compiledCodeEngineRun();
		completeCompiledCodeImplement(store);
		store.appendWorkflowEngineParkEvent({
			eventId: "runner-ship-control-open",
			projectName: "flywheel",
			executionId: "runner-ship-control",
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			activationId: "runner-ship-control-activation",
			event: "park_opened",
			reason: "runner_ship_gate_wait",
			createdAt: "2026-08-14T01:34:00.000Z",
		});
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run("UPDATE workflow_run SET engine_owned = 0 WHERE run_id = 'run-1'");

		store.applyWorkflowLedgerBatch({
			projectName: "flywheel",
			issueId: "FLY-1765",
			ops: [{ op: "finalize" }],
		});
		expect(store.getSession("implement-1")?.status).toBe("completed");
		expect(
			store.getCurrentWorkflowEngineParkEvidence("implement-1"),
		).toBeUndefined();
		expect(
			store
				.listWorkflowEngineParkEventsAfter("flywheel", 0)
				.filter((event) => event.execution_id === "runner-ship-control"),
		).toEqual([
			expect.objectContaining({
				event_id: "runner-ship-control-open",
				event: "park_opened",
				reason: "runner_ship_gate_wait",
			}),
		]);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter(
					(event) => event.kind === "workflow_engine_park_settlement_skipped",
				),
		).toEqual([
			expect.objectContaining({
				event_uid:
					"workflow_engine_park_settlement_skipped:run-1:runner-ship-control:1:activation_missing",
				payload: expect.objectContaining({
					reason: "activation_missing",
					parkReason: "runner_ship_gate_wait",
				}),
			}),
		]);
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
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
		});
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
		).toBeUndefined();
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
		store.upsertSession({
			execution_id: qaIntent!.execution_id,
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "qa",
		});
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
				gateEntryBinding: {
					kind: "worktree",
					prNumber: 1624,
					headSha: "a".repeat(40),
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					targetRepoPath: "/tmp/flywheel",
					worktreeBindingGeneration: "generation-1",
					expectedProducerMirrorHead: "a".repeat(40),
				},
				now: "2026-07-16T01:15:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.getCurrentWorkflowNodePrBindingForHead("run-1", "a".repeat(40)),
		).toMatchObject({ node_id: "qa", attempt: 1 });

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
		expect(store.getWorkflowCarrierDelivery(holder!.question_id)).toMatchObject(
			{
				run_id: "run-1",
				gate_node_id: "founder_gate",
				gate_attempt: 1,
				approved_head: "a".repeat(40),
				source_execution_id: "implement-1",
				state: "pending",
			},
		);
		const redrive = store.resolveWorkflowCarrierRedriveCanonical({
			runId: "run-1",
			questionId: holder!.question_id,
			approvedHead: "a".repeat(40),
			reason: "Lead confirmed the carrier is parked",
		});
		expect(redrive).toMatchObject({
			requestId: expect.stringMatching(/^carrier-redrive:[0-9a-f]{64}$/),
			sourceExecutionId: "implement-1",
		});
		if (!redrive) throw new Error("carrier redrive canonical missing");
		const redriveInput = {
			requestId: redrive.requestId,
			questionId: redrive.questionId,
			canonicalDigest: canonicalSubmissionDigest(redrive),
			principal: "master" as const,
			reason: redrive.reason,
			now: "2026-07-16T01:16:30.000Z",
		};
		expect(store.redriveWorkflowCarrierDelivery(redriveInput)).toEqual({
			ok: true,
			idempotentReplay: false,
		});
		expect(store.redriveWorkflowCarrierDelivery(redriveInput)).toEqual({
			ok: true,
			idempotentReplay: true,
		});
		expect(store.getWorkflowCarrierDelivery(holder!.question_id)).toMatchObject(
			{
				state: "pending",
				redrive_generation: 1,
				turn_epoch: null,
			},
		);
		const carrier = store.getWorkflowCarrierDelivery(holder!.question_id)!;
		const carrierClaim = store.claimWorkflowCarrierDelivery({
			questionId: holder!.question_id,
			ownerId: "receipt-test",
			now: "2026-07-16T01:17:00.000Z",
			leaseExpiresAt: "2026-07-16T01:18:00.000Z",
		});
		expect(carrierClaim).toMatchObject({ ok: true });
		if (!carrierClaim.ok) throw new Error("carrier claim failed");
		// A pending delivery, including a live lease/backoff window, is healthy and
		// must not create a cross-ledger TURN expectation yet.
		expect(
			store
				.listWorkflowTurnExpectations()
				.filter((item) => item.source === "carrier"),
		).toEqual([]);
		expect(
			store.advanceWorkflowCarrierDelivery({
				questionId: holder!.question_id,
				ownerId: "receipt-test",
				generation: carrierClaim.generation,
				from: "pending",
				to: "grant_started",
				now: "2026-07-16T01:17:01.000Z",
			}),
		).toEqual({ ok: true });
		expect(
			store.recordWorkflowCarrierActivationTurn({
				questionId: holder!.question_id,
				ownerId: "receipt-test",
				generation: carrierClaim.generation,
				activationId: carrier.carrier_activation_id,
				issueId: "FLY-1307",
				executionId: "implement-1",
				epoch: 7,
				sourceEventId: "ship-turn:receipt-test",
				grantedAt: "2026-07-16T01:17:02.000Z",
			}),
		).toMatchObject({ ok: true });
		const wakeClaim = store.claimWorkflowWakeSend({
			wakeId: "carrier-wake:receipt-test",
			runId: "run-1",
			nodeId: "founder_gate",
			attempt: 1,
			executionId: "implement-1",
			activationId: carrier.carrier_activation_id,
			epoch: 7,
			ownerId: "receipt-test",
			now: "2026-07-16T01:17:02.100Z",
			leaseExpiresAt: "2026-07-16T01:17:32.100Z",
		});
		expect(wakeClaim).toMatchObject({ ok: true });
		if (!wakeClaim.ok) throw new Error("wake claim failed");
		expect(
			store.completeWorkflowWakeSend({
				wakeId: "carrier-wake:receipt-test",
				ownerId: "receipt-test",
				generation: wakeClaim.generation,
				now: "2026-07-16T01:17:02.200Z",
				result: "sent",
			}),
		).toEqual({ ok: true });
		store.setSessionParams("implement-1", { status: "completed" });
		expect(
			store.inspectWorkflowTurnWakeRetry({
				wakeId: "carrier-wake:receipt-test",
				executionId: "implement-1",
				activationId: carrier.carrier_activation_id,
				epoch: 7,
			}),
		).toEqual({ disposition: "deliver" });
		expect(
			store.advanceWorkflowCarrierDelivery({
				questionId: holder!.question_id,
				ownerId: "receipt-test",
				generation: carrierClaim.generation,
				from: "turn_granted",
				to: "awaiting_receipt",
				now: "2026-07-16T01:17:03.000Z",
				releaseOwner: true,
			}),
		).toEqual({ ok: true });
		expect(
			store.recordWorkflowCarrierWakeReceipt({
				activationId: carrier.carrier_activation_id,
				executionId: "implement-1",
				epoch: 7,
				ackedAt: "2026-07-16T01:17:04.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(store.getWorkflowCarrierDelivery(holder!.question_id)?.state).toBe(
			"receipt_started",
		);
		expect(
			store.inspectWorkflowTurnWakeRetry({
				wakeId: "carrier-wake:receipt-test",
				executionId: "implement-1",
				activationId: carrier.carrier_activation_id,
				epoch: 7,
			}),
		).toEqual({
			disposition: "cancel",
			reason: "carrier_obligation_settled",
		});
		const turnExpectation = store
			.listWorkflowTurnExpectations()
			.find((item) => item.source === "carrier")!;
		expect(turnExpectation).toMatchObject({
			executionId: "implement-1",
			epoch: 7,
			activationId: carrier.carrier_activation_id,
		});
		const divergence = {
			expectationKey: turnExpectation.expectationKey,
			runId: turnExpectation.runId,
			issueId: turnExpectation.issueId,
			projectName: turnExpectation.projectName,
			expectedExecutionId: turnExpectation.executionId,
			expectedEpoch: turnExpectation.epoch,
			expectedActivationId: turnExpectation.activationId,
			observedExecutionId: "qa-old",
			observedEpoch: 6,
			observedActivationId: null,
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
		};
		expect(
			store.observeWorkflowTurnDivergence({
				...divergence,
				now: "2026-07-16T01:23:00.000Z",
				alertEnabled: false,
			}),
		).toEqual({ opened: true, alerted: false });
		expect(
			store.observeWorkflowTurnDivergence({
				...divergence,
				now: "2026-07-16T01:24:00.000Z",
			}),
		).toEqual({ opened: false, alerted: true });
		expect(store.listOpenWorkflowTurnDivergences()).toHaveLength(1);
		expect(
			store.closeWorkflowTurnDivergence({
				expectationKey: turnExpectation.expectationKey,
				now: "2026-07-16T01:25:00.000Z",
				reason: "recovered",
			}),
		).toBe(true);
		expect(store.listOpenWorkflowTurnDivergences()).toEqual([]);
		expect(
			store.observeWorkflowTurnDivergence({
				...divergence,
				now: "2026-07-16T01:26:00.000Z",
			}),
		).toEqual({ opened: true, alerted: true });
		expect(
			store
				.listWorkflowAlertOutbox()
				.filter(
					(alert) =>
						alert.payload.metadata.workflowEngine.disposition ===
						"turn_ledger_divergence",
				),
		).toHaveLength(2);
		expect(
			store.resolveWorkflowCarrierRedriveCanonical({
				runId: "run-1",
				questionId: holder!.question_id,
				approvedHead: "a".repeat(40),
				reason: "must not duplicate a consumed carrier",
			}),
		).toBeUndefined();
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

	it("rejects a runner-ship gate when QA proof is for an older head", async () => {
		const store = await engineRun({ gateCarrier: true });
		const oldQaHead = "a".repeat(40);
		const revivedRunnerHead = "b".repeat(40);

		await openRunnerShipGate(store, {
			gateEntryHead: oldQaHead,
			runnerHead: revivedRunnerHead,
			omitGateEntryBinding: true,
			expectedTransitionRefusal: "engine_invariant:runner_ship_qa_head_stale",
		});

		expect(store.getWorkflowRun("run-1")).toMatchObject({
			status: "active",
			current_node_id: "qa",
		});
		expect(
			store.getCurrentWorkflowGateHolder("run-1", "founder_gate"),
		).toBeUndefined();
		expect(
			store
				.listWorkflowAlertOutbox()
				.filter((alert) =>
					alert.escalation_uid.endsWith(":runner_ship_qa_head_stale"),
				),
		).toHaveLength(1);
		store.close();
	});

	it("revokes an older QA PASS as soon as a newer producer head is bound", async () => {
		const store = await engineRun({ gateCarrier: true });
		const oldHead = "a".repeat(40);
		const newHead = "b".repeat(40);
		await openRunnerShipGate(store, { runnerHead: oldHead });

		expect(
			store.resolveWorkflowDecisionClaim({
				runId: "run-1",
				nodeId: "qa",
				decisionKind: "qa_verdict",
				predicate: "qa_passed",
				requiredAttempt: 1,
				subjectKind: "git_head",
				subjectDigest: oldHead,
				now: "2026-07-16T01:16:00.000Z",
			}),
		).toMatchObject({ valid: true });

		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_run SET current_node_id = 'implement' WHERE run_id = 'run-1'",
		);
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 2,
			state: "pending",
			executionId: "implement-2",
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "implement",
				executionId: "implement-2",
				attempt: 2,
				expiresAt: "2026-07-16T03:00:00.000Z",
				absoluteDeadlineAt: "2026-07-17T00:00:00.000Z",
				now: "2026-07-16T01:17:00.000Z",
				env: menuEngineFlags,
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "implement-2",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "implement",
		});
		expect(
			store.commitEnrolledCompletion({
				executionId: "implement-2",
				route: "needs_review",
				sourceEventId: "complete-implement-new-head",
				completionSubmission: { decision: { route: "needs_review" } },
				subjectDigest: newHead,
				prBinding: {
					prNumber: 1624,
					headSha: newHead,
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					targetRepoPath: "/tmp/flywheel",
					worktreeBindingGeneration: "generation-2",
				},
				now: "2026-07-16T01:18:00.000Z",
			}),
		).toMatchObject({ ok: true });

		expect(
			store.resolveWorkflowDecisionClaim({
				runId: "run-1",
				nodeId: "qa",
				decisionKind: "qa_verdict",
				predicate: "qa_passed",
				requiredAttempt: 1,
				subjectKind: "git_head",
				subjectDigest: oldHead,
				now: "2026-07-16T01:19:00.000Z",
			}),
		).toEqual({ valid: false, reason: "revoked" });
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "claim_revoked"),
		).toContainEqual(
			expect.objectContaining({
				payload: expect.objectContaining({
					reason: "materialized_head_superseded",
					actor: "workflow_head_binding",
				}),
			}),
		);
		store.close();
	});

	it("rejects a terminal session's new completion/claim but preserves exact replay", async () => {
		const store = await compiledCodeEngineRun();
		const first = completeCompiledCodeImplement(store);
		expect(first.completion).toMatchObject({
			ok: true,
			idempotentReplay: false,
		});
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1765",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "implement",
		});

		expect(
			store.commitEnrolledCompletion({
				executionId: "implement-1",
				route: "needs_review",
				sourceEventId: "complete-implement-1",
				completionSubmission: { decision: { route: "needs_review" } },
				subjectDigest: "a".repeat(40),
				prBinding: {
					prNumber: 1765,
					headSha: "a".repeat(40),
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					targetRepoPath: "/tmp/flywheel-FLY-1765",
					worktreeBindingGeneration: "generation-1",
				},
				now: "2026-08-14T01:11:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: true });
		store.close();

		const revived = await compiledCodeEngineRun();
		advance(revived, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
		expect(
			revived.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "implement",
				executionId: "implement-1",
				attempt: 1,
				expiresAt: "2026-08-14T02:00:00.000Z",
				absoluteDeadlineAt: "2026-08-15T00:00:00.000Z",
				now: "2026-08-14T01:05:00.000Z",
				env: menuEngineFlags,
			}),
		).toMatchObject({ ok: true });
		revived.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1765",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});
		expect(
			revived.commitEnrolledCompletion({
				executionId: "implement-1",
				route: "needs_review",
				sourceEventId: "revived-completion",
				completionSubmission: { decision: { route: "needs_review" } },
				subjectDigest: "b".repeat(40),
				alertIdentity: carrierAlertIdentity,
				now: "2026-08-14T01:10:00.000Z",
			}),
		).toMatchObject({
			ok: false,
			reason: "transition_refused",
			detail: { transitionReason: "engine_invariant:writer_session_terminal" },
		});
		expect(revived.getWorkflowRun("run-1")?.current_node_id).toBe("implement");
		expect(
			revived.getWorkflowNodeCompletion("run-1", "implement", 1),
		).toBeUndefined();
		expect(
			revived
				.listWorkflowAlertOutbox()
				.filter((alert) =>
					alert.escalation_uid.endsWith(":writer_session_terminal"),
				),
		).toHaveLength(1);
		revived.close();

		const claimStore = await engineRun();
		advance(claimStore, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});
		advance(claimStore, {
			nodeId: "implement",
			attempt: 1,
			executionId: "implement-1",
			outcome: "implement_done",
			successorExecutionId: "qa-1",
		});
		const qaAdmission = claimStore.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "qa",
			executionId: "qa-1",
			attempt: 1,
			expiresAt: "2026-07-16T02:00:00.000Z",
			absoluteDeadlineAt: "2026-07-16T03:00:00.000Z",
			now: "2026-07-16T01:00:00.000Z",
			env: engineFlags,
		});
		if (!qaAdmission.ok || !qaAdmission.submissionCredential) {
			throw new Error("QA admission failed");
		}
		claimStore.upsertSession({
			execution_id: "qa-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "qa",
		});
		expect(
			claimStore.submitWorkflowDecisionByCredential({
				credential: qaAdmission.submissionCredential,
				clientRequestId: "revived-qa-claim",
				predicate: "qa_failed",
				subjectDigest: "a".repeat(40),
				issuerVendor: "claude",
				issuerModel: "claude-opus-4-8",
				subjectProducerExecutionId: "implement-1",
				subjectProducerVendor: "codex",
				claimExpiresAt: "2026-07-16T02:00:00.000Z",
				alertIdentity: carrierAlertIdentity,
				now: "2026-07-16T01:05:00.000Z",
			}),
		).toMatchObject({
			ok: false,
			reason: "credential_revoked",
		});
		expect(claimStore.countWorkflowClaims("run-1")).toBe(0);
		claimStore.close();
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

	it.each([
		[
			"activation SELECT",
			(store: StateStore) =>
				vi
					.spyOn(
						store as unknown as {
							workflowSelectAll: (
								...args: unknown[]
							) => Array<Record<string, unknown>>;
						},
						"workflowSelectAll",
					)
					.mockImplementation(() => {
						throw new Error("SQLITE_BUSY: activation SELECT");
					}),
		],
		[
			"workflow run SELECT",
			(store: StateStore) =>
				vi.spyOn(store, "getWorkflowRun").mockImplementation(() => {
					throw new Error("SQLITE_IOERR: workflow run SELECT");
				}),
		],
		[
			"holder SELECT",
			(store: StateStore) =>
				vi
					.spyOn(store, "getCurrentWorkflowGateHolder")
					.mockImplementation(() => {
						throw new Error("SQLITE_CORRUPT: holder SELECT");
					}),
		],
	] as const)(
		"does not rewrite an infrastructure error from the %s seam",
		async (_name, inject) => {
			const store = await engineRun({ gateCarrier: true });
			const holder = await openRunnerShipGate(store);
			inject(store);
			try {
				expect(() =>
					store.workflowGatePresentationDisposition({
						executionId: holder.source_execution_id,
						checkpoint: "approve_to_ship",
						questionId: holder.question_id,
					}),
				).toThrow(/SQLITE_(?:BUSY|IOERR|CORRUPT)/);
			} finally {
				vi.restoreAllMocks();
				store.close();
			}
		},
	);

	it("atomically rebinds an unbound Gate carrier and replays without resetting its review window", async () => {
		const store = await engineRun({ gateCarrier: true });
		const holder = await openRunnerShipGate(store, { forceUnbound: true });
		expect(holder).toMatchObject({
			authority_mode: "runner_ship",
			carrier_binding_state: "unbound",
			materialization_stage: "question_intent",
		});
		expect(
			store.workflowGatePresentationDisposition({
				executionId: holder.source_execution_id,
				checkpoint: "approve_to_ship",
				questionId: holder.question_id,
			}),
		).toEqual({ allow: false, reason: "holder_carrier_unbound" });
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

	it("rebinds a delayed runner-ship carrier through the persisted B-to-T mirror fence", async () => {
		const store = await engineRun({ gateCarrier: true });
		const gateEntryHead = "c".repeat(40);
		const holder = await openRunnerShipGate(store, {
			delayCarrier: true,
			gateEntryHead,
		});
		expect(holder).toMatchObject({
			carrier_binding_state: "unbound",
			head_sha: gateEntryHead,
		});
		expect(
			store.getCurrentWorkflowNodePrBindingForHead("run-1", gateEntryHead),
		).toMatchObject({ node_id: "qa" });

		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "ship_parked",
			pr_number: 1624,
			pr_head_sha: "a".repeat(40),
		});
		const canonical = store.resolveWorkflowGateCarrierRebindCanonical(
			holder.question_id,
			"implement-1",
		);
		expect(canonical).toMatchObject({
			candidateExecutionId: "implement-1",
			subjectDigest: gateEntryHead,
		});
		if (!canonical) throw new Error("mirror-fenced rebind unavailable");
		expect(
			store.rebindWorkflowGateCarrier({
				requestId: canonical.requestId,
				questionId: holder.question_id,
				candidateExecutionId: "implement-1",
				canonicalDigest: canonicalSubmissionDigest(canonical),
				now: "2026-07-16T01:20:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		expect(store.getSession("implement-1")).toMatchObject({
			status: "awaiting_review",
			pr_head_sha: gateEntryHead,
			review_question_id: holder.question_id,
		});
		expect(
			store.getWorkflowShipTargetBinding(holder.question_id),
		).toMatchObject({ frozen_head_sha: gateEntryHead });
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

	it("settles an owned carrier when its workflow run becomes terminal", async () => {
		const { store, holder } = await approvedCarrierRun();
		const claim = store.claimWorkflowCarrierDelivery({
			questionId: holder.question_id,
			ownerId: "carrier-terminal-test",
			now: "2026-07-16T01:17:00.000Z",
			leaseExpiresAt: "2026-07-16T01:18:00.000Z",
		});
		expect(claim).toMatchObject({ ok: true });
		if (!claim.ok) throw new Error("carrier claim failed");
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			"UPDATE workflow_run SET status = 'completed' WHERE run_id = 'run-1'",
		);

		expect(
			store.settleWorkflowCarrierFailure({
				questionId: holder.question_id,
				ownerId: "carrier-terminal-test",
				generation: claim.generation,
				reason: "carrier_context_unavailable",
				alertIdentity: carrierAlertIdentity,
				now: "2026-07-16T01:17:01.000Z",
			}),
		).toEqual({
			ok: true,
			holdCount: 0,
			state: "completed",
			nextRetryAt: null,
		});
		expect(store.getWorkflowCarrierDelivery(holder.question_id)).toMatchObject({
			state: "completed",
			owner_id: null,
			lease_expires_at: null,
			next_retry_at: null,
			last_error: "run_terminal:completed",
		});
		expect(
			store.listWorkflowCarrierDeliveries({
				now: "2026-07-16T01:30:00.000Z",
			}),
		).toEqual([]);
		expect(
			store.listWorkflowRunEvents("run-1").map((event) => event.kind),
		).toContain("carrier_delivery_cancelled");
		expect(store.listWorkflowAlertOutbox()).toEqual([
			expect.objectContaining({
				escalation_uid: `carrier_delivery_cancelled:${holder.question_id}`,
				payload: expect.objectContaining({
					eventId: `carrier_delivery_cancelled:${holder.question_id}`,
					body: expect.stringContaining("request operator rework"),
					metadata: {
						workflowEngine: expect.objectContaining({
							disposition: "carrier_delivery_cancelled",
						}),
					},
				}),
			}),
		]);
		store.close();
	});

	it("holds an owned carrier visibly and preserves active-run retry budget", async () => {
		const { store, holder } = await approvedCarrierRun();
		const claim = store.claimWorkflowCarrierDelivery({
			questionId: holder.question_id,
			ownerId: "carrier-held-test",
			now: "2026-07-16T01:17:00.000Z",
			leaseExpiresAt: "2026-07-16T01:18:00.000Z",
		});
		if (!claim.ok) throw new Error("carrier claim failed");
		const request = {
			runId: "run-1",
			reason: "pane loss recovery",
			clientRequestId: "hold-carrier-run",
			principal: "master",
			evidence: [],
			now: "2026-07-16T01:17:01.000Z",
		};
		expect(store.holdWorkflowRunByOperator(request)).toMatchObject({
			ok: true,
			status: "held",
		});

		const settled = store.settleWorkflowCarrierFailure({
			questionId: holder.question_id,
			ownerId: "carrier-held-test",
			generation: claim.generation,
			reason: "run is temporarily held",
			alertIdentity: carrierAlertIdentity,
			now: "2026-07-16T01:17:02.000Z",
		});
		expect(settled).toEqual({
			ok: true,
			holdCount: 0,
			state: "held",
			nextRetryAt: null,
		});
		expect(store.getWorkflowCarrierDelivery(holder.question_id)).toMatchObject({
			state: "held",
			hold_count: 0,
			last_error: "run_inactive:held",
		});
		expect(
			store.listWorkflowRunEvents("run-1").map((event) => event.kind),
		).toContain("carrier_delivery_held");
		expect(store.listWorkflowAlertOutbox()).toEqual([
			expect.objectContaining({
				escalation_uid: `carrier_delivery_held:${holder.question_id}:${claim.generation}`,
				payload: expect.objectContaining({
					eventId: `carrier_delivery_held:${holder.question_id}:${claim.generation}`,
					body: expect.stringMatching(
						/recover the held workflow run.*automatically revive.*only if the run is active/is,
					),
					metadata: {
						workflowEngine: expect.objectContaining({
							disposition: "carrier_delivery_held",
						}),
					},
				}),
			}),
		]);
		expect(
			store.settleWorkflowCarrierFailure({
				questionId: holder.question_id,
				ownerId: "carrier-held-test",
				generation: claim.generation,
				reason: "replayed failure",
				alertIdentity: carrierAlertIdentity,
				now: "2026-07-16T01:17:03.000Z",
			}),
		).toEqual({ ok: false, reason: "stale_delivery_owner" });
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		store.close();
	});

	it("keeps the existing active-run carrier retry behavior byte-compatible", async () => {
		const { store, holder } = await approvedCarrierRun();
		const claim = store.claimWorkflowCarrierDelivery({
			questionId: holder.question_id,
			ownerId: "carrier-active-test",
			now: "2026-07-16T01:17:00.000Z",
			leaseExpiresAt: "2026-07-16T01:18:00.000Z",
		});
		if (!claim.ok) throw new Error("carrier claim failed");

		expect(
			store.settleWorkflowCarrierFailure({
				questionId: holder.question_id,
				ownerId: "carrier-active-test",
				generation: claim.generation,
				reason: "temporary delivery error",
				alertIdentity: carrierAlertIdentity,
				now: "2026-07-16T01:17:01.000Z",
			}),
		).toEqual({
			ok: true,
			holdCount: 1,
			state: "pending",
			nextRetryAt: "2026-07-16T01:18:01.000Z",
		});
		expect(store.getWorkflowCarrierDelivery(holder.question_id)).toMatchObject({
			state: "pending",
			hold_count: 1,
			last_error: "temporary delivery error",
		});
		expect(store.listWorkflowAlertOutbox()).toEqual([]);
		store.close();
	});

	it("keeps carrier failure identities unique after operator redrive resets hold count", async () => {
		const { store, holder } = await approvedCarrierRun();
		const firstClaim = store.claimWorkflowCarrierDelivery({
			questionId: holder.question_id,
			ownerId: "carrier-before-redrive",
			now: "2026-07-16T01:17:00.000Z",
			leaseExpiresAt: "2026-07-16T01:18:00.000Z",
		});
		if (!firstClaim.ok) throw new Error("first carrier claim failed");
		expect(
			store.settleWorkflowCarrierFailure({
				questionId: holder.question_id,
				ownerId: "carrier-before-redrive",
				generation: firstClaim.generation,
				reason: "first delivery failure",
				alertIdentity: carrierAlertIdentity,
				now: "2026-07-16T01:17:01.000Z",
			}),
		).toMatchObject({ ok: true, holdCount: 1, state: "pending" });

		const redrive = store.resolveWorkflowCarrierRedriveCanonical({
			runId: "run-1",
			questionId: holder.question_id,
			approvedHead: "a".repeat(40),
			reason: "retry the approved carrier",
		});
		if (!redrive) throw new Error("carrier redrive canonical missing");
		expect(
			store.redriveWorkflowCarrierDelivery({
				requestId: redrive.requestId,
				questionId: redrive.questionId,
				canonicalDigest: canonicalSubmissionDigest(redrive),
				principal: "master",
				reason: redrive.reason,
				now: "2026-07-16T01:17:30.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });

		const secondClaim = store.claimWorkflowCarrierDelivery({
			questionId: holder.question_id,
			ownerId: "carrier-after-redrive",
			now: "2026-07-16T01:18:00.000Z",
			leaseExpiresAt: "2026-07-16T01:19:00.000Z",
		});
		if (!secondClaim.ok) throw new Error("second carrier claim failed");
		expect(
			store.settleWorkflowCarrierFailure({
				questionId: holder.question_id,
				ownerId: "carrier-after-redrive",
				generation: secondClaim.generation,
				reason: "failure after operator redrive",
				alertIdentity: carrierAlertIdentity,
				now: "2026-07-16T01:18:01.000Z",
			}),
		).toMatchObject({ ok: true, holdCount: 1, state: "pending" });
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "carrier_delivery_retry")
				.map((event) => event.event_uid),
		).toEqual([
			`carrier_delivery_failure:${holder.question_id}:${firstClaim.generation}:1`,
			`carrier_delivery_failure:${holder.question_id}:${secondClaim.generation}:1`,
		]);
		store.close();
	});

	it("emits a fresh exhaustion episode when a redriven carrier exhausts again", async () => {
		const { store, holder } = await approvedCarrierRun();
		const baseMs = Date.parse("2026-07-16T01:17:00.000Z");
		let attemptIndex = 0;
		const failOnce = (episode: string) => {
			const nowMs = baseMs + attemptIndex * 10 * 60_000;
			attemptIndex += 1;
			const claim = store.claimWorkflowCarrierDelivery({
				questionId: holder.question_id,
				ownerId: `carrier-${episode}-${attemptIndex}`,
				now: new Date(nowMs).toISOString(),
				leaseExpiresAt: new Date(nowMs + 60_000).toISOString(),
			});
			if (!claim.ok) throw new Error(`carrier ${episode} claim failed`);
			return {
				generation: claim.generation,
				result: store.settleWorkflowCarrierFailure({
					questionId: holder.question_id,
					ownerId: `carrier-${episode}-${attemptIndex}`,
					generation: claim.generation,
					reason: `${episode} failure ${attemptIndex}`,
					alertIdentity: carrierAlertIdentity,
					now: new Date(nowMs + 1_000).toISOString(),
				}),
			};
		};

		let firstExhaustionGeneration = 0;
		for (let index = 0; index < 5; index += 1) {
			const failed = failOnce("before-redrive");
			firstExhaustionGeneration = failed.generation;
			expect(failed.result).toMatchObject({
				ok: true,
				holdCount: index + 1,
				state: index === 4 ? "needs_lead" : "pending",
			});
		}

		const redrive = store.resolveWorkflowCarrierRedriveCanonical({
			runId: "run-1",
			questionId: holder.question_id,
			approvedHead: "a".repeat(40),
			reason: "retry after first exhaustion",
		});
		if (!redrive) throw new Error("carrier redrive canonical missing");
		expect(
			store.redriveWorkflowCarrierDelivery({
				requestId: redrive.requestId,
				questionId: redrive.questionId,
				canonicalDigest: canonicalSubmissionDigest(redrive),
				principal: "master",
				reason: redrive.reason,
				now: new Date(
					baseMs + attemptIndex * 10 * 60_000 - 1_000,
				).toISOString(),
			}),
		).toEqual({ ok: true, idempotentReplay: false });

		let secondExhaustionGeneration = 0;
		for (let index = 0; index < 5; index += 1) {
			const failed = failOnce("after-redrive");
			secondExhaustionGeneration = failed.generation;
			expect(failed.result).toMatchObject({
				ok: true,
				holdCount: index + 1,
				state: index === 4 ? "needs_lead" : "pending",
			});
		}
		expect(
			store.listWorkflowAlertOutbox().map((alert) => alert.escalation_uid),
		).toEqual([
			`carrier_delivery_exhausted:${holder.question_id}:${firstExhaustionGeneration}`,
			`carrier_delivery_exhausted:${holder.question_id}:${secondExhaustionGeneration}`,
		]);
		store.close();
	});

	it("revives held carriers atomically with pane-loss run recovery", async () => {
		const { store, holder } = await approvedCarrierRun();
		const opened = store.openOperatorRework({
			runId: "run-1",
			targetNodeId: "implement",
			feedback: "replace the missing carrier actor",
			clientRequestId: "operator-rework-for-pane-loss",
			principal: "master",
			evidence: [],
			now: "2026-07-16T01:18:00.000Z",
		});
		if (!opened.ok) throw new Error(opened.reason);
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		raw.run(
			`UPDATE workflow_carrier_delivery
			    SET state = 'held', hold_count = 2, generation = 3,
			        owner_id = NULL, lease_expires_at = NULL, next_retry_at = NULL,
			        last_error = 'run_inactive:held'
			  WHERE question_id = ?`,
			[holder.question_id],
		);
		raw.run("UPDATE workflow_run SET status = 'held' WHERE run_id = 'run-1'");
		raw.run(
			`UPDATE workflow_rework_delivery
			    SET state = 'held', last_error = 'persisted_target_missing'
			  WHERE request_id = ?`,
			[opened.requestId],
		);
		raw.run(
			"UPDATE sessions SET status = 'failed' WHERE execution_id = 'implement-1'",
		);
		for (const [questionId, generation, lastError] of [
			["carrier-second-episode", 7, "run_inactive:held"],
			["carrier-manual-hold", 11, "operator_pause"],
		] as const) {
			raw.run(
				`INSERT INTO workflow_gate_holder
				   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
				    question_id, authority_mode, subject_kind, carrier_binding_state,
				    state, materialization_stage, superseded_reason, created_at, updated_at)
				 VALUES ('run-1', ?, 1, ?, ?, ?, 'runner_ship', 'git_head', 'bound',
				         'superseded', 'completed', 'test_fixture', ?, ?)`,
				[
					`gate-${questionId}`,
					"b".repeat(40),
					`exec-${questionId}`,
					questionId,
					"2026-07-16T01:18:30.000Z",
					"2026-07-16T01:18:30.000Z",
				],
			);
			raw.run(
				`INSERT INTO workflow_carrier_delivery
				   (question_id, run_id, gate_node_id, gate_attempt, approved_head,
				    source_execution_id, carrier_activation_id, generation, state,
				    hold_count, last_error, created_at, updated_at)
				 VALUES (?, 'run-1', ?, 1, ?, ?, ?, ?, 'held', 3, ?, ?, ?)`,
				[
					questionId,
					`gate-${questionId}`,
					"b".repeat(40),
					`exec-${questionId}`,
					`activation-${questionId}`,
					generation,
					lastError,
					"2026-07-16T01:18:30.000Z",
					"2026-07-16T01:18:30.000Z",
				],
			);
		}

		expect(
			store.materializeWorkflowReworkReplacement({
				requestId: opened.requestId,
				deadExecutionId: "implement-1",
				newExecutionId: "implement-replacement",
				reason: "persisted target disappeared",
				observedAt: "2026-07-16T01:19:00.000Z",
				recoverHeldPaneLoss: true,
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.getWorkflowCarrierDelivery(holder.question_id)).toMatchObject({
			state: "pending",
			hold_count: 2,
			owner_id: null,
			lease_expires_at: null,
			next_retry_at: null,
			last_error: "pane_loss_recovery:persisted target disappeared",
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "carrier_delivery_revived"),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event_uid: `carrier_delivery_revived:${holder.question_id}:3`,
				}),
				expect.objectContaining({
					event_uid: "carrier_delivery_revived:carrier-second-episode:7",
				}),
			]),
		);
		expect(
			store.getWorkflowCarrierDelivery("carrier-second-episode"),
		).toMatchObject({
			state: "pending",
			hold_count: 3,
			last_error: "pane_loss_recovery:persisted target disappeared",
		});
		expect(
			store.getWorkflowCarrierDelivery("carrier-manual-hold"),
		).toMatchObject({
			state: "held",
			hold_count: 3,
			last_error: "operator_pause",
		});
		expect(
			store.claimWorkflowCarrierDelivery({
				questionId: holder.question_id,
				ownerId: "revived-carrier-owner",
				now: "2026-07-16T01:19:00.000Z",
				leaseExpiresAt: "2026-07-16T01:20:00.000Z",
			}),
		).toMatchObject({ ok: true, generation: 4 });
		store.close();
	});

	it.each([
		["pending", true],
		["grant_started", true],
		["turn_granted", true],
		["held", true],
		["wake_delivered", false],
		["receipt_started", false],
	] as const)(
		"operator rework %s carrier cancellation=%s",
		async (state, cancelled) => {
			const { store, holder } = await approvedCarrierRun();
			const raw = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			raw.run(
				`UPDATE workflow_carrier_delivery
				    SET state = ?, generation = 4, owner_id = 'carrier-owner',
				        lease_expires_at = '2026-07-16T01:20:00.000Z',
				        next_retry_at = '2026-07-16T01:21:00.000Z'
				  WHERE question_id = ?`,
				[state, holder.question_id],
			);

			const opened = store.openOperatorRework({
				runId: "run-1",
				targetNodeId: "implement",
				feedback: "replace the approved implementation",
				clientRequestId: `operator-rework-carrier-${state}`,
				principal: "master",
				evidence: [],
				now: "2026-07-16T01:18:00.000Z",
			});
			expect(opened).toMatchObject({ ok: true });
			expect(
				store.getWorkflowCarrierDelivery(holder.question_id),
			).toMatchObject(
				cancelled
					? {
							state: "completed",
							owner_id: null,
							lease_expires_at: null,
							next_retry_at: null,
							last_error: "operator_rework_superseded",
						}
					: {
							state,
							owner_id: "carrier-owner",
							lease_expires_at: "2026-07-16T01:20:00.000Z",
							next_retry_at: "2026-07-16T01:21:00.000Z",
						},
			);
			const cancellationEvents = store
				.listWorkflowRunEvents("run-1")
				.filter(
					(event) =>
						event.event_uid ===
						`carrier_delivery_cancelled:${holder.question_id}:4:operator_rework`,
				);
			expect(cancellationEvents).toHaveLength(cancelled ? 1 : 0);
			store.close();
		},
	);

	it.each(["pending", "held"] as const)(
		"operator termination closes a %s carrier exactly once",
		async (state) => {
			const { store, holder } = await approvedCarrierRun();
			const raw = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			if (state === "held") {
				expect(
					store.holdWorkflowRunByOperator({
						runId: "run-1",
						reason: "pane loss recovery",
						clientRequestId: "operator-hold-before-terminate",
						principal: "master",
						evidence: [],
						now: "2026-07-16T01:17:00.000Z",
					}),
				).toMatchObject({ ok: true, status: "held" });
			}
			raw.run(
				`UPDATE workflow_carrier_delivery
				    SET state = ?, generation = 5, owner_id = 'carrier-owner',
				        lease_expires_at = '2026-07-16T01:20:00.000Z',
				        next_retry_at = '2026-07-16T01:21:00.000Z',
				        last_error = ?
				  WHERE question_id = ?`,
				[
					state,
					state === "held" ? "run_inactive:held" : null,
					holder.question_id,
				],
			);
			const terminate = {
				runId: "run-1",
				reason: "operator closed the run",
				clientRequestId: `operator-terminate-carrier-${state}`,
				principal: "master",
				evidence: [],
				now: "2026-07-16T01:18:00.000Z",
			};
			expect(store.terminateWorkflowRunByOperator(terminate)).toMatchObject({
				ok: true,
				status: "terminated",
				idempotentReplay: false,
			});
			expect(store.terminateWorkflowRunByOperator(terminate)).toMatchObject({
				ok: true,
				status: "terminated",
				idempotentReplay: true,
			});
			expect(
				store.getWorkflowCarrierDelivery(holder.question_id),
			).toMatchObject({
				state: "completed",
				owner_id: null,
				lease_expires_at: null,
				next_retry_at: null,
				last_error: "operator_terminate:operator closed the run",
			});
			expect(
				store
					.listWorkflowRunEvents("run-1")
					.filter(
						(event) =>
							event.event_uid ===
							`carrier_delivery_cancelled:${holder.question_id}:5:operator_terminate`,
					),
			).toHaveLength(1);
			store.close();
		},
	);

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

	it("keeps the default Code QA loop active beyond five failures without a max payload", async () => {
		const store = await compiledCodeEngineRun();
		const settleOpenRework = () => {
			const db = (
				store as unknown as {
					db: { run(sql: string): void };
				}
			).db;
			db.run(
				"UPDATE workflow_rework_delivery SET state = 'completed' WHERE state IN ('pending','turn_granted','wake_delivered','replacement_pending')",
			);
			db.run(
				"UPDATE workflow_rework_verification_path SET state = 'completed' WHERE state IN ('pending','active')",
			);
		};
		advance(store, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-1",
		});

		for (let attempt = 1; attempt <= 5; attempt += 1) {
			advance(store, {
				nodeId: "implement",
				attempt,
				executionId: "implement-1",
				outcome: "implement_done",
				successorExecutionId: "qa-1",
			});
			const failure = advance(store, {
				nodeId: "qa",
				attempt,
				executionId: "qa-1",
				outcome: "qa_fail",
			});
			expect(failure).toMatchObject({
				ok: true,
				loopIteration: attempt,
				targetNodeId: "implement",
				targetAttempt: attempt + 1,
			});
			expect(failure.ok && failure.escalated).toBeUndefined();
			expect(store.getWorkflowRun("run-1")?.status).toBe("active");
			if (attempt < 5) settleOpenRework();
		}

		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "loop_iteration")
				.map((event) => event.payload),
		).toEqual([
			{ iteration: 1 },
			{ iteration: 2 },
			{ iteration: 3 },
			{ iteration: 4 },
			{ iteration: 5 },
		]);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "loop_limit_escalated"),
		).toHaveLength(0);
		expect(
			store
				.listWorkflowRunNodes("run-1", "implement")
				.map((node) => node.attempt),
		).toEqual([1, 2, 3, 4, 5, 6]);
		store.close();
	});

	it("reopens a loop-limit hold only with its current receipt and keeps iteration history continuous", async () => {
		const store = await engineRun();
		const settleOpenRework = () => {
			const db = (
				store as unknown as {
					db: { run(sql: string): void };
				}
			).db;
			db.run(
				"UPDATE workflow_rework_delivery SET state = 'completed' WHERE state IN ('pending','turn_granted','wake_delivered','replacement_pending')",
			);
			db.run(
				"UPDATE workflow_rework_verification_path SET state = 'completed' WHERE state IN ('pending','active')",
			);
		};
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
			const failure = advance(store, {
				nodeId: "qa",
				attempt,
				executionId: "qa-1",
				outcome: "qa_fail",
			});
			expect(failure).toMatchObject({
				ok: true,
				loopIteration: attempt,
			});
			expect(failure.ok && failure.escalated).toBe(
				attempt === 4 ? true : undefined,
			);
			if (attempt < 4) settleOpenRework();
		}
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "implement",
		});
		store.patchSessionMetadata("implement-1", { pr_head_sha: "b".repeat(40) });

		const hold = store
			.listWorkflowRunEvents("run-1")
			.find((event) => event.kind === "loop_limit_escalated")!;
		const ack = {
			holdEventUid: hold.event_uid,
			holdReceiptDigest: canonicalSubmissionDigest(hold.payload),
			decision: "continue" as const,
		};
		const rework = (clientRequestId: string, escalationAck?: typeof ack) =>
			store.openOperatorRework({
				runId: "run-1",
				targetNodeId: "implement",
				feedback: "continue after reviewing the loop limit",
				clientRequestId,
				principal: "master",
				evidence: [],
				now: "2026-07-16T01:10:00.000Z",
				escalationAck,
			});

		expect(rework("missing-ack")).toEqual({
			ok: false,
			reason: "loop_limit_escalation_ack_required",
		});
		expect(
			rework("wrong-digest", {
				...ack,
				holdReceiptDigest: "0".repeat(64),
			}),
		).toEqual({ ok: false, reason: "loop_limit_escalation_ack_invalid" });

		const opened = rework("continue-4", ack);
		if (!opened.ok) throw new Error(opened.reason);
		expect(opened).toMatchObject({
			ok: true,
			targetAttempt: 5,
			idempotentReplay: false,
		});
		const request = store.getWorkflowReworkRequest(opened.requestId)!;
		expect(JSON.parse(request.authority_context_json)).toMatchObject({
			escalationAck: ack,
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.find((event) => event.event_uid === "operator_rework:run-1:continue-4")
				?.payload,
		).toMatchObject({ escalationAck: ack });
		expect(rework("continue-4", ack)).toMatchObject({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			store.openOperatorRework({
				runId: "run-1",
				targetNodeId: "implement",
				feedback: "continue after reviewing the loop limit",
				clientRequestId: "continue-4",
				principal: "master",
				evidence: [],
				now: "2026-07-16T01:10:00.000Z",
				escalationAck: { ...ack, decision: "reclassify" },
			}),
		).toEqual({ ok: false, reason: "operator_request_conflict" });
		settleOpenRework();

		for (let attempt = 5; attempt <= 6; attempt += 1) {
			advance(store, {
				nodeId: "implement",
				attempt,
				executionId: "implement-1",
				outcome: "implement_done",
				successorExecutionId: "qa-1",
			});
			const failure = advance(store, {
				nodeId: "qa",
				attempt,
				executionId: "qa-1",
				outcome: "qa_fail",
			});
			expect(failure).toMatchObject({
				ok: true,
				loopIteration: attempt,
				escalated: true,
			});
			if (attempt === 5) {
				const latestHold = store
					.listWorkflowRunEvents("run-1")
					.filter((event) => event.kind === "loop_limit_escalated")
					.at(-1)!;
				const reopened = store.openOperatorRework({
					runId: "run-1",
					targetNodeId: "implement",
					feedback: "continue after reviewing the next loop limit",
					clientRequestId: "continue-5",
					principal: "master",
					evidence: [],
					now: "2026-07-16T01:20:00.000Z",
					escalationAck: {
						holdEventUid: latestHold.event_uid,
						holdReceiptDigest: canonicalSubmissionDigest(latestHold.payload),
						decision: "continue",
					},
				});
				expect(reopened).toMatchObject({ ok: true, targetAttempt: 6 });
				settleOpenRework();
			}
		}
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "loop_limit_escalated")
				.map((event) => event.payload?.loopIteration),
		).toEqual([4, 5, 6]);
		expect(rework("stale-ack", ack)).toEqual({
			ok: false,
			reason: "loop_limit_escalation_ack_stale",
		});
		expect(
			store
				.listWorkflowRunNodes("run-1", "implement")
				.map((node) => node.attempt),
		).toEqual([1, 2, 3, 4, 5, 6]);
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
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "implement",
		});
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
		store.upsertSession({
			execution_id: "qa-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "qa",
		});

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
		store.upsertSession({
			execution_id: "qa-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "qa",
		});
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
