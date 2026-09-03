import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];
const observedAt = "2026-09-03T22:00:00.000Z";
const alertIdentity = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved" as const,
};

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const commDb of commDbs.splice(0)) commDb.close();
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function rawCommDb(commDb: CommDB): Database.Database {
	return (commDb as unknown as { db: Database.Database }).db;
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

function openOperatorDoor(input: {
	store: StateStore;
	runId: string;
	executionId: string;
}) {
	const episode = input.store.listOpenUndeliverableDeliveryEpisodes()[0]!;
	input.store.recordWorkflowDeliveryRerouteOperatorRequired({
		episodeId: episode.episode_id,
		now: observedAt,
		reason: "delivery_reroute_limit_exhausted",
		runHeld: false,
		recipientExecutionId: input.executionId,
		commEvidence: {
			recentOutboundInWindow: false,
			observedAtMs: Date.parse(observedAt),
		},
		alertIdentity,
	});
	const hold = input.store
		.listWorkflowHolds(input.runId)
		.find(({ shape }) => shape === "delivery_undeliverable_no_recipient")!;
	return { episode, hold };
}

async function commFixture(family: "mailbox" | "turn_wake" | "phase_wake") {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const commDb = new CommDB(":memory:");
	commDbs.push(commDb);
	const runId = `run-cancel-${family}`;
	const executionId = `source-cancel-${family}`;
	const physicalId = `physical-cancel-${family}`;
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2278",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-2278",
		project_name: "flywheel",
		status: "completed",
		heartbeat_at: "2026-09-03T20:00:00.000Z",
		workflow_node_id: "worker",
	});
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "worker",
		attempt: 1,
		state: "completed",
		executionId,
	});
	commDb.registerSession(
		executionId,
		`window-${family}`,
		"flywheel",
		"FLY-2278",
		"flywheel-eng-lead",
	);
	if (family === "mailbox") {
		commDb.insertInstructionWithId(
			physicalId,
			"flywheel-eng-lead",
			executionId,
			"complete the bounded task",
		);
	} else if (family === "turn_wake") {
		commDb.enqueueTurnWake({
			wakeId: physicalId,
			executionId,
			issueId: "FLY-2278",
			epoch: 1,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "continue" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-03T20:30:00.000Z"),
		});
	} else {
		commDb.enqueueRunnerPhaseWake(
			executionId,
			{ id: physicalId, to: executionId, content: "continue", metadata: {} },
			Date.parse("2026-09-03T20:30:00.000Z"),
		);
	}
	commDb.markSessionTerminalStatus(executionId, "completed");
	new DeliveryProjector({ store, commDb, projectName: "flywheel" }).runPass(
		"2026-09-03T21:00:00.000Z",
	);
	new DeliveryContractWatch({
		store,
		commDb,
		projectName: "flywheel",
		resolveAlertIdentity: () => alertIdentity,
	}).runPass("2026-09-03T21:01:00.000Z");
	const { episode, hold } = openOperatorDoor({ store, runId, executionId });
	return { store, commDb, runId, executionId, physicalId, episode, hold };
}

async function stateFixture(family: "rework" | "carrier") {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const db = rawDb(store);
	const runId = `run-cancel-${family}`;
	const executionId = `source-cancel-${family}`;
	const physicalId = `physical-cancel-${family}`;
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2278",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-2278",
		project_name: "flywheel",
		status: "completed",
		heartbeat_at: "2026-09-03T20:00:00.000Z",
		workflow_node_id: "worker",
	});
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "worker",
		attempt: 1,
		state: "completed",
		executionId,
	});
	db.prepare(
		`INSERT INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-2278', 'worker', ?)`,
	).run(executionId, "2026-09-03T20:00:00.000Z");
	if (family === "rework") {
		db.prepare(
			`INSERT INTO workflow_rework_request
			   (request_id, run_id, source_event_id, authority, source_node_id,
			    source_attempt, base_revision, authority_context_json,
			    authority_context_digest, requested_at)
			 VALUES (?, ?, 'event-cancel', 'engine', 'worker', 1, ?, '{}', 'digest', ?)`,
		).run(physicalId, runId, "a".repeat(40), "2026-09-03T20:00:00.000Z");
		db.prepare(
			`INSERT INTO workflow_rework_route_revision
			   (request_id, revision, target_node_id, target_attempt,
			    preferred_actor_execution_id, invalidation_scope_json,
			    verification_policy_json, interpreted_by, interpretation_reason,
			    created_at)
			 VALUES (?, 1, 'worker', 1, ?, '[]', '{}', 'test', 'initial', ?)`,
		).run(physicalId, executionId, "2026-09-03T20:00:00.000Z");
		db.prepare(
			`INSERT INTO workflow_rework_delivery
			   (request_id, route_revision, state, updated_at)
			 VALUES (?, 1, 'awaiting_receipt', ?)`,
		).run(physicalId, "2026-09-03T20:00:00.000Z");
	} else {
		db.prepare(
			`INSERT INTO workflow_gate_holder
			   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
			    question_id, state, materialization_stage, created_at, updated_at)
			 VALUES (?, 'worker', 1, ?, ?, ?, 'awaiting_review', 'completed', ?, ?)`,
		).run(
			runId,
			"b".repeat(40),
			executionId,
			physicalId,
			"2026-09-03T20:00:00.000Z",
			"2026-09-03T20:00:00.000Z",
		);
		db.prepare(
			`INSERT INTO workflow_carrier_delivery
			   (question_id, run_id, gate_node_id, gate_attempt, approved_head,
			    source_execution_id, carrier_activation_id, state, created_at, updated_at)
			 VALUES (?, ?, 'worker', 1, ?, ?, 'activation-cancel',
			         'awaiting_receipt', ?, ?)`,
		).run(
			physicalId,
			runId,
			"b".repeat(40),
			executionId,
			"2026-09-03T20:00:00.000Z",
			"2026-09-03T20:00:00.000Z",
		);
	}
	expect(
		store.baselineWorkflowDeliveryContracts("2026-09-03T21:00:00.000Z").minted,
	).toBe(1);
	const attempt = store
		.listLiveWorkflowDeliveryAttempts()
		.find((candidate) => candidate.family === family)!;
	store.observeWorkflowDeliveryContract({
		attempt,
		classification: {
			stage: "minted",
			stageEnteredAt: attempt.minted_at,
			terminal: "undeliverable",
			overdue: false,
			severe: false,
		},
		runId,
		projectName: "flywheel",
		issueId: "FLY-2278",
		now: "2026-09-03T21:01:00.000Z",
		alertIdentity,
	});
	const { episode, hold } = openOperatorDoor({ store, runId, executionId });
	return { store, runId, physicalId, attempt, episode, hold };
}

describe("FLY-2278 canonical undeliverable cancel", () => {
	it.each(["rework", "carrier"] as const)(
		"terminalizes and settles %s atomically through the state-native door",
		async (family) => {
			const fixture = await stateFixture(family);
			expect(
				resumeHold(fixture.store, {
					runId: fixture.runId,
					shape: "delivery_undeliverable_no_recipient",
					holdEventUid: fixture.hold.holdEventUid,
					decision: "cancel",
					reason: "operator cancelled the orphaned handoff",
					principal: "master",
					clientRequestId: `resume:cancel:${family}`,
					now: "2026-09-03T22:01:00.000Z",
				}),
			).toMatchObject({ ok: true, state: "projected" });
			const db = rawDb(fixture.store);
			const table =
				family === "rework"
					? "workflow_rework_delivery"
					: "workflow_carrier_delivery";
			const key = family === "rework" ? "request_id" : "question_id";
			expect(
				db
					.prepare(`SELECT state, last_error FROM ${table} WHERE ${key} = ?`)
					.get(fixture.physicalId),
			).toEqual({ state: "completed", last_error: "cancelled_by_operator" });
			expect(
				db
					.prepare(
						"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
					)
					.get(fixture.attempt.attempt_id),
			).toEqual({ settlement_reason: "cancelled_by_operator" });
			expect(
				db
					.prepare(
						"SELECT closed_reason FROM workflow_delivery_contract_episode WHERE episode_id = ?",
					)
					.get(fixture.episode.episode_id),
			).toEqual({
				closed_reason: "terminal:settled:cancelled_by_operator",
			});
		},
	);

	it("rolls back the state-native physical cancellation when attempt settlement fails", async () => {
		const fixture = await stateFixture("rework");
		const db = rawDb(fixture.store);
		db.exec(
			`CREATE TEMP TRIGGER fly2278_cancel_settlement_fail
			 BEFORE UPDATE OF settlement_reason ON workflow_delivery_attempt
			 BEGIN SELECT RAISE(ABORT, 'injected cancel settlement failure'); END`,
		);

		expect(() =>
			resumeHold(fixture.store, {
				runId: fixture.runId,
				shape: "delivery_undeliverable_no_recipient",
				holdEventUid: fixture.hold.holdEventUid,
				decision: "cancel",
				reason: "operator cancelled the orphaned handoff",
				principal: "master",
				clientRequestId: "resume:cancel:rollback",
				now: "2026-09-03T22:01:00.000Z",
			}),
		).toThrow("injected cancel settlement failure");
		expect(
			db
				.prepare(
					"SELECT state, last_error FROM workflow_rework_delivery WHERE request_id = ?",
				)
				.get(fixture.physicalId),
		).toEqual({ state: "awaiting_receipt", last_error: null });
		expect(
			db
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(fixture.attempt.attempt_id),
		).toEqual({ settlement_reason: null });
		expect(
			db
				.prepare(
					"SELECT closed_at, closed_reason FROM workflow_delivery_contract_episode WHERE episode_id = ?",
				)
				.get(fixture.episode.episode_id),
		).toEqual({ closed_at: null, closed_reason: null });
		expect(
			db
				.prepare(
					"SELECT operation_id FROM workflow_delivery_operation WHERE client_request_id = ?",
				)
				.get("resume:cancel:rollback"),
		).toBeUndefined();
	});

	it.each(["mailbox", "turn_wake"] as const)(
		"replays the %s cross-store cancel before projecting the official receipt",
		async (family) => {
			const fixture = await commFixture(family);
			const staged = resumeHold(fixture.store, {
				runId: fixture.runId,
				shape: "delivery_undeliverable_no_recipient",
				holdEventUid: fixture.hold.holdEventUid,
				decision: "cancel",
				reason: "operator cancelled the orphaned handoff",
				principal: "master",
				clientRequestId: `resume:cancel:${family}`,
				now: "2026-09-03T22:01:00.000Z",
			});
			expect(staged).toMatchObject({ ok: true, state: "staged" });
			if (!staged.ok) throw new Error(staged.reason);
			const stateDb = rawDb(fixture.store);
			expect(
				stateDb
					.prepare(
						"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
					)
					.get(fixture.episode.attempt_id),
			).toEqual({ settlement_reason: null });
			if (family === "mailbox") {
				expect(
					fixture.commDb.cancelMailboxDelivery({
						sourceId: fixture.physicalId,
						operationId: staged.operationId,
						now: "2026-09-03T22:01:30.000Z",
					}),
				).toMatchObject({ ok: true, idempotentReplay: false });
				expect(
					fixture.store.getWorkflowHoldResumeReceipt(`resume:cancel:${family}`),
				).toMatchObject({ state: "staged" });
				expect(
					stateDb
						.prepare(
							"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
						)
						.get(fixture.episode.attempt_id),
				).toEqual({ settlement_reason: null });
			}
			const operations = new DeliveryOperations({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				resolveRecipient: () => null,
				resolveAlertIdentity: () => alertIdentity,
			});
			operations.runPass("2026-09-03T22:02:00.000Z");
			if (family === "mailbox") {
				expect(
					rawCommDb(fixture.commDb)
						.prepare("SELECT state, dead_reason FROM mailbox WHERE id = ?")
						.get(fixture.physicalId),
				).toEqual({
					state: "DEAD",
					dead_reason: `cancelled_by_operator:${staged.operationId}`,
				});
			} else {
				expect(fixture.commDb.getTurnWake(fixture.physicalId)).toMatchObject({
					state: "cancelled",
					cancel_reason: `cancelled_by_operator:${staged.operationId}`,
				});
			}
			expect(
				rawDb(fixture.store)
					.prepare(
						"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
					)
					.get(fixture.episode.attempt_id),
			).toEqual({ settlement_reason: "cancelled_by_operator" });
			expect(
				fixture.store.getWorkflowHoldResumeReceipt(`resume:cancel:${family}`),
			).toMatchObject({ state: "projected" });
		},
	);

	it("does not offer or accept cancel for a phase wake", async () => {
		const fixture = await commFixture("phase_wake");
		expect(fixture.hold.requiredDecision).toEqual(["reroute_to"]);
		expect(
			resumeHold(fixture.store, {
				runId: fixture.runId,
				shape: "delivery_undeliverable_no_recipient",
				holdEventUid: fixture.hold.holdEventUid,
				decision: "cancel",
				reason: "operator requested cancellation",
				principal: "master",
				clientRequestId: "resume:cancel:phase",
				now: "2026-09-03T22:01:00.000Z",
			}),
		).toEqual({ ok: false, reason: "cancel_not_supported_for_phase_wake" });
	});
});
