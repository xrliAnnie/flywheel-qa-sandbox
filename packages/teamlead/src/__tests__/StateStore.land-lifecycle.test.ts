import { fileURLToPath } from "node:url";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { describe, expect, it } from "vitest";
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
						role: "generic",
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
		        ('implement-exec','flywheel','FLY-1375','implement','2026-07-21T19:00:00.000Z')`,
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
	).toEqual({ ok: true });
	expect(
		store.advanceWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: "coordinator",
			generation: 1,
			from: "turn_granted",
			to: "wake_delivered",
			now: "2026-07-21T20:02:03.000Z",
			releaseOwner: true,
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		}),
	).toEqual({ ok: true });
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
			invalidation_scope: ["design"],
			verification_policy: ["design_review", "founder_gate"],
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
		).toEqual({ ok: true });
		expect(
			store.advanceWorkflowReworkDelivery({
				requestId: requestId!,
				ownerId: "coordinator",
				generation: 1,
				from: "turn_granted",
				to: "wake_delivered",
				now: "2026-07-21T20:02:03.000Z",
				releaseOwner: true,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toEqual({ ok: true });

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
			targetNodeId: "founder_gate",
			gateOpened: true,
		});
		expect(store.getWorkflowReworkVerificationPath(requestId!)).toMatchObject({
			state: "completed",
			current_node_id: "founder_gate",
		});
		expect(store.getWorkflowReworkDelivery(requestId!)).toMatchObject({
			state: "completed",
		});
		expect(
			store.getCurrentWorkflowGateHolder("run-design-only", "founder_gate"),
		).toMatchObject({
			head_sha: correctedHead,
			source_execution_id: "design-exec",
		});
		store.close();
	});

	it("rejects an invalid correction hint atomically without consuming the founder gate", async () => {
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

		expect(() =>
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId: `founder-feedback:${holder.question_id}:invalid`,
				kind: "founder_feedback",
				payloadJson: canonicalJsonString(sourcePayload),
				payloadDigest: canonicalSubmissionDigest(sourcePayload),
				schemaVersion: 1,
			}),
		).toThrow(/invalid_rework_route|source payload invalid/i);
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId(holder.question_id),
		).toMatchObject({ state: "awaiting_review" });
		expect(
			store
				.listWorkflowRunEvents("run-invalid-hint")
				.filter((entry) => entry.kind === "rework_requested"),
		).toHaveLength(0);
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

		const result = store.holdWorkflowLandNode({
			runId: "run-held",
			nodeId: "land",
			attempt: 1,
			executionId: "land-exec",
			operationId: operation.operation_id,
			reason: "pr_head_mismatch",
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
		expect(store.getWorkflowAlertOutbox(event!.event_uid)).toMatchObject({
			state: "pending",
			run_id: "run-held",
		});
		expect(
			store.holdWorkflowLandNode({
				runId: "run-held",
				nodeId: "land",
				attempt: 1,
				executionId: "land-exec",
				operationId: operation.operation_id,
				reason: "pr_head_mismatch",
				now: "2026-07-21T20:00:04.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		store.close();
	});
});
