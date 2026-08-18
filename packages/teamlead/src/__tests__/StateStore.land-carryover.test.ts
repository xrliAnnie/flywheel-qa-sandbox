import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { describe, expect, it } from "vitest";
import { drainWorkflowSourceEvents } from "../bridge/founder-approval-projector.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../workflow-run-snapshot.js";

const HEAD_A = "a".repeat(40);
const BASE_1 = "b".repeat(40);
const HEAD_B = "c".repeat(40);
const TREE_1 = "d".repeat(40);
const T0 = "2026-08-17T20:00:00.000Z";
const T1 = "2026-08-17T20:01:00.000Z";

function db(store: StateStore): {
	run(sql: string, params?: unknown[]): void;
} {
	return (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
}

function snapshot(): string {
	return JSON.stringify(
		buildWorkflowRunSnapshotV1({
			template: { id: "tpl_fly1833", revision: 1 },
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
						id: "designed",
						from: "design",
						to: "implement",
						condition: "design_done",
					},
					{
						id: "implemented",
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
						id: "approved",
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

async function fixture() {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-carryover",
		issueId: "FLY-1833",
		projectName: "flywheel",
		snapshotJson: snapshot(),
		claimsReadEnrolled: true,
	});
	db(store).run(
		"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'qa' WHERE run_id = 'run-carryover'",
	);
	store.upsertWorkflowRunNode({
		runId: "run-carryover",
		nodeId: "design",
		attempt: 1,
		state: "done",
		executionId: "design-carryover",
	});
	store.upsertWorkflowRunNode({
		runId: "run-carryover",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "implement-carryover",
	});
	store.upsertWorkflowRunNode({
		runId: "run-carryover",
		nodeId: "qa",
		attempt: 1,
		state: "running",
		executionId: "qa-carryover",
	});
	db(store).run(
		`INSERT INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES ('design-carryover','flywheel','FLY-1833','design',?),
		        ('implement-carryover','flywheel','FLY-1833','implement',?),
		        ('qa-carryover','flywheel','FLY-1833','qa',?)`,
		[T0, T0, T0],
	);
	db(store).run(
		`INSERT INTO workflow_node_pr_binding
		   (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
		    probe_repo_slug, target_repo_path, worktree_binding_generation,
		    receipt_id, bound_at)
		 VALUES ('run-carryover','implement',1,1833,?,'__main__',
		         'geoforge3d/flywheel','/tmp/flywheel','generation-1',
		         'root-pr-binding',?)`,
		[HEAD_A, T0],
	);
	db(store).run(
		`INSERT INTO workflow_claims
		   (server_seq, issued_at, issue_id, workflow_run_id, node_id,
		    decision_kind, attempt, predicate, issuer_kind,
		    issuer_execution_id, issuer_node_id, issuer_vendor, issuer_model,
		    subject_producer_execution_id, subject_kind, subject_digest,
		    permanent, submission_digest, client_request_id, authority_id)
		 VALUES (1, ?, 'FLY-1833', 'run-carryover', 'qa',
		         'qa_verdict', 1, 'qa_passed', 'runner_node',
		         'qa-carryover', 'qa', 'claude', 'claude-opus-5',
		         'implement-carryover', 'git_head', ?, 1,
		         'qa-submission', 'qa-client-request', 'qa-carryover')`,
		[T0, HEAD_A],
	);
	const transition = store.commitWorkflowTransitionTx({
		runId: "run-carryover",
		nodeId: "qa",
		attempt: 1,
		executionId: "qa-carryover",
		outcome: "qa_pass",
		subjectDigest: HEAD_A,
		now: T0,
	});
	if (!transition.ok) throw new Error(transition.reason);
	const holder = store.getCurrentWorkflowGateHolder(
		"run-carryover",
		"founder_gate",
	)!;
	store.advanceWorkflowGateHolderMaterialization({
		questionId: holder.question_id,
		stage: "card_bound",
		cardMessageId: "founder-card",
		now: T0,
	});
	const payload = {
		schema_version: 1,
		run_id: "run-carryover",
		issue_id: "FLY-1833",
		question_id: holder.question_id,
		response: { approved: true },
		actor: "founder",
		approved_head: HEAD_A,
		classification: "founder_reaction",
		authority_id: holder.question_id,
	};
	store.applyWorkflowSourceEvent({
		project: "flywheel",
		sourceEventId: `founder-approval:${holder.question_id}`,
		kind: "founder_approval",
		payloadJson: canonicalJsonString(payload),
		payloadDigest: canonicalSubmissionDigest(payload),
		schemaVersion: 1,
	});
	const operation = store.ensureLandOperation({
		runId: "run-carryover",
		issueId: "FLY-1833",
		projectName: "flywheel",
		prNumber: 1833,
		approvedHead: HEAD_A,
		now: T0,
	});
	const claim = store.claimLandOperation({
		operationId: operation.operation_id,
		ownerId: "land-worker",
		now: T0,
		leaseExpiresAt: "2026-08-17T21:00:00.000Z",
	});
	if (!claim) throw new Error("land claim missing");
	return { store, holder, operation, claim };
}

describe("equivalent-head carryover authority", () => {
	it("keeps the synthetic approval origin behind one audited writer", () => {
		const source = readFileSync(
			new URL("../StateStore.ts", import.meta.url),
			"utf8",
		);
		expect(
			source.match(/'engine_equivalence_carryover', 'approved', 'completed'/g),
		).toHaveLength(1);
	});

	it("atomically carries the root approval to an exact tree-proven head", async () => {
		const { store, holder, operation, claim } = await fixture();
		try {
			expect(
				store.resolveEngineWorkflowShipClaims({
					runId: "run-carryover",
					subjectDigest: HEAD_A,
				}),
			).toEqual({ valid: true });
			const committed = store.commitEquivalentHeadCarryover({
				runId: "run-carryover",
				gateNodeId: "founder_gate",
				fromQuestionId: holder.question_id,
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				proof: {
					proofKind: "clean_base_merge_tree_identity",
					approvedHead: HEAD_A,
					baseOid: BASE_1,
					candidateHead: HEAD_B,
					secondParentObserved: BASE_1,
					proofTreeOid: TREE_1,
				},
				now: T1,
			});
			expect(committed).toMatchObject({ ok: true, idempotentReplay: false });
			if (!committed.ok) throw new Error(committed.reason);

			expect(
				store.getCurrentWorkflowGateHolder("run-carryover", "founder_gate"),
			).toMatchObject({
				head_sha: HEAD_B,
				state: "approved",
				approval_origin: "engine_equivalence_carryover",
				materialization_stage: "completed",
				card_message_id: null,
			});
			expect(
				store.getWorkflowGateHolderByQuestionId(holder.question_id),
			).toMatchObject({
				state: "superseded",
				superseded_reason: "head_refresh_equivalent",
			});
			const authority = store.resolveWorkflowExactHeadAuthority({
				runId: "run-carryover",
				headSha: HEAD_B,
			});
			expect(authority).toMatchObject({
				valid: true,
				kind: "carryover",
				depth: 1,
				binding: { head_sha: HEAD_B, receipt_id: "root-pr-binding" },
				rootHead: HEAD_A,
			});
			expect(
				store.resolveEngineWorkflowShipClaims({
					runId: "run-carryover",
					subjectDigest: HEAD_B,
				}),
			).toEqual({ valid: true });
			expect(store.getLandOperation(operation.operation_id)).toMatchObject({
				superseded_by_operation_id: committed.operation.operation_id,
			});
			expect(committed.operation).toMatchObject({
				approved_head: HEAD_B,
				state: "intent",
				carryover_receipt_id: committed.receiptId,
			});
			expect(
				store.getWorkflowCarryoverActivation(committed.receiptId),
			).toMatchObject({ state: "pending", source_cutoff_row_id: null });
			expect(store.listRunnableLandOperations(T1)).toEqual([]);
			expect(
				store.claimLandOperation({
					operationId: committed.operation.operation_id,
					ownerId: "early-worker",
					now: T1,
					leaseExpiresAt: "2026-08-17T21:01:00.000Z",
				}),
			).toBeUndefined();
			expect(
				store.authorizeWorkflowCarryoverDeparture({
					carryoverReceiptId: committed.receiptId,
					sourceCutoffRowId: 42,
					operationId: committed.operation.operation_id,
					expectedGeneration: committed.operation.generation,
					now: T1,
				}),
			).toEqual({ ok: true, idempotentReplay: false });
			expect(
				store.listRunnableLandOperations(T1).map((row) => row.operation_id),
			).toEqual([committed.operation.operation_id]);
			expect(
				store.getWorkflowShipTargetBinding(committed.questionId),
			).toMatchObject({ frozen_head_sha: HEAD_B, superseded_at: null });
		} finally {
			store.close();
		}
	});

	it("keeps receipts immutable and replays the exact carryover", async () => {
		const { store, holder, operation, claim } = await fixture();
		try {
			const input = {
				runId: "run-carryover",
				gateNodeId: "founder_gate",
				fromQuestionId: holder.question_id,
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				proof: {
					proofKind: "clean_base_merge_tree_identity" as const,
					approvedHead: HEAD_A,
					baseOid: BASE_1,
					candidateHead: HEAD_B,
					secondParentObserved: BASE_1,
					proofTreeOid: TREE_1,
				},
				now: T1,
			};
			const first = store.commitEquivalentHeadCarryover(input);
			const replay = store.commitEquivalentHeadCarryover(input);
			expect(first).toMatchObject({ ok: true, idempotentReplay: false });
			expect(replay).toMatchObject({ ok: true, idempotentReplay: true });
			expect(() =>
				db(store).run(
					"UPDATE workflow_head_carryover_receipt SET proof_tree_oid = ?",
					["e".repeat(40)],
				),
			).toThrow(/immutable/);
		} finally {
			store.close();
		}
	});

	it("accounts a carried merge against the declared root head while auditing the effective head", async () => {
		const { store, holder, operation, claim } = await fixture();
		try {
			expect(
				store.openWorkflowPrManifest({
					runId: "run-carryover",
					expectedCount: 1,
					now: T0,
				}),
			).toMatchObject({ ok: true });
			expect(
				store.sealWorkflowPrManifestFromBindings({
					runId: "run-carryover",
					now: T0,
				}),
			).toMatchObject({ ok: true });
			const committed = store.commitEquivalentHeadCarryover({
				runId: "run-carryover",
				gateNodeId: "founder_gate",
				fromQuestionId: holder.question_id,
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				proof: {
					proofKind: "clean_base_merge_tree_identity",
					approvedHead: HEAD_A,
					baseOid: BASE_1,
					candidateHead: HEAD_B,
					secondParentObserved: BASE_1,
					proofTreeOid: TREE_1,
				},
				now: T1,
			});
			if (!committed.ok) throw new Error(committed.reason);
			store.authorizeWorkflowCarryoverDeparture({
				carryoverReceiptId: committed.receiptId,
				sourceCutoffRowId: 7,
				operationId: committed.operation.operation_id,
				expectedGeneration: committed.operation.generation,
				now: T1,
			});
			const successorClaim = store.claimLandOperation({
				operationId: committed.operation.operation_id,
				ownerId: "successor-worker",
				now: T1,
				leaseExpiresAt: "2026-08-17T21:01:00.000Z",
			});
			if (!successorClaim) throw new Error("successor claim missing");

			expect(
				store.recordLandOperationStep({
					operationId: committed.operation.operation_id,
					ownerId: successorClaim.ownerId,
					generation: successorClaim.generation,
					step: "merge_confirmed",
					receipt: { mergedHead: HEAD_B },
					now: T1,
				}),
			).toEqual({ ok: true, idempotentReplay: false });
			expect(store.listCurrentWorkflowDeclaredPrs("run-carryover")).toEqual([
				expect.objectContaining({
					pr_number: 1833,
					frozen_head_sha: HEAD_A,
					state: "merged",
				}),
			]);
			const event = store
				.listWorkflowRunEvents("run-carryover")
				.find((candidate) => candidate.kind === "declared_pr_merged");
			expect(event?.payload).toMatchObject({
				declaredHeadSha: HEAD_A,
				effectiveHeadSha: HEAD_B,
				carryoverReceiptId: committed.receiptId,
			});
		} finally {
			store.close();
		}
	});

	it("authorizes departure only after the CommDB cutoff row is projected", async () => {
		const { store, holder, operation, claim } = await fixture();
		const directory = mkdtempSync(join(tmpdir(), "fly1833-cutoff-"));
		const commPath = join(directory, "comm.db");
		try {
			const committed = store.commitEquivalentHeadCarryover({
				runId: "run-carryover",
				gateNodeId: "founder_gate",
				fromQuestionId: holder.question_id,
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				proof: {
					proofKind: "clean_base_merge_tree_identity",
					approvedHead: HEAD_A,
					baseOid: BASE_1,
					candidateHead: HEAD_B,
					secondParentObserved: BASE_1,
					proofTreeOid: TREE_1,
				},
				now: T1,
			});
			if (!committed.ok) throw new Error(committed.reason);

			expect(store.listRunnableLandOperations(T1)).toEqual([]);
			expect(store.listPendingWorkflowCarryoverDepartures()).toEqual([
				expect.objectContaining({
					carryoverReceiptId: committed.receiptId,
					ordinal: 1,
					operation: expect.objectContaining({
						operation_id: committed.operation.operation_id,
					}),
				}),
			]);
			const pending = store.listPendingWorkflowCarryoverDepartures()[0]!;
			const comm = new CommDB(commPath);
			const cutoff = comm.appendLandDepartureCutoff({
				project: "flywheel",
				carryoverReceiptId: pending.carryoverReceiptId,
				operationId: pending.operation.operation_id,
				ordinal: pending.ordinal,
				runId: "run-carryover",
				approvedHead: pending.operation.approved_head,
				operationGeneration: pending.operation.generation,
				at: T1,
			});
			comm.close();

			expect(store.listRunnableLandOperations(T1)).toEqual([]);
			expect(
				await drainWorkflowSourceEvents({
					projects: ["flywheel"],
					openCommDb: () => new CommDB(commPath),
					store,
				}),
			).toMatchObject({ applied: 1, deadlettered: 0 });
			expect(
				store.getWorkflowCarryoverActivation(committed.receiptId),
			).toMatchObject({
				state: "departure_authorized",
				source_cutoff_row_id: cutoff.rowId,
			});
			expect(
				store.getWorkflowSourceReceipt("flywheel", cutoff.sourceEventId),
			).toMatchObject({ source_row_id: cutoff.rowId });
			expect(
				store.listRunnableLandOperations(T1).map((row) => row.operation_id),
			).toEqual([committed.operation.operation_id]);

			const replay = await drainWorkflowSourceEvents({
				projects: ["flywheel"],
				openCommDb: () => new CommDB(commPath),
				store,
			});
			expect(replay).toMatchObject({ applied: 0, replayed: 0 });
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("fails loud once when carryover cutoff projection cannot converge", async () => {
		const { store, holder, operation, claim } = await fixture();
		try {
			const committed = store.commitEquivalentHeadCarryover({
				runId: "run-carryover",
				gateNodeId: "founder_gate",
				fromQuestionId: holder.question_id,
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				proof: {
					proofKind: "clean_base_merge_tree_identity",
					approvedHead: HEAD_A,
					baseOid: BASE_1,
					candidateHead: HEAD_B,
					secondParentObserved: BASE_1,
					proofTreeOid: TREE_1,
				},
				now: T1,
			});
			if (!committed.ok) throw new Error(committed.reason);
			const at = "2026-08-17T21:01:00.000Z";
			const expired = store.expireWorkflowCarryoverDeparture({
				carryoverReceiptId: committed.receiptId,
				operationId: committed.operation.operation_id,
				now: at,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			});
			expect(expired).toMatchObject({ ok: true, idempotentReplay: false });
			expect(
				store.getWorkflowCarryoverActivation(committed.receiptId),
			).toMatchObject({
				state: "superseded",
				alert_uid: expect.stringContaining("carryover_departure_horizon"),
			});
			expect(
				store.getLandOperation(committed.operation.operation_id),
			).toMatchObject({
				state: "held",
				last_error: "carryover_activation_horizon_exceeded",
			});
			expect(store.getWorkflowRun("run-carryover")).toMatchObject({
				status: "held",
			});
			expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
			expect(
				store.expireWorkflowCarryoverDeparture({
					carryoverReceiptId: committed.receiptId,
					operationId: committed.operation.operation_id,
					now: at,
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
			).toMatchObject({ ok: true, idempotentReplay: true });
			expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("invalidates the full chain when its root founder claim is revoked", async () => {
		const { store, holder, operation, claim } = await fixture();
		try {
			const committed = store.commitEquivalentHeadCarryover({
				runId: "run-carryover",
				gateNodeId: "founder_gate",
				fromQuestionId: holder.question_id,
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				proof: {
					proofKind: "clean_base_merge_tree_identity",
					approvedHead: HEAD_A,
					baseOid: BASE_1,
					candidateHead: HEAD_B,
					secondParentObserved: BASE_1,
					proofTreeOid: TREE_1,
				},
				now: T1,
			});
			if (!committed.ok) throw new Error(committed.reason);
			const authority = store.resolveWorkflowExactHeadAuthority({
				runId: "run-carryover",
				headSha: HEAD_B,
			});
			if (!authority.valid || authority.kind !== "carryover") {
				throw new Error("carryover authority missing");
			}
			store.revokeWorkflowClaim({
				claimId: Number(authority.rootFounderClaimRef),
				reason: "founder_feedback_after_refresh",
				actor: "engine",
			});
			expect(
				store.resolveWorkflowExactHeadAuthority({
					runId: "run-carryover",
					headSha: HEAD_B,
				}),
			).toEqual({
				valid: false,
				reason: "carryover_root_founder_claim_invalid",
			});
		} finally {
			store.close();
		}
	});

	it("opens engine-owned implement rework for a semantic merge conflict", async () => {
		const { store, operation, claim } = await fixture();
		try {
			expect(
				store.recordLandOperationStep({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					step: "base_refresh_prepared",
					receipt: { approvedHead: HEAD_A, baseOid: BASE_1 },
					now: T1,
				}),
			).toMatchObject({ ok: true });

			const opened = store.openEngineLandConflictRework({
				runId: "run-carryover",
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				proofStep: "base_refresh_prepared",
				reason: "merge_conflict_requires_rework",
				now: T1,
			});
			expect(opened).toMatchObject({
				ok: true,
				targetNodeId: "implement",
				targetAttempt: 2,
			});
			if (!opened.ok) throw new Error(opened.reason);

			expect(store.getWorkflowRun("run-carryover")).toMatchObject({
				status: "active",
				current_node_id: "implement",
			});
			expect(store.getLandOperation(operation.operation_id)).toMatchObject({
				superseded_at: T1,
			});
			expect(store.getWorkflowReworkRequest(opened.requestId)).toMatchObject({
				authority: "engine",
				base_revision: HEAD_A,
			});
			expect(
				store.getLatestWorkflowReworkRoute(opened.requestId),
			).toMatchObject({
				target_node_id: "implement",
				invalidation_scope: ["implement", "qa"],
				verification_policy: ["code_review", "qa_retest", "founder_gate"],
			});
			expect(store.getWorkflowReworkDelivery(opened.requestId)).toMatchObject({
				state: "pending",
			});
			expect(
				store.resolveWorkflowDecisionClaim({
					runId: "run-carryover",
					decisionKind: "founder_decision",
					subjectKind: "git_head",
					subjectDigest: HEAD_A,
				}),
			).toMatchObject({ valid: false, reason: "revoked" });
		} finally {
			store.close();
		}
	});

	it("accepts an immutable refresh proof from the prior land lease generation", async () => {
		const { store, operation, claim } = await fixture();
		try {
			expect(
				store.recordLandOperationStep({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					step: "base_refresh_requested",
					receipt: { approvedHead: HEAD_A, baseOid: BASE_1 },
					now: T1,
				}),
			).toMatchObject({ ok: true });
			store.releaseLandOperationWithRetryAccounting({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				class: "waiting",
				reason: "base_refresh_pending",
				now: T1,
			});
			const resumed = store.claimLandOperation({
				operationId: operation.operation_id,
				ownerId: "land-worker-next",
				now: "2026-08-17T20:02:00.000Z",
				leaseExpiresAt: "2026-08-17T21:02:00.000Z",
			});
			if (!resumed) throw new Error("resumed land claim missing");

			expect(
				store.openEngineLandConflictRework({
					runId: "run-carryover",
					operationId: operation.operation_id,
					ownerId: resumed.ownerId,
					generation: resumed.generation,
					proofStep: "base_refresh_requested",
					reason: "merge_conflict_requires_rework",
					now: "2026-08-17T20:02:00.000Z",
				}),
			).toMatchObject({ ok: true, targetNodeId: "implement" });
		} finally {
			store.close();
		}
	});

	it("stops automatic conflict rework after three immutable engine cycles", async () => {
		const { store, operation, claim } = await fixture();
		try {
			expect(
				store.recordLandOperationStep({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					step: "base_refresh_prepared",
					receipt: { approvedHead: HEAD_A, baseOid: BASE_1 },
					now: T1,
				}),
			).toMatchObject({ ok: true });
			for (let cycle = 1; cycle <= 3; cycle += 1) {
				db(store).run(
					`INSERT INTO workflow_rework_request
					   (request_id, run_id, source_event_id, authority, source_node_id,
					    source_attempt, base_revision, authority_context_json,
					    authority_context_digest, founder_feedback_verbatim, requested_at)
					 VALUES (?, 'run-carryover', ?, 'engine', 'land', 1, ?, '{}', ?, NULL, ?)`,
					[
						`prior-engine-${cycle}`,
						`prior-engine-event-${cycle}`,
						HEAD_A,
						String(cycle).repeat(64),
						T0,
					],
				);
			}

			expect(
				store.openEngineLandConflictRework({
					runId: "run-carryover",
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					proofStep: "base_refresh_prepared",
					reason: "merge_conflict_requires_rework",
					now: T1,
				}),
			).toEqual({ ok: false, reason: "engine_land_rework_cycle_limit" });
			expect(store.getWorkflowRun("run-carryover")).toMatchObject({
				status: "active",
				current_node_id: "land",
			});
			expect(store.getLandOperation(operation.operation_id)).toMatchObject({
				superseded_at: null,
				state: "running",
			});
		} finally {
			store.close();
		}
	});

	it("lets founder feedback before the departure cutoff win over carryover", async () => {
		const { store, holder, operation, claim } = await fixture();
		try {
			const committed = store.commitEquivalentHeadCarryover({
				runId: "run-carryover",
				gateNodeId: "founder_gate",
				fromQuestionId: holder.question_id,
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				proof: {
					proofKind: "clean_base_merge_tree_identity",
					approvedHead: HEAD_A,
					baseOid: BASE_1,
					candidateHead: HEAD_B,
					secondParentObserved: BASE_1,
					proofTreeOid: TREE_1,
				},
				now: T1,
			});
			if (!committed.ok) throw new Error(committed.reason);
			const feedbackPayload = {
				schema_version: 1,
				run_id: "run-carryover",
				issue_id: "FLY-1833",
				question_id: holder.question_id,
				response: {
					approved: false,
					feedback: "Please revise the implementation.",
				},
				actor: "founder",
				approved_head: HEAD_A,
				classification: "founder_reaction",
				authority_id: holder.question_id,
			};

			expect(
				store.applyWorkflowSourceEvent({
					project: "flywheel",
					sourceEventId: `founder-feedback:${holder.question_id}:late`,
					kind: "founder_feedback",
					payloadJson: canonicalJsonString(feedbackPayload),
					payloadDigest: canonicalSubmissionDigest(feedbackPayload),
					schemaVersion: 1,
				}),
			).toEqual({ kind: "founder_feedback", status: "applied" });
			expect(
				store.getWorkflowCarryoverActivation(committed.receiptId),
			).toMatchObject({ state: "superseded" });
			expect(
				store.getLandOperation(committed.operation.operation_id),
			).toMatchObject({ superseded_at: expect.any(String) });
			expect(store.getWorkflowRun("run-carryover")).toMatchObject({
				current_node_id: "implement",
				status: "active",
			});
			const request = store.listWorkflowReworkRequests("run-carryover").at(-1);
			expect(request).toMatchObject({
				authority: "founder",
				founder_feedback_verbatim: "Please revise the implementation.",
			});

			const cutoffPayload = {
				schema_version: 1,
				run_id: "run-carryover",
				carryover_receipt_id: committed.receiptId,
				operation_id: committed.operation.operation_id,
				ordinal: committed.ordinal,
				approved_head: HEAD_B,
				operation_generation: committed.operation.generation,
			};
			const cutoffId = `land-departure-cutoff:${canonicalSubmissionDigest({
				carryoverReceiptId: committed.receiptId,
				operationId: committed.operation.operation_id,
				ordinal: committed.ordinal,
			})}`;
			expect(
				store.applyWorkflowSourceEvent({
					project: "flywheel",
					sourceEventId: cutoffId,
					kind: "land_departure_cutoff",
					payloadJson: canonicalJsonString(cutoffPayload),
					payloadDigest: canonicalSubmissionDigest(cutoffPayload),
					schemaVersion: 1,
					sourceRowId: 22,
					at: T1,
				}),
			).toEqual({ kind: "land_departure_cutoff", status: "applied" });
			expect(
				store.getWorkflowCarryoverActivation(committed.receiptId),
			).toMatchObject({ state: "superseded", source_cutoff_row_id: null });
		} finally {
			store.close();
		}
	});

	it("caps one founder approval lineage at three proven segments", async () => {
		const { store, holder, operation, claim } = await fixture();
		try {
			let fromHead = HEAD_A;
			let fromQuestionId = holder.question_id;
			let currentOperation = operation;
			let currentClaim = claim;
			const candidates = [HEAD_B, "e".repeat(40), "f".repeat(40)];
			for (const [index, candidateHead] of candidates.entries()) {
				const base = String(index + 1).repeat(40);
				const committed = store.commitEquivalentHeadCarryover({
					runId: "run-carryover",
					gateNodeId: "founder_gate",
					fromQuestionId,
					operationId: currentOperation.operation_id,
					ownerId: currentClaim.ownerId,
					generation: currentClaim.generation,
					proof: {
						proofKind: "clean_base_merge_tree_identity",
						approvedHead: fromHead,
						baseOid: base,
						candidateHead,
						secondParentObserved: base,
						proofTreeOid: (index + 4).toString(16).repeat(40),
					},
					now: `2026-08-17T20:0${index + 1}:00.000Z`,
				});
				expect(committed.ok).toBe(true);
				if (!committed.ok) throw new Error(committed.reason);
				fromHead = candidateHead;
				fromQuestionId = committed.questionId;
				currentOperation = committed.operation;
				store.authorizeWorkflowCarryoverDeparture({
					carryoverReceiptId: committed.receiptId,
					sourceCutoffRowId: index + 1,
					operationId: currentOperation.operation_id,
					expectedGeneration: currentOperation.generation,
					now: `2026-08-17T20:0${index + 1}:01.000Z`,
				});
				const nextClaim = store.claimLandOperation({
					operationId: currentOperation.operation_id,
					ownerId: `land-worker-${index + 2}`,
					now: `2026-08-17T20:0${index + 1}:02.000Z`,
					leaseExpiresAt: "2026-08-17T21:30:00.000Z",
				});
				if (!nextClaim) throw new Error("next land claim missing");
				currentClaim = nextClaim;
			}
			const fourthBase = "8".repeat(40);
			expect(
				store.commitEquivalentHeadCarryover({
					runId: "run-carryover",
					gateNodeId: "founder_gate",
					fromQuestionId,
					operationId: currentOperation.operation_id,
					ownerId: currentClaim.ownerId,
					generation: currentClaim.generation,
					proof: {
						proofKind: "clean_base_merge_tree_identity",
						approvedHead: fromHead,
						baseOid: fourthBase,
						candidateHead: "9".repeat(40),
						secondParentObserved: fourthBase,
						proofTreeOid: "7".repeat(40),
					},
					now: "2026-08-17T20:05:00.000Z",
				}),
			).toEqual({ ok: false, reason: "carryover_lineage_limit" });
		} finally {
			store.close();
		}
	});

	it("serializes cool effects with an append-only attempt fence", async () => {
		const { store, operation, claim } = await fixture();
		try {
			const prepared = store.prepareLandCoolAttempt({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				repoIdentity: "__main__",
				now: T1,
			});
			expect(prepared).toMatchObject({
				ok: true,
				idempotentReplay: false,
				attempt: { ordinal: 1, state: "prepared", head_sha: HEAD_A },
			});
			if (!prepared.ok) throw new Error(prepared.reason);

			const other = store.ensureLandOperation({
				issueId: "FLY-other",
				projectName: "flywheel",
				prNumber: 1834,
				approvedHead: "e".repeat(40),
				now: T1,
			});
			expect(
				store.claimLandOperation({
					operationId: other.operation_id,
					ownerId: "other-worker",
					now: T1,
					leaseExpiresAt: "2026-08-17T21:01:00.000Z",
				}),
			).toBeUndefined();
			expect(
				store.markLandCoolAttemptSent({
					operationId: operation.operation_id,
					ordinal: prepared.attempt.ordinal,
					ownerId: claim.ownerId,
					generation: claim.generation,
					commentId: "comment-1",
					now: T1,
				}),
			).toMatchObject({ ok: true, attempt: { state: "sent" } });
			store.releaseLandOperationWithRetryAccounting({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				class: "waiting",
				reason: "ship_workflow_pending",
				now: T1,
			});
			const otherClaim = store.claimLandOperation({
				operationId: other.operation_id,
				ownerId: "other-worker",
				now: T1,
				leaseExpiresAt: "2026-08-17T21:01:00.000Z",
			});
			if (!otherClaim) throw new Error("other claim missing after release");
			expect(
				store.prepareLandCoolAttempt({
					operationId: other.operation_id,
					ownerId: otherClaim.ownerId,
					generation: otherClaim.generation,
					repoIdentity: "__main__",
					now: T1,
				}),
			).toEqual({ ok: false, reason: "land_external_effect_inflight" });

			store.releaseLandOperationWithRetryAccounting({
				operationId: other.operation_id,
				ownerId: otherClaim.ownerId,
				generation: otherClaim.generation,
				class: "waiting",
				reason: "land_queue_busy",
				now: T1,
			});
			const resumedClaim = store.claimLandOperation({
				operationId: operation.operation_id,
				ownerId: "resumed-worker",
				now: T1,
				leaseExpiresAt: "2026-08-17T21:01:00.000Z",
			});
			if (!resumedClaim) throw new Error("resumed claim missing");
			expect(
				store.markLandCoolAttemptTerminal({
					operationId: operation.operation_id,
					ordinal: prepared.attempt.ordinal,
					ownerId: resumedClaim.ownerId,
					generation: resumedClaim.generation,
					attemptGeneration: claim.generation,
					classification: "external_outage",
					shipRunId: "run-remote-1",
					now: T1,
				}),
			).toMatchObject({ ok: true, attempt: { state: "terminal" } });
			store.releaseLandOperationWithRetryAccounting({
				operationId: operation.operation_id,
				ownerId: resumedClaim.ownerId,
				generation: resumedClaim.generation,
				class: "waiting",
				reason: "external_outage",
				now: T1,
			});
			const otherResumed = store.claimLandOperation({
				operationId: other.operation_id,
				ownerId: "other-worker-2",
				now: T1,
				leaseExpiresAt: "2026-08-17T21:01:00.000Z",
			});
			if (!otherResumed) throw new Error("other resumed claim missing");
			expect(
				store.prepareLandCoolAttempt({
					operationId: other.operation_id,
					ownerId: otherResumed.ownerId,
					generation: otherResumed.generation,
					repoIdentity: "__main__",
					now: T1,
				}),
			).toMatchObject({ ok: true, attempt: { ordinal: 1 } });
		} finally {
			store.close();
		}
	});

	it("releases an ambiguous cool fence only after an exact remote head invalidation probe", async () => {
		const { store, operation, claim } = await fixture();
		try {
			const prepared = store.prepareLandCoolAttempt({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				repoIdentity: "__main__",
				now: T1,
			});
			if (!prepared.ok) throw new Error(prepared.reason);
			store.releaseLandOperationWithRetryAccounting({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				class: "terminal",
				reason: "ambiguous_cool_effect",
				now: T1,
			});
			const successor = store.ensureLandOperation({
				issueId: "FLY-1833-next",
				projectName: "flywheel",
				prNumber: 1833,
				approvedHead: HEAD_B,
				now: T1,
			});
			const successorClaim = store.claimLandOperation({
				operationId: successor.operation_id,
				ownerId: "successor-worker",
				now: T1,
				leaseExpiresAt: "2026-08-17T21:01:00.000Z",
			});
			if (!successorClaim) throw new Error("successor claim missing");

			expect(
				store.adjudicateRemoteInvalidatedLandCoolAttempts({
					confirmingOperationId: successor.operation_id,
					ownerId: successorClaim.ownerId,
					generation: successorClaim.generation,
					repoIdentity: "__main__",
					observedPrNumber: 1833,
					observedHeadSha: HEAD_A,
					observedPrState: "OPEN",
					now: T1,
				}),
			).toEqual({
				ok: false,
				reason: "observed_head_not_confirming_operation",
			});
			expect(
				store.getOpenLandCoolAttempt(operation.operation_id),
			).toMatchObject({
				state: "prepared",
			});

			expect(
				store.adjudicateRemoteInvalidatedLandCoolAttempts({
					confirmingOperationId: successor.operation_id,
					ownerId: successorClaim.ownerId,
					generation: successorClaim.generation,
					repoIdentity: "__main__",
					observedPrNumber: 1833,
					observedHeadSha: HEAD_B,
					observedPrState: "OPEN",
					now: T1,
				}),
			).toEqual({ ok: true, idempotentReplay: false, voidedCount: 1 });
			expect(
				store.getOpenLandCoolAttempt(operation.operation_id),
			).toBeUndefined();
			expect(store.listLandCoolAttempts(operation.operation_id)).toContainEqual(
				expect.objectContaining({
					ordinal: prepared.attempt.ordinal,
					state: "voided",
					classification: "adjudicated:remote_head_invalidated",
				}),
			);
			expect(store.listLandCoolAdjudicationReceipts()).toEqual([
				expect.objectContaining({
					operation_id: operation.operation_id,
					ordinal: prepared.attempt.ordinal,
					basis: "remote_head_invalidated",
					confirming_operation_id: successor.operation_id,
				}),
			]);
			expect(
				store.prepareLandCoolAttempt({
					operationId: successor.operation_id,
					ownerId: successorClaim.ownerId,
					generation: successorClaim.generation,
					repoIdentity: "__main__",
					now: T1,
				}),
			).toMatchObject({ ok: true, attempt: { ordinal: 1 } });
		} finally {
			store.close();
		}
	});
});
