import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
import { StateStore } from "../StateStore.js";

/**
 * FLY-2921 through the real delivery-operations pass.
 *
 * C2 (Lead re-delivery resets the same wake): a live patrol push claim makes
 * `resumeTurnWakeHold` return `busy`; the pass must keep the operation
 * `staged` with zero applied/projected, and the next pass after the claim is
 * released or expired must reset exactly once and settle applied+projected.
 *
 * C4.6 (a staged cancel never stays staged): a legacy turn_wake undeliverable
 * hold whose source was already cancelled by the turn-wake patrol's terminal
 * guard lands applied (idempotent) within one pass; every other non-ok cancel
 * branch is marked failed with a precise reason instead of a silent `continue`.
 */

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

function operations(store: StateStore, commDb: CommDB): DeliveryOperations {
	return new DeliveryOperations({
		store,
		commDb,
		projectName: "flywheel",
		resolveRecipient: () => null,
		resolveAlertIdentity: () => alertIdentity,
	});
}

function operationRow(store: StateStore, operationId: string) {
	return rawDb(store)
		.prepare(
			"SELECT state, last_error FROM workflow_delivery_operation WHERE operation_id = ?",
		)
		.get(operationId) as { state: string; last_error: string | null };
}

function countEvents(store: StateStore, runId: string, kind: string): number {
	return (
		rawDb(store)
			.prepare(
				"SELECT COUNT(*) AS count FROM workflow_run_event WHERE run_id = ? AND kind = ?",
			)
			.get(runId, kind) as { count: number }
	).count;
}

function failureReason(store: StateStore, runId: string): string | undefined {
	const row = rawDb(store)
		.prepare(
			"SELECT payload FROM workflow_run_event WHERE run_id = ? AND kind = 'hold_resume_failed'",
		)
		.get(runId) as { payload: string } | undefined;
	return row
		? (JSON.parse(row.payload) as { reason: string }).reason
		: undefined;
}

// ---------------------------------------------------------------------------
// C2: three_stage_turn_stuck resume against a live push claim
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-09-26T10:00:00.000Z");
const LEASE_MS = 30_000;
const iso = (ms: number): string => new Date(ms).toISOString();

async function turnStuckFixture() {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const commDb = new CommDB(":memory:");
	commDbs.push(commDb);
	const runId = "run-2921-turn-stuck";
	const recipient = "recipient-2921";
	const wakeId = "turn-2921-stuck";
	const holdEventUid = "hold:turn-2921";
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2921",
		projectName: "flywheel",
		snapshotJson: "{}",
		claimsReadEnrolled: true,
	});
	rawDb(store)
		.prepare("UPDATE workflow_run SET status = 'held' WHERE run_id = ?")
		.run(runId);
	commDb.registerSession(recipient, "window", "flywheel", "FLY-2921", "lead");
	commDb.enqueueTurnWake({
		wakeId,
		executionId: recipient,
		issueId: "FLY-2921",
		epoch: 1,
		purpose: "workflow_rework",
		envelope: { fromAgent: "bridge", content: "rework content" },
		backend: "codex",
		createdAtMs: T0 - 120_000,
	});
	// One push already failed; the row is claimable again by the patrol.
	rawCommDb(commDb)
		.prepare(
			`UPDATE turn_wake_outbox
			    SET state = 'sent', push_count = 1, first_push_at = ?, last_push_at = ?,
			        last_push_result = 'error:wake_failed'
			  WHERE wake_id = ?`,
		)
		.run(T0 - 90_000, T0 - 90_000, wakeId);
	const claim = commDb.claimTurnWakeById({
		wakeId,
		nowMs: T0,
		retryAfterMs: 0,
		leaseMs: LEASE_MS,
	});
	if (!claim?.claim_token) throw new Error("patrol claim fixture failed");
	store.appendWorkflowRunEvent({
		runId,
		eventUid: holdEventUid,
		kind: "three_stage_turn_stuck",
		payload: { reason: "three_stage_turn_stuck", physicalId: wakeId },
	});
	const staged = resumeHold(store, {
		runId,
		shape: "three_stage_turn_stuck",
		holdEventUid,
		reason: "Lead re-delivers the rework",
		principal: "master",
		clientRequestId: "resume:2921:turn",
		now: iso(T0 + 1_000),
	});
	expect(staged).toMatchObject({ ok: true, state: "staged" });
	if (!staged.ok) throw new Error(staged.reason);
	return {
		store,
		commDb,
		runId,
		wakeId,
		holdEventUid,
		claimToken: claim.claim_token,
		claimExpiresAt: T0 + LEASE_MS,
		operationId: staged.operationId,
	};
}

describe("FLY-2921 C2: delivery-operations pass keeps a busy turn-wake resume staged", () => {
	it.each([
		{ how: "released", secondPassAt: T0 + 10_000 },
		{ how: "expired", secondPassAt: T0 + LEASE_MS + 1_000 },
	])(
		"busy → still staged, zero applied/projected; claim $how → next pass resets once and lands applied+projected",
		async ({ how, secondPassAt }) => {
			const fx = await turnStuckFixture();
			const resume = vi.spyOn(fx.commDb, "resumeTurnWakeHold");
			const wakeBefore = fx.commDb.getTurnWake(fx.wakeId);
			expect(wakeBefore).toMatchObject({
				state: "sent",
				push_count: 1,
				claim_token: fx.claimToken,
				claim_expires_at: fx.claimExpiresAt,
				cancel_reason: null,
			});

			// Pass 1: the patrol still owns the push claim.
			operations(fx.store, fx.commDb).runPass(iso(T0 + 5_000));
			expect(resume).toHaveBeenCalledTimes(1);
			expect(resume.mock.results[0]!.value).toEqual({
				kind: "busy",
				claimExpiresAt: fx.claimExpiresAt,
			});
			expect(operationRow(fx.store, fx.operationId)).toEqual({
				state: "staged",
				last_error: null,
			});
			expect(
				fx.store.getWorkflowHoldResumeReceipt("resume:2921:turn"),
			).toMatchObject({ state: "staged" });
			expect(countEvents(fx.store, fx.runId, "hold_resumed")).toBe(0);
			expect(countEvents(fx.store, fx.runId, "hold_resume_failed")).toBe(0);
			expect(
				fx.store
					.listWorkflowHolds(fx.runId)
					.some((hold) => hold.holdEventUid === fx.holdEventUid),
			).toBe(true);
			expect(fx.store.getWorkflowRun(fx.runId)?.status).toBe("held");
			// The live claim and the row's push bookkeeping are untouched.
			expect(fx.commDb.getTurnWake(fx.wakeId)).toEqual(wakeBefore);

			if (how === "released") {
				expect(fx.commDb.releaseTurnWakeClaim(fx.wakeId, fx.claimToken)).toBe(
					true,
				);
			}

			// Pass 2: claim gone (released or expired) → the reset actually runs.
			operations(fx.store, fx.commDb).runPass(iso(secondPassAt));
			expect(resume).toHaveBeenCalledTimes(2);
			expect(resume.mock.results[1]!.value).toEqual({ kind: "reset" });
			expect(fx.commDb.getTurnWake(fx.wakeId)).toMatchObject({
				state: "pending",
				push_count: 0,
				first_push_at: null,
				last_push_at: null,
				last_push_result: null,
				claim_token: null,
				claim_expires_at: null,
				cancel_reason: fx.operationId,
			});
			expect(operationRow(fx.store, fx.operationId)).toEqual({
				state: "projected",
				last_error: null,
			});
			expect(
				fx.store.getWorkflowHoldResumeReceipt("resume:2921:turn"),
			).toMatchObject({ state: "projected" });
			expect(countEvents(fx.store, fx.runId, "hold_resumed")).toBe(1);
			expect(fx.store.listWorkflowHolds(fx.runId)).toEqual([]);
			expect(fx.store.getWorkflowRun(fx.runId)?.status).toBe("active");

			// Pass 3: nothing left to do; the wake is not reset a second time.
			operations(fx.store, fx.commDb).runPass(iso(secondPassAt + 5_000));
			expect(resume).toHaveBeenCalledTimes(2);
			expect(fx.commDb.getTurnWake(fx.wakeId)).toMatchObject({
				state: "pending",
				push_count: 0,
				cancel_reason: fx.operationId,
			});
		},
	);
});

// ---------------------------------------------------------------------------
// C4.6: staged cancels never stay staged
// ---------------------------------------------------------------------------

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

async function commFixture(family: "mailbox" | "turn_wake") {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const commDb = new CommDB(":memory:");
	commDbs.push(commDb);
	const runId = `run-2921-cancel-${family}`;
	const executionId = `source-2921-${family}`;
	const physicalId = `physical-2921-${family}`;
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2921",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-2921",
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
		"FLY-2921",
		"flywheel-eng-lead",
	);
	if (family === "mailbox") {
		commDb.insertInstructionWithId(
			physicalId,
			"flywheel-eng-lead",
			executionId,
			"complete the bounded task",
		);
	} else {
		commDb.enqueueTurnWake({
			wakeId: physicalId,
			executionId,
			issueId: "FLY-2921",
			epoch: 1,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "continue" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-03T20:30:00.000Z"),
		});
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
	const staged = resumeHold(store, {
		runId,
		shape: "delivery_undeliverable_no_recipient",
		holdEventUid: hold.holdEventUid,
		decision: "cancel",
		reason: "operator cancelled the orphaned handoff",
		principal: "master",
		clientRequestId: `resume:2921:cancel:${family}`,
		now: "2026-09-03T22:01:00.000Z",
	});
	expect(staged).toMatchObject({ ok: true, state: "staged" });
	if (!staged.ok) throw new Error(staged.reason);
	return {
		store,
		commDb,
		runId,
		executionId,
		physicalId,
		episode,
		hold,
		operationId: staged.operationId,
		clientRequestId: `resume:2921:cancel:${family}`,
	};
}

describe("FLY-2921 C4.6: a staged cancel never stays staged", () => {
	it("lands a legacy turn_wake cancel whose source the terminal guard already cancelled as applied in one pass", async () => {
		const fx = await commFixture("turn_wake");
		expect(
			fx.commDb.cancelTurnWake(fx.physicalId, "terminal_guard:target_terminal"),
		).toBe(true);
		const wakeBefore = fx.commDb.getTurnWake(fx.physicalId);

		operations(fx.store, fx.commDb).runPass("2026-09-03T22:02:00.000Z");

		expect(operationRow(fx.store, fx.operationId)).toEqual({
			state: "projected",
			last_error: null,
		});
		expect(
			fx.store.getWorkflowHoldResumeReceipt(fx.clientRequestId),
		).toMatchObject({ state: "projected" });
		expect(
			rawDb(fx.store)
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(fx.episode.attempt_id),
		).toEqual({ settlement_reason: "cancelled_by_operator" });
		expect(countEvents(fx.store, fx.runId, "hold_resumed")).toBe(1);
		expect(countEvents(fx.store, fx.runId, "hold_resume_failed")).toBe(0);
		// The guard's cancellation stays the durable reason; nothing rewrote it.
		expect(fx.commDb.getTurnWake(fx.physicalId)).toEqual(wakeBefore);
		expect(wakeBefore).toMatchObject({
			state: "cancelled",
			cancel_reason: "terminal_guard:target_terminal",
		});
	});

	it("marks a comm-rejected turn_wake cancel failed with the comm reason instead of leaving it staged", async () => {
		const fx = await commFixture("turn_wake");
		expect(fx.commDb.cancelTurnWake(fx.physicalId, "rerouted:attempt-x")).toBe(
			true,
		);

		operations(fx.store, fx.commDb).runPass("2026-09-03T22:02:00.000Z");

		expect(operationRow(fx.store, fx.operationId)).toEqual({
			state: "failed",
			last_error: "delivery_cancel_rejected:turn_wake_source_changed",
		});
		expect(failureReason(fx.store, fx.runId)).toBe(
			"delivery_cancel_rejected:turn_wake_source_changed",
		);
		expect(countEvents(fx.store, fx.runId, "hold_resumed")).toBe(0);
		expect(
			rawDb(fx.store)
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(fx.episode.attempt_id),
		).toEqual({ settlement_reason: null });
		// The hold stays open for a fresh operator decision.
		expect(
			fx.store
				.listWorkflowHolds(fx.runId)
				.some((hold) => hold.holdEventUid === fx.hold.holdEventUid),
		).toBe(true);
	});

	it("marks a cancel for a family without a cancel implementation failed with a precise reason", async () => {
		const fx = await commFixture("mailbox");
		rawDb(fx.store)
			.prepare(
				"UPDATE workflow_delivery_operation SET family = 'carrier' WHERE operation_id = ?",
			)
			.run(fx.operationId);

		operations(fx.store, fx.commDb).runPass("2026-09-03T22:02:00.000Z");

		expect(operationRow(fx.store, fx.operationId)).toEqual({
			state: "failed",
			last_error: "delivery_cancel_unsupported_for_family:carrier",
		});
		expect(failureReason(fx.store, fx.runId)).toBe(
			"delivery_cancel_unsupported_for_family:carrier",
		);
		// Nothing was cancelled on the comm side.
		expect(
			rawCommDb(fx.commDb)
				.prepare("SELECT state FROM mailbox WHERE id = ?")
				.get(fx.physicalId),
		).toEqual({ state: "QUEUED" });
	});

	it("marks an operation whose family or root cannot be resolved failed instead of skipping it forever", async () => {
		const fx = await commFixture("mailbox");
		rawDb(fx.store)
			.prepare(
				"UPDATE workflow_delivery_operation SET family = NULL WHERE operation_id = ?",
			)
			.run(fx.operationId);

		operations(fx.store, fx.commDb).runPass("2026-09-03T22:02:00.000Z");

		expect(operationRow(fx.store, fx.operationId)).toEqual({
			state: "failed",
			last_error: "delivery_operation_source_unresolved",
		});
		expect(failureReason(fx.store, fx.runId)).toBe(
			"delivery_operation_source_unresolved",
		);
	});

	it("marks a cancel whose StateStore application is rejected failed with the apply reason", async () => {
		const fx = await commFixture("turn_wake");
		expect(
			fx.commDb.cancelTurnWake(fx.physicalId, "terminal_guard:target_terminal"),
		).toBe(true);
		// Keep `pk` resolvable for the operation but drop `table`, so the comm
		// cancel is the idempotent no-op while the StateStore apply rejects.
		rawDb(fx.store)
			.prepare(
				"UPDATE workflow_delivery_attempt SET contract_ref_json = ? WHERE attempt_id = ?",
			)
			.run(JSON.stringify({ pk: fx.physicalId }), fx.episode.attempt_id);

		operations(fx.store, fx.commDb).runPass("2026-09-03T22:02:00.000Z");

		expect(operationRow(fx.store, fx.operationId)).toEqual({
			state: "failed",
			last_error:
				"delivery_cancel_apply_rejected:delivery_cancellation_attempt_changed",
		});
		expect(failureReason(fx.store, fx.runId)).toBe(
			"delivery_cancel_apply_rejected:delivery_cancellation_attempt_changed",
		);
	});
});
