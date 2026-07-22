import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { describe, expect, it } from "vitest";
import { makeGateAuthorityView } from "../bridge/approval-signal/gate-authority-view.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../workflow-run-snapshot.js";

const HEAD = "a".repeat(40);

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
						model: "claude-opus-4-8",
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

describe("StateStore land lifecycle ledger", () => {
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
		store.createWorkflowRun({
			runId: "run-feedback",
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
			"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'qa' WHERE run_id = 'run-feedback'",
		);
		store.upsertWorkflowRunNode({
			runId: "run-feedback",
			nodeId: "qa",
			attempt: 1,
			state: "running",
			executionId: "qa-feedback",
		});
		store.commitWorkflowTransitionTx({
			runId: "run-feedback",
			nodeId: "qa",
			attempt: 1,
			executionId: "qa-feedback",
			outcome: "qa_pass",
			subjectDigest: HEAD,
			now: "2026-07-21T20:00:00.000Z",
		});
		const holder = store.getCurrentWorkflowGateHolder(
			"run-feedback",
			"founder_gate",
		)!;
		store.advanceWorkflowGateHolderMaterialization({
			questionId: holder.question_id,
			stage: "card_bound",
			cardMessageId: "card-feedback",
			now: "2026-07-21T20:01:00.000Z",
		});
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
			store.getWorkflowRunNode("run-feedback", "implement", 1),
		).toMatchObject({ state: "pending" });
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
