import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { makeGateAuthorityView } from "../bridge/approval-signal/gate-authority-view.js";
import { StateStore } from "../StateStore.js";
import {
	buildWorkflowRunSnapshotV1,
	buildWorkflowRunSnapshotV2,
} from "../workflow-run-snapshot.js";

const HEAD = "a".repeat(40);
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function landSnapshot(): string {
	return JSON.stringify(
		buildWorkflowRunSnapshotV1({
			template: { id: "tpl_eng_heavy_land_v1", revision: 1 },
			manifest: {
				schema_version: 1,
				manifest_variant: "land_v1",
				nodes: [
					{
						id: "design",
						type: "design",
						vendor: "claude",
						model: "claude-fable-5",
					},
					{
						id: "implement",
						type: "implement",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "xhigh",
					},
					{
						id: "qa",
						type: "qa",
						vendor: "claude",
						model: "claude-opus-5",
					},
					{ id: "founder_gate", type: "gate" },
					{ id: "land", type: "land", execution: "engine" },
				],
				edges: [
					{
						id: "design_done",
						from: "design",
						to: "implement",
						condition: "design_done",
					},
					{
						id: "implement_done",
						from: "implement",
						to: "qa",
						condition: "implement_done",
					},
					{
						id: "qa_pass",
						from: "qa",
						to: "founder_gate",
						condition: "qa_pass",
					},
					{
						id: "founder_approved",
						from: "founder_gate",
						to: "land",
						condition: "founder_approved",
					},
				],
				loops: [
					{
						id: "qa_retry",
						from: "qa",
						to: "implement",
						loop_when: "qa_fail",
						exit_when: "qa_pass",
						max_iterations: 3,
						on_limit: "escalate",
					},
					{
						id: "founder_feedback",
						from: "founder_gate",
						to: "implement",
						loop_when: "founder_feedback_kickback",
						exit_when: "founder_approved",
						max_iterations: 3,
						on_limit: "escalate",
					},
				],
				approval_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				terminal_node: { node: "land" },
				ship_claims: ["qa_passed", "founder_approved"],
			},
		}),
	);
}

function claimlessLandSnapshot(): string {
	return JSON.stringify(
		buildWorkflowRunSnapshotV2({
			template: { id: "tpl_claimless_land", revision: 1 },
			canonicalRoot: REPO_ROOT,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: "craft",
						type: "generic",
						role: "general",
						vendor: "claude",
						model: "claude-opus-5",
						effort: "xhigh",
					},
					{ id: "decision", type: "gate" },
					{ id: "publish", type: "land", execution: "engine" },
				],
				edges: [
					{
						id: "crafted",
						from: "craft",
						to: "decision",
						condition: "node_done",
					},
					{
						id: "approved",
						from: "decision",
						to: "publish",
						condition: "founder_approved",
					},
				],
				loops: [],
				approval_gate: {
					node: "decision",
					predicate: "founder_approved",
				},
				terminal_node: { node: "publish" },
				ship_claims: ["founder_approved"],
			},
		}),
	);
}

function bindPr(
	store: StateStore,
	input: {
		runId: string;
		nodeId: string;
		attempt: number;
		head: string;
		receiptId: string;
	},
): void {
	(
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db.run(
		`INSERT INTO workflow_node_pr_binding
		   (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
		    probe_repo_slug, target_repo_path, worktree_binding_generation,
		    receipt_id, bound_at)
		 VALUES (?, ?, ?, 1375, ?, '__main__', 'geoforge3d/flywheel',
		         '/tmp/flywheel', 'generation-1', ?,
		         '2026-07-21T19:59:00.000Z')`,
		[input.runId, input.nodeId, input.attempt, input.head, input.receiptId],
	);
}

function prepareAwaitingFounderGate(store: StateStore, runId: string) {
	store.createWorkflowRun({
		runId,
		issueId: "FLY-1375",
		projectName: "flywheel",
		snapshotJson: landSnapshot(),
		claimsReadEnrolled: true,
	});
	(
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db.run(
		"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'qa' WHERE run_id = ?",
		[runId],
	);
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "design",
		attempt: 1,
		state: "done",
		executionId: "design-exec",
	});
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "implement-exec",
	});
	bindPr(store, {
		runId,
		nodeId: "implement",
		attempt: 1,
		head: HEAD,
		receiptId: `${runId}:implement:1`,
	});
	(
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db.run(
		`INSERT INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES ('design-exec','flywheel','FLY-1375','design','2026-07-21T19:00:00.000Z'),
		        ('implement-exec','flywheel','FLY-1375','implement','2026-07-21T19:00:00.000Z'),
		        ('qa-feedback','flywheel','FLY-1375','qa','2026-07-21T19:00:00.000Z')`,
	);
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "qa",
		attempt: 1,
		state: "running",
		executionId: "qa-feedback",
	});
	const passed = store.commitWorkflowTransitionTx({
		runId,
		nodeId: "qa",
		attempt: 1,
		executionId: "qa-feedback",
		outcome: "qa_pass",
		subjectDigest: HEAD,
		now: "2026-07-21T20:00:00.000Z",
	});
	if (!passed.ok) throw new Error(`qa pass setup failed: ${passed.reason}`);
	const holder = store.getCurrentWorkflowGateHolder(runId, "founder_gate");
	if (!holder) throw new Error("founder gate setup failed");
	store.advanceWorkflowGateHolderMaterialization({
		questionId: holder.question_id,
		stage: "card_bound",
		cardMessageId: `card-${runId}`,
		now: "2026-07-21T20:01:00.000Z",
	});
	return holder;
}

function activateFounderRework(
	store: StateStore,
	input: {
		requestId: string;
		runId: string;
		nodeId: "design" | "implement" | "qa";
		executionId: string;
		attempt: number;
	},
): void {
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: input.runId,
			nodeId: input.nodeId,
			executionId: input.executionId,
			attempt: input.attempt,
			activationId: `activation:${input.requestId}`,
			activationMode: "wake",
			reworkRequestId: input.requestId,
			now: "2026-07-21T20:02:00.000Z",
			expiresAt: "2026-07-21T21:02:00.000Z",
			absoluteDeadlineAt: "2026-07-22T20:02:00.000Z",
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	expect(
		store.recordWorkflowActivationTurn({
			activationId: `activation:${input.requestId}`,
			issueId: store.getWorkflowRun(input.runId)!.issue_id,
			executionId: input.executionId,
			epoch: input.attempt,
			sourceEventId: `turn:${input.requestId}:${input.attempt}`,
			grantedAt: "2026-07-21T20:02:00.000Z",
		}),
	).toMatchObject({ ok: true });
	expect(
		store.claimWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: "coordinator",
			now: "2026-07-21T20:02:01.000Z",
			leaseExpiresAt: "2026-07-21T20:03:01.000Z",
		}),
	).toMatchObject({ ok: true, generation: 1 });
	expect(
		store.advanceWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: "coordinator",
			generation: 1,
			from: "pending",
			to: "turn_granted",
			now: "2026-07-21T20:02:02.000Z",
		}),
	).toMatchObject({ ok: true });
	expect(
		store.advanceWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: "coordinator",
			generation: 1,
			from: "turn_granted",
			to: "awaiting_receipt",
			now: "2026-07-21T20:02:03.000Z",
			releaseOwner: true,
		}),
	).toEqual({ ok: true });
	expect(
		store.recordWorkflowReworkWakeReceipt({
			activationId: `activation:${input.requestId}`,
			executionId: input.executionId,
			epoch: input.attempt,
			ackedAt: "2026-07-21T20:02:04.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		}),
	).toMatchObject({ ok: true });
}

describe("StateStore land lifecycle ledger", () => {
	it("opens a claimless land gate only when completion head has one current PR binding", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-claimless",
			issueId: "FLY-1655",
			projectName: "flywheel",
			snapshotJson: claimlessLandSnapshot(),
			claimsReadEnrolled: true,
		});
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_run SET engine_owned = 1, gate_carrier_epoch = 1, current_node_id = 'craft' WHERE run_id = 'run-claimless'",
		);
		store.upsertWorkflowRunNode({
			runId: "run-claimless",
			nodeId: "craft",
			attempt: 1,
			state: "running",
			executionId: "craft-exec",
		});

		expect(
			store.commitWorkflowTransitionTx({
				runId: "run-claimless",
				nodeId: "craft",
				attempt: 1,
				executionId: "craft-exec",
				outcome: "node_done",
				subjectDigest: HEAD,
				now: "2026-08-09T18:00:00.000Z",
			}),
		).toEqual({ ok: false, reason: "land_head_unavailable" });
		expect(store.getWorkflowRun("run-claimless")).toMatchObject({
			current_node_id: "craft",
			status: "active",
		});
		expect(store.getWorkflowRunNode("run-claimless", "craft", 1)).toMatchObject(
			{ state: "running" },
		);
		expect(
			store.getCurrentWorkflowGateHolder("run-claimless", "decision"),
		).toBe(undefined);

		bindPr(store, {
			runId: "run-claimless",
			nodeId: "craft",
			attempt: 1,
			head: HEAD,
			receiptId: "run-claimless:craft:1",
		});
		expect(
			store.commitWorkflowTransitionTx({
				runId: "run-claimless",
				nodeId: "craft",
				attempt: 1,
				executionId: "craft-exec",
				outcome: "node_done",
				subjectDigest: HEAD,
				now: "2026-08-09T18:01:00.000Z",
			}),
		).toMatchObject({
			ok: true,
			gateOpened: true,
			targetNodeId: "decision",
		});
		const holder = store.getCurrentWorkflowGateHolder(
			"run-claimless",
			"decision",
		)!;
		expect(holder).toMatchObject({
			authority_mode: "land",
			subject_kind: "git_head",
			head_sha: HEAD,
		});
		store.advanceWorkflowGateHolderMaterialization({
			questionId: holder.question_id,
			stage: "card_bound",
			cardMessageId: "claimless-card",
			now: "2026-08-09T18:02:00.000Z",
		});
		const sourcePayload = {
			schema_version: 1,
			run_id: "run-claimless",
			issue_id: "FLY-1655",
			question_id: holder.question_id,
			response: { approved: true },
			actor: "founder",
			approved_head: HEAD,
			classification: "founder_reaction",
			authority_id: holder.question_id,
		};
		store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: `founder-approval:${holder.question_id}`,
			kind: "founder_approval",
			payloadJson: canonicalJsonString(sourcePayload),
			payloadDigest: canonicalSubmissionDigest(sourcePayload),
			schemaVersion: 1,
		});
		expect(store.getWorkflowRun("run-claimless")).toMatchObject({
			status: "active",
			current_node_id: "publish",
		});
		expect(
			store.getWorkflowRunNode("run-claimless", "publish", 1),
		).toMatchObject({ state: "pending" });
		store.close();
	});

	it("completion gate-entry refusal atomically alerts and remains replayable", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-claimless-completion",
			issueId: "FLY-1772",
			projectName: "flywheel",
			snapshotJson: claimlessLandSnapshot(),
			claimsReadEnrolled: true,
		});
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_run SET engine_owned = 1, gate_carrier_epoch = 1, current_node_id = 'craft' WHERE run_id = 'run-claimless-completion'",
		);
		store.upsertWorkflowRunNode({
			runId: "run-claimless-completion",
			nodeId: "craft",
			attempt: 1,
			state: "pending",
			executionId: "craft-completion",
		});
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-claimless-completion",
			nodeId: "craft",
			executionId: "craft-completion",
			attempt: 1,
			now: "2026-08-15T08:00:00.000Z",
			expiresAt: "2026-08-15T09:00:00.000Z",
			absoluteDeadlineAt: "2026-08-16T08:00:00.000Z",
			env: WORKFLOW_ON,
		});
		expect(admitted).toMatchObject({ ok: true });
		if (!admitted.ok) throw new Error(admitted.reason);
		if (admitted.outputCredential) {
			expect(
				store.submitWorkflowNodeOutput({
					token: admitted.outputCredential,
					clientRequestId: "craft-output",
					payload: '{"summary":"done"}',
					now: "2026-08-15T08:00:30.000Z",
				}),
			).toMatchObject({ ok: true });
		}
		store.upsertSession({
			execution_id: "craft-completion",
			issue_id: "FLY-1772",
			project_name: "flywheel",
			status: "running",
			pr_head_sha: HEAD,
		});
		const submission = {
			executionId: "craft-completion",
			route: "needs_review",
			sourceEventId: "craft-completion-event",
			completionSubmission: { decision: { route: "needs_review" } },
			subjectDigest: HEAD,
			now: "2026-08-15T08:01:00.000Z",
		};

		expect(
			store.commitEnrolledCompletion({
				...submission,
				alertIdentity: {
					leadId: "lead-completion-first",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toEqual({ ok: false, reason: "land_head_unavailable" });
		expect(
			store.commitEnrolledCompletion({
				...submission,
				alertIdentity: {
					leadId: "lead-completion-restart",
					projectName: "flywheel",
					leadResolution: "fallback",
				},
			}),
		).toEqual({ ok: false, reason: "land_head_unavailable" });
		expect(
			store.getCurrentWorkflowGateHolder(
				"run-claimless-completion",
				"decision",
			),
		).toBeUndefined();
		expect(
			store.getWorkflowRunNode("run-claimless-completion", "craft", 1),
		).toMatchObject({ state: "admitted" });
		const uid = "land_head_unavailable:run-claimless-completion:craft:1";
		expect(store.getWorkflowAlertOutbox(uid)?.payload).toMatchObject({
			leadId: "lead-completion-first",
			metadata: {
				workflowEngine: { disposition: "land_head_unavailable" },
			},
		});
		expect(
			store
				.listWorkflowRunEvents("run-claimless-completion")
				.filter((event) => event.event_uid === uid),
		).toHaveLength(1);
		store.close();
	});

	it("creates the deterministic gate holder in the same QA-pass transition", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-transition",
			issueId: "FLY-1375",
			projectName: "flywheel",
			snapshotJson: landSnapshot(),
			claimsReadEnrolled: true,
		});
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'qa' WHERE run_id = 'run-transition'",
		);
		store.upsertWorkflowRunNode({
			runId: "run-transition",
			nodeId: "implement",
			attempt: 1,
			state: "done",
			executionId: "implement-exec",
		});
		bindPr(store, {
			runId: "run-transition",
			nodeId: "implement",
			attempt: 1,
			head: HEAD,
			receiptId: "run-transition:implement:1",
		});
		store.upsertWorkflowRunNode({
			runId: "run-transition",
			nodeId: "qa",
			attempt: 1,
			state: "running",
			executionId: "qa-exec",
		});

		expect(
			store.commitWorkflowTransitionTx({
				runId: "run-transition",
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-exec",
				outcome: "qa_pass",
				subjectDigest: HEAD,
				now: "2026-07-21T20:00:00.000Z",
			}),
		).toMatchObject({ ok: true, gateOpened: true });
		const holderEvent = store
			.listWorkflowRunEvents("run-transition")
			.find((event) => event.kind === "gate_holder_created");
		expect(holderEvent).toBeDefined();
		const payload = holderEvent!.payload as unknown as { questionId: string };
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId(payload.questionId),
		).toMatchObject({
			run_id: "run-transition",
			head_sha: HEAD,
			source_execution_id: "qa-exec",
			state: "materializing",
		});
		store.advanceWorkflowGateHolderMaterialization({
			questionId: payload.questionId,
			stage: "card_bound",
			cardMessageId: "card-1",
			now: "2026-07-21T20:01:00.000Z",
		});
		const authorityView = makeGateAuthorityView(store);
		expect(authorityView.resolve(payload.questionId, "qa-exec")).toMatchObject({
			state: "awaiting_review",
			headSha: HEAD,
		});
		const sourcePayload = {
			schema_version: 1,
			run_id: "run-transition",
			issue_id: "FLY-1375",
			question_id: payload.questionId,
			response: { approved: true },
			actor: "founder",
			approved_head: HEAD,
			classification: "founder_reaction",
			authority_id: payload.questionId,
		};
		store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: `founder-approval:${payload.questionId}`,
			kind: "founder_approval",
			payloadJson: canonicalJsonString(sourcePayload),
			payloadDigest: canonicalSubmissionDigest(sourcePayload),
			schemaVersion: 1,
		});
		expect(store.getWorkflowRun("run-transition")).toMatchObject({
			status: "active",
			current_node_id: "land",
		});
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId(payload.questionId),
		).toMatchObject({ state: "approved" });
		expect(authorityView.resolve(payload.questionId, "qa-exec")).toMatchObject({
			state: "approved",
		});
		expect(store.getWorkflowRunNode("run-transition", "land", 1)).toMatchObject(
			{
				state: "pending",
			},
		);
		store.close();
	});

	it("routes a trusted design-only correction to the original designer without rewriting founder words", async () => {
		const store = await StateStore.create(":memory:");
		const holder = prepareAwaitingFounderGate(store, "run-design-only");
		const sourcePayload = {
			schema_version: 1,
			run_id: "run-design-only",
			issue_id: "FLY-1375",
			question_id: holder.question_id,
			response: {
				approved: false,
				feedback: "只改设计说明，别重跑实现。  保留空格。",
			},
			actor: "founder",
			approved_head: HEAD,
			classification: "founder_direct_signal",
			authority_id: holder.question_id,
			rework: {
				target: "design",
				invalidation_scope: ["design"],
				verification_policy: ["design_review", "founder_gate"],
				interpreted_by: "flywheel-eng-lead",
				interpretation_reason: "founder explicitly scoped this to design",
			},
		};
		const event = {
			project: "flywheel",
			sourceEventId: `founder-feedback:${holder.question_id}:design-only`,
			kind: "founder_feedback" as const,
			payloadJson: canonicalJsonString(sourcePayload),
			payloadDigest: canonicalSubmissionDigest(sourcePayload),
			schemaVersion: 1,
		};

		expect(store.applyWorkflowSourceEvent(event)).toEqual({
			kind: "founder_feedback",
			status: "applied",
		});
		expect(store.applyWorkflowSourceEvent(event)).toEqual({
			kind: "founder_feedback",
			status: "replayed",
		});
		const requestEvent = store
			.listWorkflowRunEvents("run-design-only")
			.find((entry) => entry.kind === "rework_requested");
		const requestId = (requestEvent?.payload as { requestId?: string })
			.requestId;
		expect(requestId).toBeTruthy();
		expect(store.getWorkflowReworkRequest(requestId!)).toMatchObject({
			founder_feedback_verbatim: "只改设计说明，别重跑实现。  保留空格。",
		});
		expect(store.getLatestWorkflowReworkRoute(requestId!)).toMatchObject({
			revision: 2,
			target_node_id: "design",
			target_attempt: 2,
			preferred_actor_execution_id: "design-exec",
			invalidation_scope: ["design", "implement", "qa"],
			verification_policy: [
				"design_review",
				"code_review",
				"qa_retest",
				"founder_gate",
			],
			interpreted_by: "flywheel-eng-lead",
		});
		expect(store.getWorkflowRun("run-design-only")).toMatchObject({
			current_node_id: "design",
		});
		expect(
			store.getWorkflowRunNode("run-design-only", "design", 2),
		).toMatchObject({ state: "pending", execution_id: "design-exec" });
		expect(
			store.getWorkflowRunNode("run-design-only", "implement", 2),
		).toMatchObject({ state: "superseded", execution_id: "implement-exec" });
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-design-only",
				nodeId: "design",
				executionId: "design-exec",
				attempt: 2,
				activationId: "activation-design-correction",
				activationMode: "wake",
				reworkRequestId: requestId!,
				now: "2026-07-21T20:02:00.000Z",
				expiresAt: "2026-07-21T21:02:00.000Z",
				absoluteDeadlineAt: "2026-07-22T20:02:00.000Z",
				env: WORKFLOW_ON,
			}),
		).toMatchObject({ ok: true });
		expect(
			store.recordWorkflowActivationTurn({
				activationId: "activation-design-correction",
				issueId: store.getWorkflowRun("run-design-only")!.issue_id,
				executionId: "design-exec",
				epoch: 2,
				sourceEventId: "turn:design-correction:2",
				grantedAt: "2026-07-21T20:02:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.claimWorkflowReworkDelivery({
				requestId: requestId!,
				ownerId: "coordinator",
				now: "2026-07-21T20:02:01.000Z",
				leaseExpiresAt: "2026-07-21T20:03:01.000Z",
			}),
		).toMatchObject({ ok: true, generation: 1 });
		expect(
			store.advanceWorkflowReworkDelivery({
				requestId: requestId!,
				ownerId: "coordinator",
				generation: 1,
				from: "pending",
				to: "turn_granted",
				now: "2026-07-21T20:02:02.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.advanceWorkflowReworkDelivery({
				requestId: requestId!,
				ownerId: "coordinator",
				generation: 1,
				from: "turn_granted",
				to: "awaiting_receipt",
				now: "2026-07-21T20:02:03.000Z",
				releaseOwner: true,
			}),
		).toEqual({ ok: true });
		expect(
			store.recordWorkflowReworkWakeReceipt({
				activationId: "activation-design-correction",
				executionId: "design-exec",
				epoch: 2,
				ackedAt: "2026-07-21T20:02:04.000Z",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toMatchObject({ ok: true });

		const correctedHead = "b".repeat(40);
		bindPr(store, {
			runId: "run-design-only",
			nodeId: "design",
			attempt: 2,
			head: correctedHead,
			receiptId: "run-design-only:design:2",
		});
		expect(
			store.commitWorkflowTransitionTx({
				runId: "run-design-only",
				nodeId: "design",
				attempt: 2,
				executionId: "design-exec",
				outcome: "design_done",
				subjectDigest: correctedHead,
				now: "2026-07-21T20:10:00.000Z",
			}),
		).toMatchObject({
			ok: true,
			targetNodeId: "implement",
			targetAttempt: 3,
		});
		expect(store.getWorkflowReworkVerificationPath(requestId!)).toMatchObject({
			state: "completed",
			current_node_id: "implement",
			current_attempt: 3,
		});
		expect(store.getWorkflowReworkDelivery(requestId!)).toMatchObject({
			state: "completed",
		});
		expect(
			store.getCurrentWorkflowGateHolder("run-design-only", "founder_gate"),
		).toBeUndefined();
		store.close();
	});

	it("normalizes an incomplete correction hint through pinned topology", async () => {
		const store = await StateStore.create(":memory:");
		const holder = prepareAwaitingFounderGate(store, "run-invalid-hint");
		const sourcePayload = {
			schema_version: 1,
			run_id: "run-invalid-hint",
			issue_id: "FLY-1375",
			question_id: holder.question_id,
			response: { approved: false, feedback: "fix implementation" },
			actor: "founder",
			approved_head: HEAD,
			classification: "founder_direct_signal",
			authority_id: holder.question_id,
			rework: {
				target: "implement",
				invalidation_scope: ["implement"],
				verification_policy: ["code_review", "founder_gate"],
				interpreted_by: "flywheel-eng-lead",
				interpretation_reason: "invalid attempt to skip QA",
			},
		};

		expect(
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId: `founder-feedback:${holder.question_id}:invalid`,
				kind: "founder_feedback",
				payloadJson: canonicalJsonString(sourcePayload),
				payloadDigest: canonicalSubmissionDigest(sourcePayload),
				schemaVersion: 1,
			}),
		).toEqual({ kind: "founder_feedback", status: "applied" });
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId(holder.question_id),
		).toBeUndefined();
		const requestEvent = store
			.listWorkflowRunEvents("run-invalid-hint")
			.find((entry) => entry.kind === "rework_requested");
		const requestId = (requestEvent?.payload as { requestId?: string })
			.requestId;
		expect(requestId).toBeTruthy();
		expect(store.getLatestWorkflowReworkRoute(requestId!)).toMatchObject({
			target_node_id: "implement",
			invalidation_scope: ["implement", "qa"],
			verification_policy: ["code_review", "qa_retest", "founder_gate"],
		});
		store.close();
	});

	it("routes a trusted QA correction and audits the effective target instead of the default implement edge", async () => {
		const store = await StateStore.create(":memory:");
		const holder = prepareAwaitingFounderGate(store, "run-qa-only");
		const sourceEventId = `founder-feedback:${holder.question_id}:qa-only`;
		const sourcePayload = {
			schema_version: 1,
			run_id: "run-qa-only",
			issue_id: "FLY-1375",
			question_id: holder.question_id,
			response: {
				approved: false,
				feedback: "qa: 重做验收，原文不可改。  ",
			},
			actor: "founder",
			approved_head: HEAD,
			classification: "founder_direct_signal",
			authority_id: holder.question_id,
			rework: {
				target: "qa",
				invalidation_scope: ["qa"],
				verification_policy: ["qa_retest", "founder_gate"],
				interpreted_by: "founder-reply-prefix",
				interpretation_reason: "matched_prefix:qa",
			},
		};

		expect(
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId,
				kind: "founder_feedback",
				payloadJson: canonicalJsonString(sourcePayload),
				payloadDigest: canonicalSubmissionDigest(sourcePayload),
				schemaVersion: 1,
			}),
		).toEqual({ kind: "founder_feedback", status: "applied" });

		const requestEvent = store
			.listWorkflowRunEvents("run-qa-only")
			.find((entry) => entry.kind === "rework_requested");
		const requestId = (requestEvent?.payload as { requestId?: string })
			.requestId;
		expect(requestId).toBeTruthy();
		expect(store.getWorkflowReworkRequest(requestId!)).toMatchObject({
			founder_feedback_verbatim: "qa: 重做验收，原文不可改。  ",
		});
		expect(store.getLatestWorkflowReworkRoute(requestId!)).toMatchObject({
			revision: 2,
			target_node_id: "qa",
			target_attempt: 2,
			preferred_actor_execution_id: "qa-feedback",
			invalidation_scope: ["qa"],
			verification_policy: ["qa_retest", "founder_gate"],
		});
		expect(store.getWorkflowRun("run-qa-only")).toMatchObject({
			current_node_id: "qa",
		});
		expect(
			store
				.listWorkflowRunEvents("run-qa-only")
				.find(
					(event) =>
						event.event_uid === `source_feedback:flywheel:${sourceEventId}`,
				)?.payload,
		).toMatchObject({ targetNodeId: "qa", targetAttempt: 2 });
		store.close();
	});

	it("runs an implement correction through a new QA attempt and returns the new head to founder gate", async () => {
		const store = await StateStore.create(":memory:");
		const holder = prepareAwaitingFounderGate(store, "run-implement-full");
		const sourcePayload = {
			schema_version: 1,
			run_id: "run-implement-full",
			issue_id: "FLY-1375",
			question_id: holder.question_id,
			response: { approved: false, feedback: "fix implementation and retest" },
			actor: "founder",
			approved_head: HEAD,
			classification: "founder_direct_signal",
			authority_id: holder.question_id,
			rework: {
				target: "implement",
				invalidation_scope: ["implement", "qa"],
				verification_policy: ["code_review", "qa_retest", "founder_gate"],
				interpreted_by: "flywheel-eng-lead",
				interpretation_reason: "implementation change invalidates QA",
			},
		};
		store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: `founder-feedback:${holder.question_id}:implement-full`,
			kind: "founder_feedback",
			payloadJson: canonicalJsonString(sourcePayload),
			payloadDigest: canonicalSubmissionDigest(sourcePayload),
			schemaVersion: 1,
		});
		const requestEvent = store
			.listWorkflowRunEvents("run-implement-full")
			.find((entry) => entry.kind === "rework_requested");
		const requestId = (requestEvent?.payload as { requestId?: string })
			.requestId;
		if (!requestId) throw new Error("rework request missing");
		expect(store.getLatestWorkflowReworkRoute(requestId)).toMatchObject({
			revision: 2,
			target_node_id: "implement",
			target_attempt: 2,
			preferred_actor_execution_id: "implement-exec",
		});
		activateFounderRework(store, {
			requestId,
			runId: "run-implement-full",
			nodeId: "implement",
			executionId: "implement-exec",
			attempt: 2,
		});

		const correctedHead = "c".repeat(40);
		bindPr(store, {
			runId: "run-implement-full",
			nodeId: "implement",
			attempt: 2,
			head: correctedHead,
			receiptId: "run-implement-full:implement:2",
		});
		const implementation = store.commitWorkflowTransitionTx({
			runId: "run-implement-full",
			nodeId: "implement",
			attempt: 2,
			executionId: "implement-exec",
			outcome: "implement_done",
			subjectDigest: correctedHead,
			now: "2026-07-21T20:10:00.000Z",
		});
		expect(implementation).toMatchObject({
			ok: true,
			targetNodeId: "qa",
			targetAttempt: 2,
			reworkRequestId: expect.any(String),
		});
		if (!implementation.ok || !implementation.reworkRequestId) {
			throw new Error("QA retest request missing");
		}
		expect(store.getWorkflowReworkVerificationPath(requestId)).toMatchObject({
			state: "completed",
			current_node_id: "qa",
			current_attempt: 2,
		});
		expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
			state: "completed",
		});
		const qaRequestId = implementation.reworkRequestId;
		expect(store.getLatestWorkflowReworkRoute(qaRequestId)).toMatchObject({
			target_node_id: "qa",
			target_attempt: 2,
			preferred_actor_execution_id: "qa-feedback",
			invalidation_scope: ["qa"],
		});
		activateFounderRework(store, {
			requestId: qaRequestId,
			runId: "run-implement-full",
			nodeId: "qa",
			executionId: "qa-feedback",
			attempt: 2,
		});
		const qa = store.commitWorkflowTransitionTx({
			runId: "run-implement-full",
			nodeId: "qa",
			attempt: 2,
			executionId: "qa-feedback",
			outcome: "qa_pass",
			subjectDigest: correctedHead,
			now: "2026-07-21T20:20:00.000Z",
		});
		expect(qa).toMatchObject({
			ok: true,
			targetNodeId: "founder_gate",
			gateOpened: true,
		});
		expect(store.getWorkflowReworkVerificationPath(qaRequestId)).toMatchObject({
			state: "completed",
			current_node_id: "founder_gate",
		});
		expect(store.getWorkflowReworkDelivery(qaRequestId)).toMatchObject({
			state: "completed",
		});
		expect(
			store.getCurrentWorkflowGateHolder("run-implement-full", "founder_gate"),
		).toMatchObject({
			head_sha: correctedHead,
			source_execution_id: "qa-feedback",
		});
		expect(
			store.getWorkflowRunNode("run-implement-full", "design", 2),
		).toBeUndefined();
		store.close();
	});

	it("keeps gate authority independent from the source execution lifecycle", async () => {
		const store = await StateStore.create(":memory:");
		const created = store.ensureWorkflowGateHolder({
			runId: "run-1",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "A".repeat(40),
			sourceExecutionId: "qa-exec-1",
			questionId: "workflow-gate-run-1-1",
			now: "2026-07-21T20:00:00.000Z",
		});
		expect(created).toMatchObject({
			head_sha: "a".repeat(40),
			state: "materializing",
			materialization_stage: "question_intent",
		});

		const replay = store.ensureWorkflowGateHolder({
			runId: "run-1",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "a".repeat(40),
			sourceExecutionId: "qa-exec-1",
			questionId: "workflow-gate-run-1-1",
			now: "2026-07-21T20:01:00.000Z",
		});
		expect(replay).toEqual(created);

		expect(
			store.advanceWorkflowGateHolderMaterialization({
				questionId: created.question_id,
				stage: "card_bound",
				cardMessageId: "discord-card-1",
				now: "2026-07-21T20:02:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "awaiting_review" });
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId(created.question_id),
		).toMatchObject({
			source_execution_id: "qa-exec-1",
			state: "awaiting_review",
			card_message_id: "discord-card-1",
		});
		expect(store.listWorkflowGateHoldersForMaterialization()).toMatchObject([
			{ question_id: created.question_id, materialization_stage: "card_bound" },
		]);
		store.close();
	});

	it("retires a rejected holder and durably kicks the land workflow back to implement", async () => {
		const store = await StateStore.create(":memory:");
		const holder = prepareAwaitingFounderGate(store, "run-feedback");
		const sourcePayload = {
			schema_version: 1,
			run_id: "run-feedback",
			issue_id: "FLY-1375",
			question_id: holder.question_id,
			response: { approved: false, feedback: "please fix the release note" },
			actor: "founder",
			approved_head: HEAD,
			classification: "founder_reaction",
			authority_id: holder.question_id,
		};
		const event = {
			project: "flywheel",
			sourceEventId: `founder-feedback:${holder.question_id}`,
			kind: "founder_feedback" as const,
			payloadJson: canonicalJsonString(sourcePayload),
			payloadDigest: canonicalSubmissionDigest(sourcePayload),
			schemaVersion: 1,
		};

		expect(store.applyWorkflowSourceEvent(event)).toEqual({
			kind: "founder_feedback",
			status: "applied",
		});
		expect(store.applyWorkflowSourceEvent(event)).toEqual({
			kind: "founder_feedback",
			status: "replayed",
		});
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId(holder.question_id),
		).toBeUndefined();
		expect(store.getWorkflowRun("run-feedback")).toMatchObject({
			status: "active",
			current_node_id: "implement",
		});
		expect(
			store.getWorkflowRunNode("run-feedback", "implement", 2),
		).toMatchObject({ state: "pending" });
		const requestEvent = store
			.listWorkflowRunEvents("run-feedback")
			.find((entry) => entry.kind === "rework_requested");
		const requestId = (requestEvent?.payload as { requestId?: string })
			.requestId;
		expect(requestId).toBeTruthy();
		expect(store.getWorkflowReworkRequest(requestId!)).toMatchObject({
			authority: "founder",
			founder_feedback_verbatim: "please fix the release note",
		});
		expect(store.getLatestWorkflowReworkRoute(requestId!)).toMatchObject({
			target_node_id: "implement",
			target_attempt: 2,
			preferred_actor_execution_id: "implement-exec",
			invalidation_scope: ["implement", "qa"],
			verification_policy: ["code_review", "qa_retest", "founder_gate"],
			interpreted_by: "legacy_default",
		});
		expect(
			store
				.listWorkflowRunEvents("run-feedback")
				.some((entry) => entry.kind === "founder_feedback_kickback"),
		).toBe(true);
		expect(
			store
				.listWorkflowRunEvents("run-feedback")
				.find(
					(entry) =>
						entry.kind === "edge_traversed" &&
						(entry.payload as { outcome?: string }).outcome ===
							"founder_feedback_kickback",
				)?.payload,
		).toMatchObject({ founderFeedback: "please fix the release note" });
		store.close();
	});

	it("keeps frozen max-3 founder loops running through rounds 4 and 5 with one Lead warning per high round", async () => {
		for (const round of [3, 4, 5]) {
			const runId = `run-founder-round-${round}`;
			const store = await StateStore.create(":memory:");
			try {
				const holder = prepareAwaitingFounderGate(store, runId);
				for (let iteration = 1; iteration < round; iteration += 1) {
					store.appendWorkflowRunEvent({
						runId,
						eventUid: `seed-founder-loop:${runId}:${iteration}`,
						kind: "loop_iteration",
						nodeId: "founder_gate",
						edgeId: "founder_feedback",
						executionId: "qa-feedback",
						payload: { iteration },
					});
				}
				const sourcePayload = {
					schema_version: 1,
					run_id: runId,
					issue_id: "FLY-1375",
					question_id: holder.question_id,
					response: { approved: false, feedback: `fix round ${round}` },
					actor: "founder",
					approved_head: HEAD,
					classification: "founder_direct_signal",
					authority_id: holder.question_id,
				};
				expect(
					store.applyWorkflowSourceEvent({
						project: "flywheel",
						sourceEventId: `founder-feedback:${holder.question_id}`,
						kind: "founder_feedback",
						payloadJson: canonicalJsonString(sourcePayload),
						payloadDigest: canonicalSubmissionDigest(sourcePayload),
						schemaVersion: 1,
						alertIdentity: {
							leadId: "flywheel-eng-lead",
							projectName: "flywheel",
							leadResolution: "resolved",
						},
					}),
				).toEqual({ kind: "founder_feedback", status: "applied" });
				const loopEvents = store
					.listWorkflowRunEvents(runId)
					.filter(
						(event) =>
							event.kind === "loop_iteration" &&
							event.edge_id === "founder_feedback",
					);
				expect(loopEvents).toHaveLength(round);
				expect(loopEvents.at(-1)?.payload).toMatchObject({ iteration: round });
				const alert = store.getWorkflowAlertOutbox(
					`founder_rework_round:${runId}:${round}`,
				);
				if (round < 4) {
					expect(alert).toBeUndefined();
				} else {
					expect(alert?.payload).toMatchObject({
						severity: "warning",
						metadata: {
							workflowEngine: {
								disposition: "founder_rework_round_high",
								loopIteration: round,
							},
						},
					});
				}
				expect(store.getWorkflowRun(runId)).toMatchObject({
					status: "active",
					current_node_id: "implement",
				});
			} finally {
				store.close();
			}
		}
	});

	it("does not roll back a founder kickback when the high-round warning enqueue fails", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const holder = prepareAwaitingFounderGate(
				store,
				"run-founder-alert-fail",
			);
			for (let iteration = 1; iteration <= 3; iteration += 1) {
				store.appendWorkflowRunEvent({
					runId: "run-founder-alert-fail",
					eventUid: `seed-founder-alert-fail:${iteration}`,
					kind: "loop_iteration",
					nodeId: "founder_gate",
					edgeId: "founder_feedback",
					executionId: "qa-feedback",
					payload: { iteration },
				});
			}
			const enqueue = vi
				.spyOn(
					store as unknown as {
						enqueueWorkflowEngineAlertTx(input: unknown): void;
					},
					"enqueueWorkflowEngineAlertTx",
				)
				.mockImplementation(() => {
					throw new Error("workflow_alert_uid_conflict:injected");
				});
			const sourcePayload = {
				schema_version: 1,
				run_id: "run-founder-alert-fail",
				issue_id: "FLY-1375",
				question_id: holder.question_id,
				response: { approved: false, feedback: "still needs work" },
				actor: "founder",
				approved_head: HEAD,
				classification: "founder_direct_signal",
				authority_id: holder.question_id,
			};
			expect(
				store.applyWorkflowSourceEvent({
					project: "flywheel",
					sourceEventId: `founder-feedback:${holder.question_id}`,
					kind: "founder_feedback",
					payloadJson: canonicalJsonString(sourcePayload),
					payloadDigest: canonicalSubmissionDigest(sourcePayload),
					schemaVersion: 1,
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
			).toEqual({ kind: "founder_feedback", status: "applied" });
			expect(enqueue).toHaveBeenCalledOnce();
			expect(store.getWorkflowRun("run-founder-alert-fail")).toMatchObject({
				status: "active",
				current_node_id: "implement",
			});
			expect(
				store
					.listWorkflowRunEvents("run-founder-alert-fail")
					.filter((event) => event.kind === "loop_iteration"),
			).toHaveLength(4);
		} finally {
			store.close();
		}
	});

	it("fences stale land workers and resumes from durable step receipts", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			runId: "run-1",
			issueId: "issue-1",
			projectName: "flywheel",
			prNumber: 777,
			approvedHead: "b".repeat(40),
			now: "2026-07-21T20:00:00.000Z",
		});
		expect(
			store.ensureLandOperation({
				runId: "run-1",
				issueId: "issue-1",
				projectName: "flywheel",
				prNumber: 777,
				approvedHead: "b".repeat(40),
				now: "2026-07-21T20:00:01.000Z",
			}),
		).toEqual(operation);

		const first = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "worker-a",
			now: "2026-07-21T20:00:01.000Z",
			leaseExpiresAt: "2026-07-21T20:01:01.000Z",
		});
		expect(first).toMatchObject({ ownerId: "worker-a", generation: 1 });
		expect(
			store.listRunnableLandOperations("2026-07-21T20:00:30.000Z"),
		).toEqual([]);
		expect(
			store.listRunnableLandOperations("2026-07-21T20:02:00.000Z"),
		).toMatchObject([{ operation_id: operation.operation_id }]);
		expect(
			store.claimLandOperation({
				operationId: operation.operation_id,
				ownerId: "worker-b",
				now: "2026-07-21T20:00:30.000Z",
				leaseExpiresAt: "2026-07-21T20:01:30.000Z",
			}),
		).toBeUndefined();

		const takeover = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "worker-b",
			now: "2026-07-21T20:02:00.000Z",
			leaseExpiresAt: "2026-07-21T20:03:00.000Z",
		});
		expect(takeover).toMatchObject({ ownerId: "worker-b", generation: 2 });
		expect(
			store.recordLandOperationStep({
				operationId: operation.operation_id,
				ownerId: "worker-a",
				generation: 1,
				step: "merge_confirmed",
				receipt: { mergeSha: "c".repeat(40) },
				now: "2026-07-21T20:02:01.000Z",
			}),
		).toEqual({ ok: false, reason: "stale_land_generation" });
		expect(
			store.recordLandOperationStep({
				operationId: operation.operation_id,
				ownerId: "worker-b",
				generation: 2,
				step: "merge_confirmed",
				receipt: { mergeSha: "c".repeat(40) },
				now: "2026-07-21T20:02:02.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(store.listLandOperationSteps(operation.operation_id)).toMatchObject([
			{ step: "merge_confirmed", receipt: { mergeSha: "c".repeat(40) } },
		]);
		store.close();
	});

	it("holds the engine run and enqueues an escalation when land cannot continue", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-held",
			issueId: "FLY-1375",
			projectName: "flywheel",
			snapshotJson: landSnapshot(),
			claimsReadEnrolled: true,
		});
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'land' WHERE run_id = 'run-held'",
		);
		store.upsertWorkflowRunNode({
			runId: "run-held",
			nodeId: "land",
			attempt: 1,
			state: "pending",
			executionId: "land-exec",
		});
		const operation = store.ensureLandOperation({
			runId: "run-held",
			issueId: "FLY-1375",
			projectName: "flywheel",
			prNumber: 1375,
			approvedHead: HEAD,
			now: "2026-07-21T20:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "land-worker",
			now: "2026-07-21T20:00:01.000Z",
			leaseExpiresAt: "2026-07-21T20:01:01.000Z",
		})!;
		store.setLandOperationDisposition({
			operationId: operation.operation_id,
			ownerId: claim.ownerId,
			generation: claim.generation,
			state: "held",
			error: "pr_head_mismatch",
			now: "2026-07-21T20:00:02.000Z",
		});
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			`UPDATE land_operation
			    SET retry_count = 5, retry_epoch_key = '3:cleanup_requested',
			        last_error = 'retry_exhausted:linear_lookup_failed_retryable'
			  WHERE operation_id = ?`,
			[operation.operation_id],
		);

		const result = store.holdWorkflowLandNode({
			runId: "run-held",
			nodeId: "land",
			attempt: 1,
			executionId: "land-exec",
			operationId: operation.operation_id,
			reason: "retry_exhausted:linear_lookup_failed_retryable",
			now: "2026-07-21T20:00:03.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "configured",
			},
		});
		expect(result).toEqual({ ok: true, idempotentReplay: false });
		expect(store.getWorkflowRun("run-held")?.status).toBe("held");
		const event = store
			.listWorkflowRunEvents("run-held")
			.find((candidate) => candidate.kind === "land_held");
		expect(event).toBeDefined();
		expect(event?.payload).toMatchObject({
			attempts: 5,
			epochKey: "3:cleanup_requested",
		});
		expect(store.getWorkflowAlertOutbox(event!.event_uid)).toMatchObject({
			state: "pending",
			run_id: "run-held",
			payload: {
				metadata: {
					workflowEngine: {
						attempts: 5,
						epochKey: "3:cleanup_requested",
					},
				},
			},
		});
		expect(
			store.holdWorkflowLandNode({
				runId: "run-held",
				nodeId: "land",
				attempt: 1,
				executionId: "land-exec",
				operationId: operation.operation_id,
				reason: "retry_exhausted:linear_lookup_failed_retryable",
				now: "2026-07-21T20:00:04.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		store.close();
	});

	it("atomically enqueues and lease-fences legacy held alerts", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			issueId: "FLY-1861-legacy",
			projectName: "flywheel",
			prNumber: 1861,
			approvedHead: HEAD,
			now: "2026-08-18T00:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "legacy-worker",
			now: "2026-08-18T00:00:01.000Z",
			leaseExpiresAt: "2026-08-18T00:10:01.000Z",
		})!;
		store.releaseLandOperationWithRetryAccounting({
			operationId: operation.operation_id,
			ownerId: claim.ownerId,
			generation: claim.generation,
			class: "terminal",
			reason: "ship_workflow_failed:ci_failure",
			now: "2026-08-18T00:00:02.000Z",
		});

		expect(store.getLandOperation(operation.operation_id)?.state).toBe("held");
		expect(store.listLandAlertOutbox()).toMatchObject([
			{
				operation_id: operation.operation_id,
				resume_generation: 0,
				state: "pending",
				attempt: 0,
				payload: {
					issueId: "FLY-1861-legacy",
					reason: "ship_workflow_failed:ci_failure",
				},
			},
		]);
		const first = store.claimNextLandAlert({
			ownerId: "alert-a",
			now: "2026-08-18T00:00:03.000Z",
			leaseExpiresAt: "2026-08-18T00:01:03.000Z",
		});
		expect(first).toMatchObject({ attempt: 1, generation: 1 });
		expect(
			store.claimNextLandAlert({
				ownerId: "alert-b",
				now: "2026-08-18T00:00:04.000Z",
				leaseExpiresAt: "2026-08-18T00:01:04.000Z",
			}),
		).toBeUndefined();
		const reclaimed = store.claimNextLandAlert({
			ownerId: "alert-b",
			now: "2026-08-18T00:01:03.000Z",
			leaseExpiresAt: "2026-08-18T00:02:03.000Z",
		});
		expect(reclaimed).toMatchObject({ attempt: 2, generation: 2 });
		expect(
			store.finishLandAlertDelivery({
				operationId: operation.operation_id,
				resumeGeneration: 0,
				ownerId: first!.ownerId,
				generation: first!.generation,
				outcome: "sent",
				now: "2026-08-18T00:01:04.000Z",
			}),
		).toEqual({ ok: false, reason: "stale_land_alert_generation" });
		expect(
			store.finishLandAlertDelivery({
				operationId: operation.operation_id,
				resumeGeneration: 0,
				ownerId: reclaimed!.ownerId,
				generation: reclaimed!.generation,
				outcome: "sent",
				now: "2026-08-18T00:01:04.000Z",
			}),
		).toEqual({ ok: true, state: "sent" });
		store.close();
	});

	it("resumes an engine-owned held land operation and its run in one audited generation", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-resume-held",
			issueId: "FLY-1861",
			projectName: "flywheel",
			snapshotJson: landSnapshot(),
			claimsReadEnrolled: true,
		});
		const sql = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		sql.run(
			"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'land' WHERE run_id = 'run-resume-held'",
		);
		store.upsertWorkflowRunNode({
			runId: "run-resume-held",
			nodeId: "land",
			attempt: 1,
			state: "pending",
			executionId: "land-resume-exec",
		});
		store.upsertWorkflowRunNode({
			runId: "run-resume-held",
			nodeId: "qa",
			attempt: 1,
			state: "done",
			executionId: "qa-resume-exec",
		});
		sql.run(
			`INSERT INTO workflow_side_effect_ledger
			   (run_id,node_id,attempt,kind,launch_ordinal,execution_id,state,
			    created_at,updated_at,committed_at)
			 VALUES ('run-resume-held','land',1,'dispatch',1,
			         'land-resume-exec','launch_committed',?,?,?)`,
			[
				"2026-08-18T00:00:00.000Z",
				"2026-08-18T00:00:00.000Z",
				"2026-08-18T00:00:00.000Z",
			],
		);
		sql.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id,node_id,attempt,pr_number,head_sha,target_repo_identity,
			    probe_repo_slug,target_repo_path,worktree_binding_generation,
			    receipt_id,bound_at)
			 VALUES ('run-resume-held','qa',1,1861,?,'__main__',
			         'xrliAnnie/flywheel','/tmp/flywheel','generation-1',
			         'resume-binding','2026-08-18T00:00:00.000Z')`,
			[HEAD],
		);
		const holder = store.ensureWorkflowGateHolder({
			runId: "run-resume-held",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: HEAD,
			sourceExecutionId: "qa-resume-exec",
			questionId: "resume-ship-question",
			now: "2026-08-18T00:00:00.000Z",
		});
		sql.run(
			"UPDATE workflow_gate_holder SET state = 'approved' WHERE question_id = ?",
			[holder.question_id],
		);
		const operation = store.ensureLandOperation({
			runId: "run-resume-held",
			issueId: "FLY-1861",
			projectName: "flywheel",
			prNumber: 1861,
			approvedHead: HEAD,
			now: "2026-08-18T00:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "land-worker",
			now: "2026-08-18T00:00:01.000Z",
			leaseExpiresAt: "2026-08-18T00:10:01.000Z",
		})!;
		store.setLandOperationDisposition({
			operationId: operation.operation_id,
			ownerId: claim.ownerId,
			generation: claim.generation,
			state: "held",
			error: "ship_workflow_failed:ci_failure",
			now: "2026-08-18T00:00:02.000Z",
		});
		expect(
			store.holdWorkflowLandNode({
				runId: "run-resume-held",
				nodeId: "land",
				attempt: 1,
				executionId: "land-resume-exec",
				operationId: operation.operation_id,
				reason: "ship_workflow_failed:ci_failure",
				now: "2026-08-18T00:00:03.000Z",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toMatchObject({ ok: true });

		const beforeNode = store.getWorkflowRunNode("run-resume-held", "land", 1);
		const beforeLedger = store.listWorkflowSideEffects("run-resume-held");
		const resumed = store.resumeHeldLandOperation({
			operationId: operation.operation_id,
			actor: "operator",
			reason: "CI failure reviewed; retry authorized",
			now: "2026-08-18T00:01:00.000Z",
			expectedPrDisposition: "open",
			expectedHeadSha: HEAD,
		});
		expect(resumed).toMatchObject({
			ok: true,
			operation: {
				state: "partial",
				resume_generation: 1,
				ship_attempt: 1,
				retry_count: 0,
				next_attempt_at: "2026-08-18T00:01:00.000Z",
			},
		});
		expect(store.getWorkflowRun("run-resume-held")?.status).toBe("active");
		expect(store.getWorkflowRunNode("run-resume-held", "land", 1)).toEqual(
			beforeNode,
		);
		expect(store.listWorkflowSideEffects("run-resume-held")).toEqual(
			beforeLedger,
		);
		expect(
			store
				.listLandOperationSteps(operation.operation_id)
				.find((step) => step.step === "resume_authorized:1")?.receipt,
		).toMatchObject({
			actor: "operator",
			reason: "CI failure reviewed; retry authorized",
			priorLastError: "ship_workflow_failed:ci_failure",
		});
		store.close();
	});

	it("creates the land retry and Linear Done columns with byte-compatible defaults", async () => {
		const store = await StateStore.create(":memory:");
		const db = (
			store as unknown as {
				db: {
					raw: {
						prepare(sql: string): { all(): Array<{ name: string }> };
					};
				};
			}
		).db;
		const columns = new Set(
			db.raw
				.prepare("PRAGMA table_info(land_operation)")
				.all()
				.map((row) => row.name),
		);
		for (const column of [
			"ship_attempt",
			"resume_generation",
			"retry_count",
			"retry_epoch_key",
			"next_attempt_at",
			"linear_done_disposition",
			"linear_done_deferred_at",
			"linear_done_settled_at",
			"linear_done_last_reason",
			"linear_done_retry_count",
			"linear_done_next_attempt_at",
			"linear_done_last_attempt_at",
		]) {
			expect(columns.has(column), `missing ${column}`).toBe(true);
		}

		const operation = store.ensureLandOperation({
			runId: "run-defaults",
			issueId: "issue-defaults",
			projectName: "flywheel",
			prNumber: 1770,
			approvedHead: HEAD,
			now: "2026-08-14T20:00:00.000Z",
		});
		expect(operation).toMatchObject({
			ship_attempt: 0,
			resume_generation: 0,
			retry_count: 0,
			retry_epoch_key: null,
			next_attempt_at: null,
			linear_done_disposition: null,
			linear_done_deferred_at: null,
			linear_done_settled_at: null,
			linear_done_last_reason: null,
			linear_done_retry_count: 0,
			linear_done_next_attempt_at: null,
			linear_done_last_attempt_at: null,
		});
		store.close();
	});

	it("migrates a legacy land table idempotently across reopen", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1770-land-migration-"));
		const dbPath = join(root, "state.db");
		try {
			const legacy = new BetterSqlite3(dbPath);
			legacy.exec(`
				CREATE TABLE land_operation (
					operation_id TEXT PRIMARY KEY,
					run_id TEXT,
					issue_id TEXT NOT NULL,
					project_name TEXT NOT NULL,
					pr_number INTEGER NOT NULL,
					approved_head TEXT NOT NULL,
					state TEXT NOT NULL DEFAULT 'intent',
					owner_id TEXT,
					lease_expires_at TEXT,
					generation INTEGER NOT NULL DEFAULT 0,
					current_step TEXT,
					merge_confirmed_at TEXT,
					finalization_completed_at TEXT,
					last_error TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					UNIQUE (project_name, issue_id, pr_number, approved_head)
				)
			`);
			legacy.close();

			for (let reopen = 0; reopen < 2; reopen += 1) {
				const store = await StateStore.create(dbPath);
				const operation = store.ensureLandOperation({
					runId: "run-migration",
					issueId: "issue-migration",
					projectName: "flywheel",
					prNumber: 1770,
					approvedHead: HEAD,
					now: "2026-08-14T20:00:00.000Z",
				});
				expect(operation).toMatchObject({
					ship_attempt: 0,
					resume_generation: 0,
					retry_count: 0,
					next_attempt_at: null,
					linear_done_disposition: null,
				});
				store.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("enforces next_attempt_at in both runnable discovery and direct claims", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			runId: "run-due",
			issueId: "issue-due",
			projectName: "flywheel",
			prNumber: 1770,
			approvedHead: HEAD,
			now: "2026-08-14T20:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "worker-a",
			now: "2026-08-14T20:00:01.000Z",
			leaseExpiresAt: "2026-08-14T20:01:01.000Z",
		})!;
		const released = store.releaseLandOperationWithRetryAccounting({
			operationId: operation.operation_id,
			ownerId: claim.ownerId,
			generation: claim.generation,
			class: "retryable",
			reason: "linear_lookup_failed_retryable",
			now: "2026-08-14T20:00:02.000Z",
		});
		expect(released).toMatchObject({
			state: "partial",
			retryCount: 1,
			nextAttemptAt: "2026-08-14T20:01:02.000Z",
		});

		expect(
			store.listRunnableLandOperations("2026-08-14T20:01:01.999Z"),
		).toEqual([]);
		expect(
			store.claimLandOperation({
				operationId: operation.operation_id,
				ownerId: "worker-b",
				now: "2026-08-14T20:01:01.999Z",
				leaseExpiresAt: "2026-08-14T20:02:01.999Z",
			}),
		).toBeUndefined();
		expect(
			store.listRunnableLandOperations("2026-08-14T20:01:02.000Z"),
		).toMatchObject([{ operation_id: operation.operation_id }]);
		expect(
			store.claimLandOperation({
				operationId: operation.operation_id,
				ownerId: "worker-b",
				now: "2026-08-14T20:01:02.000Z",
				leaseExpiresAt: "2026-08-14T20:02:02.000Z",
			}),
		).toMatchObject({ ownerId: "worker-b", generation: 2 });
		store.close();
	});

	it("rejects an invalid retry release time without throwing or mutating the lease", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			runId: "run-invalid-retry-time",
			issueId: "issue-invalid-retry-time",
			projectName: "flywheel",
			prNumber: 1770,
			approvedHead: HEAD,
			now: "2026-08-14T20:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "worker-a",
			now: "2026-08-14T20:00:01.000Z",
			leaseExpiresAt: "2026-08-14T20:10:01.000Z",
		})!;

		expect(
			store.releaseLandOperationWithRetryAccounting({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				class: "retryable",
				reason: "linear_lookup_failed_retryable",
				now: "not-a-timestamp",
			}),
		).toBeUndefined();
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			state: "running",
			owner_id: claim.ownerId,
			generation: claim.generation,
			retry_count: 0,
		});
		store.close();
	});

	it("accounts retry budget atomically against the durable step epoch", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			runId: "run-epoch",
			issueId: "issue-epoch",
			projectName: "flywheel",
			prNumber: 1770,
			approvedHead: HEAD,
			now: "2026-08-14T21:00:00.000Z",
		});
		let claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "worker",
			now: "2026-08-14T21:00:01.000Z",
			leaseExpiresAt: "2026-08-14T21:10:01.000Z",
		})!;
		expect(
			store.recordLandOperationStep({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				step: "merge_confirmed",
				receipt: { mergeSha: "b".repeat(40) },
				now: "2026-08-14T21:00:02.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.releaseLandOperationWithRetryAccounting({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				class: "retryable",
				reason: "issue_closeout_incomplete",
				now: "2026-08-14T21:00:03.000Z",
			}),
		).toMatchObject({
			state: "partial",
			retryCount: 1,
			retryEpochKey: "1:merge_confirmed",
			nextAttemptAt: "2026-08-14T21:01:03.000Z",
		});

		claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "worker",
			now: "2026-08-14T21:01:03.000Z",
			leaseExpiresAt: "2026-08-14T21:11:03.000Z",
		})!;
		expect(
			store.recordLandOperationStep({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				step: "cleanup_requested",
				receipt: { requested: 2, acked: 2, timedOut: 0 },
				now: "2026-08-14T21:01:04.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.releaseLandOperationWithRetryAccounting({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				class: "retryable",
				reason: "land_execution_error:discord unavailable",
				now: "2026-08-14T21:01:05.000Z",
			}),
		).toMatchObject({
			state: "partial",
			retryCount: 1,
			retryEpochKey: "2:cleanup_requested",
			nextAttemptAt: "2026-08-14T21:02:05.000Z",
		});

		expect(
			store.releaseLandOperationWithRetryAccounting({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				class: "retryable",
				reason: "late stale writer",
				now: "2026-08-14T21:01:06.000Z",
			}),
		).toBeUndefined();
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			state: "partial",
			retry_count: 1,
			retry_epoch_key: "2:cleanup_requested",
		});
		store.close();
	});

	it("records deferred Linear Done exactly once behind the land lease fence", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			runId: "run-linear-deferred",
			issueId: "issue-linear-deferred",
			projectName: "flywheel",
			prNumber: 1770,
			approvedHead: HEAD,
			now: "2026-08-14T22:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "worker-a",
			now: "2026-08-14T22:00:01.000Z",
			leaseExpiresAt: "2026-08-14T22:10:01.000Z",
		})!;

		expect(
			store.recordLandLinearDoneDisposition({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				disposition: "deferred",
				reason: "linear_done_timeout",
				executionId: "land-exec",
				now: "2026-08-14T22:00:02.000Z",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			linear_done_disposition: "deferred",
			linear_done_deferred_at: "2026-08-14T22:00:02.000Z",
			linear_done_settled_at: null,
			linear_done_last_reason: "linear_done_timeout",
		});
		expect(
			store.listDeferredLandLinearDone("2026-08-14T22:00:03.000Z", 10),
		).toEqual([]);
		expect(
			store.getWorkflowAlertOutbox(
				`linear_done_deferred:${operation.operation_id}`,
			),
		).toMatchObject({
			state: "pending",
			payload: {
				severity: "warning",
				metadata: {
					workflowEngine: { disposition: "linear_done_deferred" },
				},
			},
		});

		expect(
			store.recordLandLinearDoneDisposition({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				disposition: "deferred",
				reason: "linear_done_timeout",
				executionId: "land-exec",
				now: "2026-08-14T22:00:03.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(
			store.recordLandOperationStep({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				step: "finalization_completed",
				receipt: { complete: true },
				now: "2026-08-14T22:00:04.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.listDeferredLandLinearDone("2026-08-14T22:00:04.000Z", 10),
		).toMatchObject([{ operation_id: operation.operation_id }]);
		store.close();
	});

	it("requires a Linear Done disposition before recording finalization completion", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			runId: "run-linear-invariant",
			issueId: "issue-linear-invariant",
			projectName: "flywheel",
			prNumber: 1771,
			approvedHead: HEAD,
			now: "2026-08-14T23:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "worker-a",
			now: "2026-08-14T23:00:01.000Z",
			leaseExpiresAt: "2026-08-14T23:10:01.000Z",
		})!;
		const finalization = () =>
			store.recordLandOperationStep({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				step: "finalization_completed",
				receipt: { complete: true },
				now: "2026-08-14T23:00:03.000Z",
			});

		expect(finalization()).toEqual({
			ok: false,
			reason: "land_linear_done_disposition_incomplete",
		});
		expect(
			store.recordLandLinearDoneDisposition({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				disposition: "done",
				reason: "already_completed",
				executionId: "land-exec",
				now: "2026-08-14T23:00:02.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(finalization()).toEqual({ ok: true, idempotentReplay: false });
		expect(store.getLandOperation(operation.operation_id)?.state).toBe(
			"completed",
		);
		store.close();
	});

	it("settles only the exact deferred operation and rejects stale writers", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			runId: "run-linear-settle",
			issueId: "issue-linear-settle",
			projectName: "flywheel",
			prNumber: 1772,
			approvedHead: HEAD,
			now: "2026-08-15T00:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "worker-a",
			now: "2026-08-15T00:00:01.000Z",
			leaseExpiresAt: "2026-08-15T00:10:01.000Z",
		})!;
		expect(
			store.recordLandLinearDoneDisposition({
				operationId: operation.operation_id,
				ownerId: "stale-worker",
				generation: claim.generation,
				disposition: "deferred",
				reason: "offline",
				executionId: "land-exec",
				now: "2026-08-15T00:00:02.000Z",
			}),
		).toEqual({ ok: false, reason: "stale_land_generation" });
		expect(
			store.recordLandLinearDoneDisposition({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				disposition: "deferred",
				reason: "offline",
				executionId: "land-exec",
				now: "2026-08-15T00:00:02.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		(
			store as unknown as { db: { run(sql: string, params?: unknown[]): void } }
		).db.run(
			"UPDATE land_operation SET state = 'completed' WHERE operation_id = ?",
			[operation.operation_id],
		);
		expect(
			store.settleDeferredLandLinearDone({
				operationId: operation.operation_id,
				disposition: "done",
				reason: "already_completed",
				now: "2026-08-15T00:15:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.listDeferredLandLinearDone("2026-08-15T00:15:00.000Z", 10),
		).toEqual([]);
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			linear_done_disposition: "done",
			linear_done_settled_at: "2026-08-15T00:15:00.000Z",
		});
		store.close();
	});

	it("rotates a failed deferred Linear row so later due work cannot starve", async () => {
		const store = await StateStore.create(":memory:");
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		for (const [suffix, deferredAt] of [
			["old", "2026-08-15T02:00:00.000Z"],
			["new", "2026-08-15T02:01:00.000Z"],
		] as const) {
			const operation = store.ensureLandOperation({
				runId: `run-linear-${suffix}`,
				issueId: `issue-linear-${suffix}`,
				projectName: "flywheel",
				prNumber: suffix === "old" ? 1774 : 1775,
				approvedHead: suffix === "old" ? HEAD : "b".repeat(40),
				now: deferredAt,
			});
			db.run(
				`UPDATE land_operation
				    SET state = 'completed', linear_done_disposition = 'deferred',
				        linear_done_deferred_at = ?, linear_done_next_attempt_at = ?
				  WHERE operation_id = ?`,
				[deferredAt, deferredAt, operation.operation_id],
			);
		}

		const first = store.listDeferredLandLinearDone(
			"2026-08-15T02:02:00.000Z",
			1,
		)[0]!;
		expect(first.issue_id).toBe("issue-linear-old");
		expect(
			store.deferLandLinearDoneRetry({
				operationId: first.operation_id,
				reason: "no_done_state",
				now: "2026-08-15T02:02:00.000Z",
				nextAttemptAt: "2026-08-15T02:17:00.000Z",
				expectedRetryCount: 0,
			}),
		).toEqual({ ok: true, retryCount: 1 });
		expect(
			store.deferLandLinearDoneRetry({
				operationId: first.operation_id,
				reason: "ambiguous retry replay",
				now: "2026-08-15T02:02:01.000Z",
				nextAttemptAt: "2026-08-15T02:32:01.000Z",
				expectedRetryCount: 0,
			}),
		).toEqual({ ok: false, reason: "land_linear_done_retry_count_changed" });
		expect(
			store.getLandOperation(first.operation_id)?.linear_done_retry_count,
		).toBe(1);
		expect(
			store.listDeferredLandLinearDone("2026-08-15T02:02:00.000Z", 1)[0]
				?.issue_id,
		).toBe("issue-linear-new");
		store.close();
	});

	it("keeps a settled Linear disposition when a later pass can only defer", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			runId: "run-linear-settled-replay",
			issueId: "issue-linear-settled-replay",
			projectName: "flywheel",
			prNumber: 1773,
			approvedHead: HEAD,
			now: "2026-08-15T01:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "worker-a",
			now: "2026-08-15T01:00:01.000Z",
			leaseExpiresAt: "2026-08-15T01:10:01.000Z",
		})!;

		expect(
			store.recordLandLinearDoneDisposition({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				disposition: "done",
				reason: "already_completed",
				executionId: "land-exec",
				now: "2026-08-15T01:00:02.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.recordLandLinearDoneDisposition({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				disposition: "deferred",
				reason: "linear offline on replay",
				executionId: "land-exec",
				now: "2026-08-15T01:00:03.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			linear_done_disposition: "done",
			linear_done_last_reason: "already_completed",
		});
		store.close();
	});
});
