import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
import { HOLD_SHAPE_REGISTRY } from "../bridge/hold-shape-registry.js";
import { StateStore } from "../StateStore.js";
import { legacyGenericSeed } from "./fixtures/legacy-workflow-manifests.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const db of commDbs.splice(0)) db.close();
});

function decisionFor(
	shape: (typeof HOLD_SHAPE_REGISTRY)[number],
): string | undefined {
	const decision = shape.requiredDecision?.[0];
	return decision === "reroute_to"
		? "reroute_to replacement-execution"
		: decision;
}

function resumeHold(
	store: StateStore,
	input: {
		runId: string;
		shape: string;
		holdEventUid: string;
		decision?: string;
		reason: string;
		principal: "master";
		clientRequestId: string;
		now: string;
	},
) {
	const { now, ...candidate } = input;
	const normalized = StateStore.canonicalizeHoldResume({
		...candidate,
		decision: candidate.decision ?? null,
	});
	if (!normalized) throw new Error("invalid hold fixture");
	return store.resumeWorkflowHold({
		canonical: normalized.canonical,
		digest: normalized.digest,
		now,
	});
}

describe("FLY-2248 sanctioned workflow hold recovery", () => {
	for (const shape of HOLD_SHAPE_REGISTRY) {
		it(`${shape.id}: reports a stale run as non-resumable`, async () => {
			const store = await StateStore.create(":memory:");
			stores.push(store);
			const runId = `run-${shape.id}`;
			const holdEventUid = `hold:${shape.id}`;
			store.createWorkflowRun({
				runId,
				issueId: "FLY-2248",
				projectName: "flywheel",
				snapshotJson: "{}",
				claimsReadEnrolled: true,
			});
			store.appendWorkflowRunEvent({
				runId,
				eventUid: holdEventUid,
				kind: shape.positiveProbe.eventKind,
				payload: {
					reason: shape.positiveProbe.reason ?? shape.id,
					operationId: shape.positiveProbe.operationId ?? null,
					deliveryState: shape.positiveProbe.deliveryState ?? null,
				},
			});

			const hold = store
				.listWorkflowHolds(runId)
				.find((candidate) => candidate.holdEventUid === holdEventUid);
			expect(hold).toMatchObject({
				shape: shape.id,
				holdEventUid,
				resumable: false,
			});
			if (shape.scope === "run") {
				expect(hold?.preconditions).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "run_held", ok: false }),
					]),
				);
			} else {
				expect(hold?.preconditions.map(({ name }) => name)).not.toContain(
					"run_held",
				);
			}
			const input = {
				runId,
				shape: shape.id,
				holdEventUid,
				decision: decisionFor(shape),
				reason: "operator verified recovery preconditions",
				principal: "master" as const,
				clientRequestId: `resume:${shape.id}`,
				now: "2026-09-02T06:01:00.000Z",
			};
			expect(resumeHold(store, input)).toEqual({
				ok: false,
				reason: "hold_changed",
			});
			expect(
				store
					.listWorkflowRunEvents(runId)
					.some(
						(event) =>
							event.kind === "hold_resume_refused" &&
							event.payload.shape === shape.id,
					),
			).toBe(true);
		});
	}

	it("marks stale carrier, land, and gate objects non-resumable", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		for (const runId of [
			"run-stale-carrier",
			"run-stale-land",
			"run-stale-gate",
		]) {
			store.createWorkflowRun({
				runId,
				issueId: `FLY-${runId}`,
				projectName: "flywheel",
				snapshotJson: "{}",
				claimsReadEnrolled: true,
			});
			db.prepare(
				"UPDATE workflow_run SET status = 'held' WHERE run_id = ?",
			).run(runId);
		}

		db.prepare(
			`INSERT INTO workflow_gate_holder
			   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
			    question_id, state, materialization_stage, created_at, updated_at)
			 VALUES ('run-stale-carrier', 'release-gate', 1, ?, 'source-carrier',
			         'stale-carrier', 'awaiting_review', 'completed', ?, ?)`,
		).run(
			"b".repeat(40),
			"2026-09-02T07:00:00.000Z",
			"2026-09-02T07:00:00.000Z",
		);
		db.prepare(
			`INSERT INTO workflow_carrier_delivery
			   (question_id, run_id, gate_node_id, gate_attempt, approved_head,
			    source_execution_id, carrier_activation_id, state, created_at,
			    updated_at)
			 VALUES ('stale-carrier', 'run-stale-carrier', 'release-gate', 1, ?,
			         'source-carrier', 'activation-carrier', 'completed', ?, ?)`,
		).run(
			"b".repeat(40),
			"2026-09-02T07:00:00.000Z",
			"2026-09-02T07:01:00.000Z",
		);
		store.appendWorkflowRunEvent({
			runId: "run-stale-carrier",
			eventUid: "hold:stale-carrier",
			kind: "carrier_delivery_exhausted",
			payload: {
				questionId: "stale-carrier",
				deliveryState: "needs_lead",
				reason: "delivery_exhausted",
			},
		});

		const land = store.ensureLandOperation({
			runId: "run-stale-land",
			issueId: "FLY-run-stale-land",
			projectName: "flywheel",
			prNumber: 2248,
			approvedHead: "c".repeat(40),
			now: "2026-09-02T07:00:00.000Z",
		});
		db.prepare(
			"UPDATE land_operation SET state = 'completed' WHERE operation_id = ?",
		).run(land.operation_id);
		store.appendWorkflowRunEvent({
			runId: "run-stale-land",
			eventUid: "hold:stale-land",
			kind: "land_held",
			payload: { operationId: land.operation_id, reason: "retry_exhausted" },
		});

		db.prepare(
			`INSERT INTO workflow_gate_holder
			   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
			    question_id, state, materialization_stage, created_at, updated_at)
			 VALUES ('run-stale-gate', 'release-gate', 1, ?, 'source-gate',
			         'stale-gate', 'approved', 'completed', ?, ?)`,
		).run(
			"d".repeat(40),
			"2026-09-02T07:00:00.000Z",
			"2026-09-02T07:01:00.000Z",
		);
		store.appendWorkflowRunEvent({
			runId: "run-stale-gate",
			eventUid: "hold:stale-gate",
			kind: "workflow_gate_origin_preflight_terminal",
			payload: { questionId: "stale-gate", reason: "origin_terminal" },
		});

		for (const [runId, holdEventUid] of [
			["run-stale-carrier", "hold:stale-carrier"],
			["run-stale-land", "hold:stale-land"],
			["run-stale-gate", "hold:stale-gate"],
		] as const) {
			expect(
				store
					.listWorkflowHolds(runId)
					.find((hold) => hold.holdEventUid === holdEventUid),
			).toMatchObject({
				resumable: false,
				preconditions: expect.arrayContaining([
					expect.objectContaining({
						name: "authoritative_object_current",
						ok: false,
					}),
				]),
			});
		}
	});

	it("repairs the authoritative land operation before closing its hold", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-land-hold",
			issueId: "FLY-2248",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		const operation = store.ensureLandOperation({
			runId: "run-land-hold",
			issueId: "FLY-2248",
			projectName: "flywheel",
			prNumber: 2248,
			approvedHead: "a".repeat(40),
			now: "2026-09-02T06:00:00.000Z",
		});
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		raw.run(
			`UPDATE land_operation SET state = 'held', last_error = 'retry_exhausted:test'
			  WHERE operation_id = ?`,
			[operation.operation_id],
		);
		raw.run("UPDATE workflow_run SET status = 'held' WHERE run_id = ?", [
			"run-land-hold",
		]);
		store.appendWorkflowRunEvent({
			runId: "run-land-hold",
			eventUid: "hold:land-operation",
			kind: "land_held",
			payload: {
				operationId: operation.operation_id,
				reason: "retry_exhausted:test",
			},
		});

		expect(
			resumeHold(store, {
				runId: "run-land-hold",
				shape: "land_held_with_operation",
				holdEventUid: "hold:land-operation",
				reason: "operator verified land retry",
				principal: "master",
				clientRequestId: "resume:land-operation",
				now: "2026-09-02T06:01:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "projected" });
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			state: "partial",
			resume_generation: 1,
			next_attempt_at: "2026-09-02T06:01:00.000Z",
			owner_id: null,
			lease_expires_at: null,
		});
	});

	it("redrives a carrier needs_lead row before closing its hold", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-carrier-hold",
			issueId: "FLY-2248",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		raw.run(
			`INSERT INTO workflow_gate_holder
			   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
			    question_id, state, materialization_stage, created_at, updated_at)
			 VALUES (?, 'release_gate', 1, ?, 'source-exec', 'question-carrier-hold',
			         'awaiting_review', 'completed', ?, ?)`,
			[
				"run-carrier-hold",
				"b".repeat(40),
				"2026-09-02T06:00:00.000Z",
				"2026-09-02T06:00:00.000Z",
			],
		);
		raw.run(
			`INSERT INTO workflow_carrier_delivery
			   (question_id, run_id, gate_node_id, gate_attempt, approved_head,
			    source_execution_id, carrier_activation_id, state, hold_count,
			    last_error, created_at, updated_at)
			 VALUES ('question-carrier-hold', ?, 'release_gate', 1, ?,
			         'source-exec', 'carrier-activation', 'needs_lead', 5,
			         'delivery_exhausted', ?, ?)`,
			[
				"run-carrier-hold",
				"b".repeat(40),
				"2026-09-02T06:00:00.000Z",
				"2026-09-02T06:00:00.000Z",
			],
		);
		store.baselineWorkflowDeliveryContracts("2026-09-02T06:00:30.000Z");
		store.appendWorkflowRunEvent({
			runId: "run-carrier-hold",
			eventUid: "hold:carrier-needs-lead",
			kind: "carrier_delivery_exhausted",
			payload: {
				questionId: "question-carrier-hold",
				deliveryState: "needs_lead",
				reason: "delivery_exhausted",
			},
		});
		expect(store.getWorkflowRun("run-carrier-hold")?.status).toBe("active");
		expect(
			store
				.listWorkflowHolds("run-carrier-hold")
				.find(({ shape }) => shape === "carrier_needs_lead"),
		).toMatchObject({ resumable: true });

		expect(
			resumeHold(store, {
				runId: "run-carrier-hold",
				shape: "carrier_needs_lead",
				holdEventUid: "hold:carrier-needs-lead",
				reason: "operator verified carrier redrive",
				principal: "master",
				clientRequestId: "resume:carrier-needs-lead",
				now: "2026-09-02T06:01:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "projected" });
		expect(
			store.getWorkflowCarrierDelivery("question-carrier-hold"),
		).toMatchObject({
			state: "pending",
			hold_count: 0,
			last_error: "operator_resume:carrier_needs_lead",
			owner_id: null,
			lease_expires_at: null,
		});
		expect(store.getWorkflowRun("run-carrier-hold")?.status).toBe("active");
	});

	it("revives an inactive carrier row before closing its hold", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-carrier-inactive",
			issueId: "FLY-2248",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		db.prepare(
			`INSERT INTO workflow_gate_holder
			   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
			    question_id, state, materialization_stage, created_at, updated_at)
			 VALUES (?, 'release_gate', 1, ?, 'source-exec', 'question-carrier-inactive',
			         'awaiting_review', 'completed', ?, ?)`,
		).run(
			"run-carrier-inactive",
			"b".repeat(40),
			"2026-09-02T06:00:00.000Z",
			"2026-09-02T06:00:00.000Z",
		);
		db.prepare(
			`INSERT INTO workflow_carrier_delivery
			   (question_id, run_id, gate_node_id, gate_attempt, approved_head,
			    source_execution_id, carrier_activation_id, state, hold_count,
			    last_error, created_at, updated_at)
			 VALUES ('question-carrier-inactive', ?, 'release_gate', 1, ?,
			         'source-exec', 'carrier-activation', 'held', 1,
			         'run_inactive:held', ?, ?)`,
		).run(
			"run-carrier-inactive",
			"b".repeat(40),
			"2026-09-02T06:00:00.000Z",
			"2026-09-02T06:00:00.000Z",
		);
		db.prepare("UPDATE workflow_run SET status = 'held' WHERE run_id = ?").run(
			"run-carrier-inactive",
		);
		store.baselineWorkflowDeliveryContracts("2026-09-02T06:00:30.000Z");
		store.appendWorkflowRunEvent({
			runId: "run-carrier-inactive",
			eventUid: "hold:carrier-inactive",
			kind: "carrier_delivery_held",
			payload: {
				questionId: "question-carrier-inactive",
				reason: "run_inactive:held",
			},
		});
		store.appendWorkflowRunEvent({
			runId: "run-carrier-inactive",
			eventUid: "hold:carrier-base",
			kind: "run_held_by_operator",
			payload: { reason: "carrier source run is held" },
		});
		expect(
			store
				.listWorkflowHolds("run-carrier-inactive")
				.find(({ shape }) => shape === "carrier_run_inactive"),
		).toMatchObject({
			resumable: false,
			derivedFrom: "hold:carrier-base",
		});

		expect(
			resumeHold(store, {
				runId: "run-carrier-inactive",
				shape: "carrier_run_inactive",
				holdEventUid: "hold:carrier-inactive",
				reason: "operator reactivated the run",
				principal: "master",
				clientRequestId: "resume:carrier-inactive",
				now: "2026-09-02T06:01:00.000Z",
			}),
		).toEqual({ ok: false, reason: "hold_changed" });
		expect(
			resumeHold(store, {
				runId: "run-carrier-inactive",
				shape: "run_held_by_operator",
				holdEventUid: "hold:carrier-base",
				reason: "operator reactivated the run",
				principal: "master",
				clientRequestId: "resume:carrier-base",
				now: "2026-09-02T06:01:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "projected" });
		expect(
			store.getWorkflowCarrierDelivery("question-carrier-inactive"),
		).toMatchObject({
			state: "pending",
			hold_count: 1,
			last_error: "hold_resumed:run_held_by_operator",
		});
	});

	it("keeps a run held until its final independent run hold is resumed", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-two-holds",
			issueId: "FLY-2278",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		(
			store as unknown as { db: { run(sql: string, params?: unknown[]): void } }
		).db.run("UPDATE workflow_run SET status = 'held' WHERE run_id = ?", [
			"run-two-holds",
		]);
		for (const holdEventUid of ["hold:first", "hold:second"]) {
			store.appendWorkflowRunEvent({
				runId: "run-two-holds",
				eventUid: holdEventUid,
				kind: "run_held_by_operator",
				payload: { reason: holdEventUid },
			});
		}
		const resume = (holdEventUid: string) =>
			resumeHold(store, {
				runId: "run-two-holds",
				shape: "run_held_by_operator",
				holdEventUid,
				reason: "operator cleared one independent hold",
				principal: "master",
				clientRequestId: `resume:${holdEventUid}`,
				now: "2026-09-02T06:01:00.000Z",
			});
		expect(resume("hold:first")).toMatchObject({ ok: true });
		expect(store.getWorkflowRun("run-two-holds")?.status).toBe("held");
		expect(store.listWorkflowHolds("run-two-holds")).toHaveLength(1);
		expect(resume("hold:second")).toMatchObject({ ok: true });
		expect(store.getWorkflowRun("run-two-holds")?.status).toBe("active");
	});

	it("re-arms a terminal gate-origin probe before closing its hold", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-origin-hold",
			issueId: "FLY-2248",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		raw.run(
			`INSERT INTO workflow_gate_holder
			   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
			    question_id, state, materialization_stage, origin_probe_attempts,
			    origin_probe_last_reason, created_at, updated_at)
			 VALUES (?, 'release_gate', 1, ?, 'source-exec', 'question-origin-hold',
			         'materializing', 'question_intent', 7, 'origin_terminal', ?, ?)`,
			[
				"run-origin-hold",
				"c".repeat(40),
				"2026-09-02T06:00:00.000Z",
				"2026-09-02T06:00:00.000Z",
			],
		);
		raw.run("UPDATE workflow_run SET status = 'held' WHERE run_id = ?", [
			"run-origin-hold",
		]);
		store.appendWorkflowRunEvent({
			runId: "run-origin-hold",
			eventUid: "hold:origin-probe",
			kind: "workflow_gate_origin_preflight_terminal",
			payload: {
				questionId: "question-origin-hold",
				reason: "origin_terminal",
			},
		});

		expect(
			resumeHold(store, {
				runId: "run-origin-hold",
				shape: "workflow_gate_origin_preflight_terminal",
				holdEventUid: "hold:origin-probe",
				reason: "operator repaired the origin source",
				principal: "master",
				clientRequestId: "resume:origin-probe",
				now: "2026-09-02T06:01:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "projected" });
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId("question-origin-hold"),
		).toMatchObject({
			origin_probe_attempts: 0,
			origin_probe_next_at: "2026-09-02T06:01:00.000Z",
			origin_probe_last_reason: null,
			origin_probe_verified_at: null,
		});
	});

	it("requeues an unlaunched admission before closing its hold", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-unlaunched-hold",
			issueId: "FLY-2248",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		db.prepare(
			`INSERT INTO workflow_run_node
			   (run_id, node_id, attempt, state, execution_id, ended_at)
			 VALUES (?, ?, 1, 'failed', ?, ?)`,
		).run(
			"run-unlaunched-hold",
			"worker-node",
			"unlaunched-execution",
			"2026-09-02T06:00:00.000Z",
		);
		db.prepare(
			"UPDATE workflow_run SET status = 'held', current_node_id = ? WHERE run_id = ?",
		).run("worker-node", "run-unlaunched-hold");
		store.appendWorkflowRunEvent({
			runId: "run-unlaunched-hold",
			eventUid: "hold:unlaunched",
			kind: "unlaunched_admission_rolled_back",
			nodeId: "worker-node",
			executionId: "unlaunched-execution",
			payload: { attempt: 1, reason: "unlaunched_admission_rolled_back" },
		});

		expect(
			resumeHold(store, {
				runId: "run-unlaunched-hold",
				shape: "unlaunched_admission_rolled_back",
				holdEventUid: "hold:unlaunched",
				reason: "operator confirmed a clean redispatch",
				principal: "master",
				clientRequestId: "resume:unlaunched",
				now: "2026-09-02T06:01:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "projected" });
		expect(
			store.getWorkflowRunNode("run-unlaunched-hold", "worker-node", 1),
		).toMatchObject({ state: "pending", execution_id: null, ended_at: null });
	});

	it("reconstructs a completion receipt from the pinned activation and advances once", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const env = {
			FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
		};
		const seed = legacyGenericSeed();
		store.importWorkflowTemplateSeed(seed);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "generic",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		store.materializeWorkflowRun({
			runId: "run-completion-repair",
			issueId: "FLY-2248",
			projectName: "flywheel",
			taskCategory: "generic",
			claimsReadEnrolled: true,
			actor: "lead",
			canonicalRoot: REPO_ROOT,
			env,
			startReservation: {
				idempotencyKey: "start-completion-repair",
				selectionDigest: "selection-completion-repair",
				nodeId: "execute",
				attempt: 1,
				executionId: "completion-execution",
				createdAt: "2026-09-02T06:00:00.000Z",
			},
		});
		const admission = store.admitGeneralizedWorkflowExecution({
			runId: "run-completion-repair",
			nodeId: "execute",
			executionId: "completion-execution",
			attempt: 1,
			expiresAt: "2026-09-02T08:00:00.000Z",
			absoluteDeadlineAt: "2026-09-03T06:00:00.000Z",
			now: "2026-09-02T06:00:30.000Z",
			env,
		});
		if (!admission.ok) throw new Error(admission.reason);
		store.upsertWorkflowRunNode({
			runId: "run-completion-repair",
			nodeId: "execute",
			attempt: 1,
			state: "running",
			executionId: "completion-execution",
		});
		const completionDb = (
			store as unknown as { db: { raw: Database.Database } }
		).db.raw;
		completionDb
			.prepare(
				`INSERT INTO workflow_node_pr_binding
				   (run_id, node_id, attempt, pr_number, head_sha,
				    target_repo_identity, probe_repo_slug, target_repo_path,
				    worktree_binding_generation, receipt_id, bound_at)
				 VALUES (?, 'execute', 1, 2248, ?, '__main__', 'xrliAnnie/flywheel',
				         ?, 'generation-1', 'receipt-completion-repair', ?)`,
			)
			.run(
				"run-completion-repair",
				"e".repeat(40),
				REPO_ROOT,
				"2026-09-02T06:00:45.000Z",
			);
		store.upsertSession({
			execution_id: "completion-execution",
			issue_id: "FLY-2248",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "execute",
			pr_head_sha: "e".repeat(40),
		});
		(
			store as unknown as { db: { run(sql: string, params?: unknown[]): void } }
		).db.run("UPDATE sessions SET pr_head_sha = ? WHERE execution_id = ?", [
			"e".repeat(40),
			"completion-execution",
		]);
		const held = store.holdCompletedWorkflowExecutionWithoutReceipt({
			runId: "run-completion-repair",
			nodeId: "execute",
			attempt: 1,
			executionId: "completion-execution",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: "2026-09-02T06:01:00.000Z",
		});
		if (!held.ok) throw new Error(held.reason);

		expect(
			resumeHold(store, {
				runId: "run-completion-repair",
				shape: "completion_receipt_missing",
				holdEventUid:
					"completion_receipt_missing:run-completion-repair:execute:1:completion-execution",
				reason: "operator verified the terminal activation evidence",
				principal: "master",
				clientRequestId: "resume:completion-repair",
				now: "2026-09-02T06:02:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "projected" });
		expect(
			store.getWorkflowNodeCompletion("run-completion-repair", "execute", 1),
		).toMatchObject({
			execution_id: "completion-execution",
			route: "needs_review",
		});
		expect(
			store.getWorkflowRunNode("run-completion-repair", "founder_gate", 1),
		).toMatchObject({ state: "review" });
	});

	it("requeues the held node when an operator authorizes a retry", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-retry-hold",
			issueId: "FLY-2248",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		db.prepare(
			`INSERT INTO workflow_run_node
			   (run_id, node_id, attempt, state, execution_id)
			 VALUES (?, ?, 3, 'running', ?)`,
		).run("run-retry-hold", "worker-node", "failed-execution");
		db.prepare(
			"UPDATE workflow_run SET status = 'held', current_node_id = ? WHERE run_id = ?",
		).run("worker-node", "run-retry-hold");
		store.appendWorkflowRunEvent({
			runId: "run-retry-hold",
			eventUid: "hold:retry-limit",
			kind: "retry_limit_escalated",
			nodeId: "worker-node",
			executionId: "failed-execution",
			payload: { attempt: 3, reason: "retry_limit" },
		});

		expect(
			resumeHold(store, {
				runId: "run-retry-hold",
				shape: "retry_limit_escalated",
				holdEventUid: "hold:retry-limit",
				decision: "retry",
				reason: "operator authorized one more launch",
				principal: "master",
				clientRequestId: "resume:retry-limit",
				now: "2026-09-02T06:01:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "projected" });
		expect(
			store.getWorkflowRunNode("run-retry-hold", "worker-node", 3),
		).toMatchObject({ state: "pending", execution_id: null });
	});

	it("materializes the held loop target before closing the limit hold", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-loop-limit",
			issueId: "FLY-2248",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		db.prepare(
			`INSERT INTO workflow_run_node
			   (run_id, node_id, attempt, state, execution_id, ended_at)
			 VALUES (?, 'source-node', 2, 'done', 'source-execution', ?)`,
		).run("run-loop-limit", "2026-09-02T06:00:00.000Z");
		db.prepare(
			"UPDATE workflow_run SET status = 'held', current_node_id = 'source-node' WHERE run_id = ?",
		).run("run-loop-limit");
		store.appendWorkflowRunEvent({
			runId: "run-loop-limit",
			eventUid: "hold:loop-limit",
			kind: "loop_limit_escalated",
			nodeId: "source-node",
			executionId: "source-execution",
			payload: {
				targetNodeId: "target-node",
				targetAttempt: 4,
				loopIteration: 6,
				reason: "loop_limit",
			},
		});

		expect(
			resumeHold(store, {
				runId: "run-loop-limit",
				shape: "loop_limit_escalated",
				holdEventUid: "hold:loop-limit",
				reason: "operator authorized one more loop traversal",
				principal: "master",
				clientRequestId: "resume:loop-limit",
				now: "2026-09-02T06:01:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "projected" });
		expect(store.getWorkflowRun("run-loop-limit")).toMatchObject({
			status: "active",
			current_node_id: "target-node",
		});
		expect(
			store.getWorkflowRunNode("run-loop-limit", "target-node", 4),
		).toMatchObject({ state: "pending", execution_id: expect.any(String) });
	});

	it("materializes the suppressed target when an operator forces rework", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-idle-spin",
			issueId: "FLY-2248",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		db.prepare(
			"UPDATE workflow_run SET status = 'held', current_node_id = 'source-node' WHERE run_id = ?",
		).run("run-idle-spin");
		store.appendWorkflowRunEvent({
			runId: "run-idle-spin",
			eventUid: "hold:idle-spin",
			kind: "rework_suppressed_idle_spin",
			nodeId: "source-node",
			executionId: "source-execution",
			payload: {
				targetNodeId: "target-node",
				targetAttempt: 2,
				reason: "current_pass_exists",
			},
		});

		expect(
			resumeHold(store, {
				runId: "run-idle-spin",
				shape: "rework_suppressed_idle_spin",
				holdEventUid: "hold:idle-spin",
				decision: "force_rework",
				reason: "operator requires a fresh verification round",
				principal: "master",
				clientRequestId: "resume:idle-spin",
				now: "2026-09-02T06:01:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "projected" });
		expect(
			store.getWorkflowRunNode("run-idle-spin", "target-node", 2),
		).toMatchObject({ state: "pending", execution_id: expect.any(String) });
	});

	it("stages one operator-authorized reroute beyond the automatic cap", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-undeliverable",
			issueId: "FLY-2248",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		store.upsertSession({
			execution_id: "replacement-execution",
			issue_id: "FLY-2248",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker-node",
		});
		const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		const rootId = "flywheel:FLY-2248:mailbox:mail-root";
		const attemptId = `${rootId}:g3:a1`;
		db.prepare(
			`INSERT INTO workflow_delivery_attempt
			   (root_id, generation, attempt, attempt_id, family,
			    contract_ref_json, minted_at)
			 VALUES (?, 3, 1, ?, 'mailbox', ?, ?)`,
		).run(
			rootId,
			attemptId,
			JSON.stringify({ table: "mailbox", pk: "mail-root" }),
			"2026-09-02T06:00:00.000Z",
		);
		db.prepare(
			`INSERT INTO workflow_delivery_contract_episode
			   (episode_id, family, root_id, attempt_id, run_id, stage,
			    stage_entered_at, opened_at, escalation_uid)
			 VALUES ('episode-undeliverable', 'mailbox', ?, ?, ?, 'undeliverable',
			         ?, ?, 'delivery_contract_stalled:episode-undeliverable')`,
		).run(
			rootId,
			attemptId,
			"run-undeliverable",
			"2026-09-02T06:00:00.000Z",
			"2026-09-02T06:00:00.000Z",
		);
		db.prepare("UPDATE workflow_run SET status = 'held' WHERE run_id = ?").run(
			"run-undeliverable",
		);
		store.appendWorkflowRunEvent({
			runId: "run-undeliverable",
			eventUid: `delivery_reroute_operator_required:${attemptId}`,
			kind: "delivery_reroute_operator_required",
			payload: { rootId, attemptId, reason: "reroute_limit" },
		});

		expect(
			resumeHold(store, {
				runId: "run-undeliverable",
				shape: "delivery_undeliverable_no_recipient",
				holdEventUid: `delivery_reroute_operator_required:${attemptId}`,
				decision: "reroute_to replacement-execution",
				reason: "operator selected a verified live recipient",
				principal: "master",
				clientRequestId: "resume:undeliverable",
				now: "2026-09-02T06:01:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "staged" });
		expect(
			db
				.prepare(
					`SELECT kind, target_activation_id, state
					   FROM workflow_delivery_operation
					  WHERE kind = 'hold_resume' AND source_attempt_id = ?`,
				)
				.get(attemptId),
		).toEqual({
			kind: "hold_resume",
			target_activation_id: "replacement-execution",
			state: "staged",
		});
		expect(
			db
				.prepare(
					"SELECT parent_attempt_id FROM workflow_delivery_attempt WHERE root_id = ? AND generation = 4",
				)
				.get(rootId),
		).toBeUndefined();
	});

	it("replays both cross-store recovery barriers and projects their official receipts", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-cross-store-holds",
			issueId: "FLY-2248",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run("UPDATE workflow_run SET status = 'held' WHERE run_id = ?", [
			"run-cross-store-holds",
		]);
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"recipient",
			"window",
			"flywheel",
			"FLY-2248",
			"lead",
		);
		commDb.insertInstructionWithId(
			"mail-hold-source",
			"lead",
			"recipient",
			"Resume mailbox",
		);
		commDb.enqueueTurnWake({
			wakeId: "turn-hold-source",
			executionId: "recipient",
			issueId: "FLY-2248",
			epoch: 1,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "Resume turn" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-02T07:00:00.000Z"),
		});
		const rawComm = (commDb as unknown as { db: Database.Database }).db;
		rawComm
			.prepare(
				`UPDATE mailbox SET state = 'LEASED', batch_id = 'held-batch',
				   claimed_by = 'worker', claim_expires_at = ? WHERE id = ?`,
			)
			.run("2026-09-02T08:00:00.000Z", "mail-hold-source");
		rawComm
			.prepare(
				`UPDATE turn_wake_outbox SET state = 'sent', push_count = 2,
				   first_push_at = ?, last_push_at = ? WHERE wake_id = ?`,
			)
			.run(
				Date.parse("2026-09-02T07:01:00.000Z"),
				Date.parse("2026-09-02T07:02:00.000Z"),
				"turn-hold-source",
			);

		const inputs = [
			{
				shape: "mailbox_inflight_slots_exhausted",
				holdEventUid: "hold:mailbox",
				physicalId: "mail-hold-source",
			},
			{
				shape: "three_stage_turn_stuck",
				holdEventUid: "hold:turn",
				physicalId: "turn-hold-source",
			},
		] as const;
		const stagedOperationIds = new Map<string, string>();
		for (const input of inputs) {
			store.appendWorkflowRunEvent({
				runId: "run-cross-store-holds",
				eventUid: input.holdEventUid,
				kind: input.shape,
				payload: { reason: input.shape, physicalId: input.physicalId },
			});
			if (input.shape === "three_stage_turn_stuck") {
				expect(
					commDb.ackTurnWakes({
						executionId: "recipient",
						epoch: 1,
						ackedAtMs: Date.parse("2026-09-02T07:02:30.000Z"),
					}),
				).toBe(1);
				expect(
					store
						.listWorkflowHolds("run-cross-store-holds")
						.find(({ shape }) => shape === input.shape),
				).toMatchObject({ resumable: true });
			}
			const staged = resumeHold(store, {
				runId: "run-cross-store-holds",
				shape: input.shape,
				holdEventUid: input.holdEventUid,
				reason: "operator confirmed recovery",
				principal: "master",
				clientRequestId: `resume:${input.shape}:barrier`,
				now: "2026-09-02T07:03:00.000Z",
			});
			expect(staged).toMatchObject({ ok: true, state: "staged" });
			if (!staged.ok) throw new Error(staged.reason);
			stagedOperationIds.set(input.shape, staged.operationId);
			expect(
				resumeHold(store, {
					runId: "run-cross-store-holds",
					shape: input.shape,
					holdEventUid: input.holdEventUid,
					reason: "operator retried before projection",
					principal: "master",
					clientRequestId: `resume:${input.shape}:duplicate`,
					now: "2026-09-02T07:03:00.100Z",
				}),
			).toEqual({ ok: false, reason: "hold_resume_in_progress" });
		}

		// Window B crash replay: CommDB committed the physical recovery and its
		// deterministic receipt, but the StateStore operation is still staged.
		commDb.resumeMailboxInflightHold({
			sourceId: "mail-hold-source",
			receiptId: stagedOperationIds.get("mailbox_inflight_slots_exhausted")!,
			now: "2026-09-02T07:03:00.500Z",
		});
		expect(
			store.getWorkflowHoldResumeReceipt(
				"resume:mailbox_inflight_slots_exhausted:barrier",
			),
		).toMatchObject({ state: "staged" });

		const operations = new DeliveryOperations({
			store,
			commDb,
			resolveRecipient: () => null,
			resolveAlertIdentity: ({ projectName }) => ({
				leadId: "lead-flywheel",
				projectName,
				leadResolution: "resolved",
			}),
		});
		operations.runPass("2026-09-02T07:03:01.000Z");

		for (const input of inputs) {
			expect(
				store.getWorkflowHoldResumeReceipt(`resume:${input.shape}:barrier`),
			).toMatchObject({ state: "projected" });
		}
		expect(store.getWorkflowRun("run-cross-store-holds")?.status).toBe(
			"active",
		);
		expect(store.listWorkflowHolds("run-cross-store-holds")).toEqual([]);
		expect(
			rawComm
				.prepare("SELECT state, batch_id FROM mailbox WHERE id = ?")
				.get("mail-hold-source"),
		).toEqual({ state: "QUEUED", batch_id: null });
		expect(commDb.getTurnWake("turn-hold-source")).toMatchObject({
			state: "acked",
		});
	});

	it("fails a poisoned hold resume independently and continues later operations", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-poisoned-hold",
			issueId: "FLY-2278",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		const stateDb = (store as unknown as { db: { raw: Database.Database } }).db
			.raw;
		stateDb
			.prepare("UPDATE workflow_run SET status = 'held' WHERE run_id = ?")
			.run("run-poisoned-hold");
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"poisoned-recipient",
			"window",
			"flywheel",
			"FLY-2278",
			"lead",
		);
		commDb.insertInstructionWithId(
			"mail-poisoned",
			"lead",
			"poisoned-recipient",
			"Resume mailbox",
		);
		commDb.enqueueTurnWake({
			wakeId: "turn-after-poison",
			executionId: "poisoned-recipient",
			issueId: "FLY-2278",
			epoch: 1,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "Resume turn" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-03T07:00:00.000Z"),
		});
		const commRaw = (commDb as unknown as { db: Database.Database }).db;
		commRaw
			.prepare(
				`UPDATE mailbox SET state = 'LEASED', batch_id = 'held-batch',
				   claimed_by = 'worker', claim_expires_at = ? WHERE id = ?`,
			)
			.run("2026-09-03T08:00:00.000Z", "mail-poisoned");
		commRaw
			.prepare(
				`UPDATE turn_wake_outbox SET state = 'sent', push_count = 2,
				   first_push_at = ?, last_push_at = ? WHERE wake_id = ?`,
			)
			.run(
				Date.parse("2026-09-03T07:01:00.000Z"),
				Date.parse("2026-09-03T07:02:00.000Z"),
				"turn-after-poison",
			);
		for (const input of [
			{
				shape: "mailbox_inflight_slots_exhausted",
				holdEventUid: "hold:mailbox-poisoned",
				physicalId: "mail-poisoned",
			},
			{
				shape: "three_stage_turn_stuck",
				holdEventUid: "hold:turn-after-poison",
				physicalId: "turn-after-poison",
			},
		] as const) {
			store.appendWorkflowRunEvent({
				runId: "run-poisoned-hold",
				eventUid: input.holdEventUid,
				kind: input.shape,
				payload: { reason: input.shape, physicalId: input.physicalId },
			});
		}
		const poisoned = resumeHold(store, {
			runId: "run-poisoned-hold",
			shape: "mailbox_inflight_slots_exhausted",
			holdEventUid: "hold:mailbox-poisoned",
			reason: "operator confirmed mailbox recovery",
			principal: "master",
			clientRequestId: "resume:mailbox-poisoned",
			now: "2026-09-03T07:03:00.000Z",
		});
		const later = resumeHold(store, {
			runId: "run-poisoned-hold",
			shape: "three_stage_turn_stuck",
			holdEventUid: "hold:turn-after-poison",
			reason: "operator confirmed TURN recovery",
			principal: "master",
			clientRequestId: "resume:turn-after-poison",
			now: "2026-09-03T07:03:01.000Z",
		});
		if (!poisoned.ok || !later.ok) throw new Error("failed to stage fixtures");
		commRaw
			.prepare(
				`INSERT INTO mailbox_log
				   (event_id, schema_version, message_id, subject_id, event, at,
				    source_table, row_json)
				 VALUES (?, 1, ?, ?, 'progress', ?, 'mailbox', ?)`,
			)
			.run(
				poisoned.operationId,
				"mail-poisoned",
				"poisoned-recipient",
				"2026-09-03T07:03:01.500Z",
				JSON.stringify({ sourceId: "different-source", requeued: 0 }),
			);

		const operations = new DeliveryOperations({
			store,
			commDb,
			resolveRecipient: () => null,
			resolveAlertIdentity: ({ projectName }) => ({
				leadId: "lead-flywheel",
				projectName,
				leadResolution: "resolved",
			}),
		});
		expect(() => operations.runPass("2026-09-03T07:03:02.000Z")).not.toThrow();
		expect(
			store.getWorkflowHoldResumeReceipt("resume:mailbox-poisoned"),
		).toMatchObject({ state: "failed" });
		expect(
			store.getWorkflowHoldResumeReceipt("resume:turn-after-poison"),
		).toMatchObject({ state: "projected" });
		expect(store.getWorkflowRun("run-poisoned-hold")?.status).toBe("held");
		expect(
			resumeHold(store, {
				runId: "run-poisoned-hold",
				shape: "mailbox_inflight_slots_exhausted",
				holdEventUid: "hold:mailbox-poisoned",
				reason: "operator retries after repairing the receipt",
				principal: "master",
				clientRequestId: "resume:mailbox-poisoned:retry",
				now: "2026-09-03T07:03:03.000Z",
			}),
		).toMatchObject({ ok: true, state: "staged" });
	});
});
