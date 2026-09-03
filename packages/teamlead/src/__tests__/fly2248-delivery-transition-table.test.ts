import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { classifyDeliveryAttempt } from "../bridge/delivery-contract/classify.js";
import type {
	DeliveryContractClassification,
	WorkflowDeliveryAttemptRow,
} from "../bridge/delivery-contract/types.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function createAttempt(): Promise<{
	store: StateStore;
	attempt: WorkflowDeliveryAttemptRow;
}> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.projectWorkflowDeliveryAttempt({
		rootId: "flywheel:FLY-2248:mailbox:transition-table",
		attemptId: "flywheel:FLY-2248:mailbox:transition-table:g1:a1",
		family: "mailbox",
		contractRef: { table: "mailbox", pk: "transition-table" },
		mintedAt: "2026-09-02T00:00:00.000Z",
	});
	return { store, attempt: store.listLiveWorkflowDeliveryAttempts()[0]! };
}

function observe(
	store: StateStore,
	attempt: WorkflowDeliveryAttemptRow,
	classification: DeliveryContractClassification & {
		terminalShape?: string | null;
	},
	now: string,
): void {
	store.observeWorkflowDeliveryContract({
		attempt,
		classification,
		runId: "delivery:transition-table",
		projectName: "flywheel",
		issueId: "FLY-2248",
		now,
		alertIdentity: {
			leadId: "lead-fly2248",
			projectName: "flywheel",
			leadResolution: "resolved",
		},
	});
}

const _resolveAlertIdentity = ({ projectName }: { projectName: string }) => ({
	leadId: "lead-fly2248",
	projectName,
	leadResolution: "resolved" as const,
});

function rawDb(store: StateStore): Database.Database {
	return (
		store as unknown as {
			db: { raw: Database.Database };
		}
	).db.raw;
}

describe("FLY-2248 delivery episode transition table", () => {
	it("does not age a founder gate after receipt while it waits for a decision", () => {
		const receivedAt = "2026-09-02T00:00:00.000Z";
		expect(
			classifyDeliveryAttempt(
				{
					root_id: "flywheel:FLY-2248:gate_holder:question-1",
					generation: 1,
					attempt: 1,
					attempt_id: "flywheel:FLY-2248:gate_holder:question-1:g1:a1",
					family: "gate_holder",
					contract_ref_json: JSON.stringify({
						table: "workflow_gate_holder",
						pk: "question-1",
					}),
					parent_attempt_id: null,
					minted_at: receivedAt,
					granted_at: receivedAt,
					sent_at: receivedAt,
					received_at: receivedAt,
					consumed_at: null,
					settlement_reason: null,
					superseded_by_attempt_id: null,
				},
				"2026-09-02T02:00:00.000Z",
			),
		).toMatchObject({ stage: "received", overdue: false, severe: false });
	});

	it("expires an unconsumed launch receipt at the thirty-minute boundary", () => {
		const receivedAt = "2026-09-02T00:00:00.000Z";
		expect(
			classifyDeliveryAttempt(
				{
					root_id: "flywheel:FLY-2248:launch:execution-1",
					generation: 1,
					attempt: 1,
					attempt_id: "flywheel:FLY-2248:launch:execution-1:g1:a1",
					family: "launch",
					contract_ref_json: JSON.stringify({
						table: "workflow_execution_binding",
						pk: "execution-1",
					}),
					parent_attempt_id: null,
					minted_at: receivedAt,
					granted_at: receivedAt,
					sent_at: receivedAt,
					received_at: receivedAt,
					consumed_at: null,
					settlement_reason: null,
					superseded_by_attempt_id: null,
				},
				"2026-09-02T00:30:00.000Z",
			),
		).toMatchObject({ stage: "received", overdue: true, severe: false });
	});

	it("closes and reopens an overdue episode as regressed when its stage moves backward", async () => {
		const { store, attempt } = await createAttempt();
		observe(
			store,
			attempt,
			{
				stage: "sent",
				stageEnteredAt: "2026-09-02T00:05:00.000Z",
				terminal: null,
				overdue: true,
				severe: false,
			},
			"2026-09-02T00:21:00.000Z",
		);
		observe(
			store,
			attempt,
			{
				stage: "granted",
				stageEnteredAt: "2026-09-02T00:02:00.000Z",
				terminal: null,
				overdue: true,
				severe: false,
			},
			"2026-09-02T00:22:00.000Z",
		);

		const episodes = rawDb(store)
			.prepare(
				`SELECT stage, closed_reason
				   FROM workflow_delivery_contract_episode
				  ORDER BY opened_at, episode_id`,
			)
			.all() as Array<{ stage: string; closed_reason: string | null }>;
		expect(episodes).toEqual([
			{ stage: "sent", closed_reason: "regressed" },
			{ stage: "granted", closed_reason: null },
		]);
	});

	it("closes and reopens an overdue episode as reminted when the live attempt changes", async () => {
		const { store, attempt } = await createAttempt();
		observe(
			store,
			attempt,
			{
				stage: "minted",
				stageEnteredAt: attempt.minted_at,
				terminal: null,
				overdue: true,
				severe: false,
			},
			"2026-09-02T00:11:00.000Z",
		);
		const childAttemptId = `${attempt.root_id}:g2:a1`;
		const db = rawDb(store);
		db.pragma("defer_foreign_keys = ON");
		db.transaction(() => {
			db.prepare(
				`UPDATE workflow_delivery_attempt
				    SET superseded_by_attempt_id = ?
				  WHERE attempt_id = ?`,
			).run(childAttemptId, attempt.attempt_id);
			db.prepare(
				`INSERT INTO workflow_delivery_attempt (
				   root_id, generation, attempt, attempt_id, family,
				   contract_ref_json, parent_attempt_id, minted_at
				 ) VALUES (?, 2, 1, ?, ?, ?, ?, ?)`,
			).run(
				attempt.root_id,
				childAttemptId,
				attempt.family,
				attempt.contract_ref_json,
				attempt.attempt_id,
				"2026-09-02T00:12:00.000Z",
			);
		})();
		const child = store.listLiveWorkflowDeliveryAttempts()[0]!;
		observe(
			store,
			child,
			{
				stage: "minted",
				stageEnteredAt: child.minted_at,
				terminal: null,
				overdue: true,
				severe: false,
			},
			"2026-09-02T00:23:00.000Z",
		);

		const episodes = db
			.prepare(
				`SELECT attempt_id, closed_reason
				   FROM workflow_delivery_contract_episode
				  ORDER BY opened_at, episode_id`,
			)
			.all() as Array<{ attempt_id: string; closed_reason: string | null }>;
		expect(episodes).toEqual([
			{ attempt_id: attempt.attempt_id, closed_reason: "reminted" },
			{ attempt_id: childAttemptId, closed_reason: null },
		]);
	});

	it("closes an open stall for superseded and cancelled terminals", async () => {
		for (const terminal of ["superseded", "cancelled"] as const) {
			const { store, attempt } = await createAttempt();
			observe(
				store,
				attempt,
				{
					stage: "minted",
					stageEnteredAt: attempt.minted_at,
					terminal: null,
					overdue: true,
					severe: false,
				},
				"2026-09-02T00:11:00.000Z",
			);
			observe(
				store,
				attempt,
				{
					stage: "minted",
					stageEnteredAt: attempt.minted_at,
					terminal,
					overdue: false,
					severe: false,
				},
				"2026-09-02T00:12:00.000Z",
			);
			expect(
				(
					rawDb(store)
						.prepare(
							"SELECT closed_reason FROM workflow_delivery_contract_episode",
						)
						.get() as { closed_reason: string }
				).closed_reason,
			).toBe(`terminal:${terminal}`);
		}
	});

	it("closes and reopens an overdue episode as advanced when its stage moves forward", async () => {
		const { store, attempt } = await createAttempt();
		observe(
			store,
			attempt,
			{
				stage: "minted",
				stageEnteredAt: attempt.minted_at,
				terminal: null,
				overdue: true,
				severe: false,
			},
			"2026-09-02T00:11:00.000Z",
		);
		observe(
			store,
			attempt,
			{
				stage: "sent",
				stageEnteredAt: "2026-09-02T00:12:00.000Z",
				terminal: null,
				overdue: true,
				severe: false,
			},
			"2026-09-02T00:28:00.000Z",
		);
		expect(
			rawDb(store)
				.prepare(
					`SELECT stage, closed_reason
					   FROM workflow_delivery_contract_episode
					  ORDER BY opened_at, episode_id`,
				)
				.all(),
		).toEqual([
			{ stage: "minted", closed_reason: "advanced" },
			{ stage: "sent", closed_reason: null },
		]);
	});

	it("keeps one stalled episode and emits at most one warning plus one severe alert", async () => {
		const { store, attempt } = await createAttempt();
		const overdue: DeliveryContractClassification = {
			stage: "minted",
			stageEnteredAt: attempt.minted_at,
			terminal: null,
			overdue: true,
			severe: false,
		};
		observe(store, attempt, overdue, "2026-09-02T00:11:00.000Z");
		observe(
			store,
			attempt,
			{ ...overdue, severe: true },
			"2026-09-02T00:31:00.000Z",
		);
		observe(
			store,
			attempt,
			{ ...overdue, severe: true },
			"2026-09-02T00:32:00.000Z",
		);
		expect(
			rawDb(store)
				.prepare(
					"SELECT COUNT(*) AS count FROM workflow_delivery_contract_episode",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(
			store
				.listWorkflowAlertOutbox()
				.map(({ escalation_uid }) => escalation_uid)
				.sort(),
		).toEqual([
			`delivery_contract_stalled:${attempt.attempt_id}:minted:${attempt.minted_at}`,
			`delivery_contract_stalled:${attempt.attempt_id}:minted:${attempt.minted_at}:severe`,
		]);
	});

	it("delivers an unbound contract alert once without a workflow outbox row", async () => {
		const { store, attempt } = await createAttempt();
		const deliveries: Array<{ eventId: string; state: "sent" }> = [];
		const watch = new DeliveryContractWatch({
			store,
			resolveAlertIdentity: ({ projectName }) => ({
				leadId: "lead-fly2248",
				projectName,
				leadResolution: "resolved",
			}),
			enqueueUnboundAlert: (payload) => {
				const receipt = { eventId: payload.eventId, state: "sent" as const };
				deliveries.push(receipt);
				return receipt;
			},
		});
		const result = watch.runPass("2026-09-02T00:11:00.000Z");
		const replay = watch.runPass("2026-09-02T00:12:00.000Z");

		expect(result).toEqual({ observed: 1, opened: 1, closed: 0, alerted: 1 });
		expect(replay).toEqual({ observed: 1, opened: 0, closed: 0, alerted: 0 });
		expect(deliveries).toEqual([
			{
				eventId: `delivery_contract_stalled:${attempt.attempt_id}:minted:${attempt.minted_at}`,
				state: "sent",
			},
		]);
		expect(store.listWorkflowAlertOutbox()).toEqual([]);
		expect(
			rawDb(store)
				.prepare(
					"SELECT run_id FROM workflow_delivery_contract_episode WHERE root_id = ?",
				)
				.get(attempt.root_id),
		).toEqual({
			run_id: null,
		});
	});

	it("keeps a real workflow run on the workflow alert outbox path", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-delivery-contract",
			issueId: "FLY-2248",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.projectWorkflowDeliveryAttempt({
			rootId: "flywheel:FLY-2248:mailbox:bound-control",
			attemptId: "flywheel:FLY-2248:mailbox:bound-control:g1:a1",
			family: "mailbox",
			contractRef: {
				table: "mailbox",
				pk: "bound-control",
				runId: "run-delivery-contract",
				projectName: "flywheel",
				issueId: "FLY-2248",
			},
			mintedAt: "2026-09-02T00:00:00.000Z",
		});
		let unboundDeliveries = 0;
		const result = new DeliveryContractWatch({
			store,
			resolveAlertIdentity: _resolveAlertIdentity,
			enqueueUnboundAlert: (payload) => {
				unboundDeliveries++;
				return { eventId: payload.eventId, state: "sent" };
			},
		}).runPass("2026-09-02T00:11:00.000Z");

		expect(result).toEqual({ observed: 1, opened: 1, closed: 0, alerted: 1 });
		expect(unboundDeliveries).toBe(0);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(store.listWorkflowAlertOutbox()[0]).toMatchObject({
			run_id: "run-delivery-contract",
			state: "pending",
		});
		const claim = store.claimNextWorkflowAlert({
			ownerId: "bridge-delivery-contract",
			now: "2026-09-02T00:11:01.000Z",
			leaseExpiresAt: "2026-09-02T00:12:01.000Z",
		});
		expect(claim).toBeDefined();
		expect(
			store.finishWorkflowAlertDelivery({
				escalationUid: claim!.escalationUid,
				ownerId: claim!.ownerId,
				generation: claim!.generation,
				outcome: "sent",
				now: "2026-09-02T00:11:02.000Z",
			}),
		).toEqual({ ok: true, state: "sent" });
		expect(store.listWorkflowAlertOutbox()[0]?.state).toBe("sent");
		expect(
			store
				.listWorkflowRunEvents("run-delivery-contract")
				.some(({ kind }) => kind === "workflow_engine_alert_posted"),
		).toBe(true);
		expect(
			rawDb(store)
				.prepare(
					"SELECT run_id FROM workflow_delivery_contract_episode WHERE root_id = ?",
				)
				.get("flywheel:FLY-2248:mailbox:bound-control"),
		).toEqual({ run_id: "run-delivery-contract" });
	});

	it("keeps the same open episode across a backward wall-clock step", async () => {
		const { store, attempt } = await createAttempt();
		observe(
			store,
			attempt,
			classifyDeliveryAttempt(attempt, "2026-09-02T00:11:00.000Z"),
			"2026-09-02T00:11:00.000Z",
		);
		observe(
			store,
			attempt,
			classifyDeliveryAttempt(attempt, "2026-09-02T00:05:00.000Z"),
			"2026-09-02T00:05:00.000Z",
		);
		observe(
			store,
			attempt,
			classifyDeliveryAttempt(attempt, "2026-09-02T00:12:00.000Z"),
			"2026-09-02T00:12:00.000Z",
		);

		expect(
			rawDb(store)
				.prepare(
					`SELECT episode_id, closed_at, closed_reason
					   FROM workflow_delivery_contract_episode`,
				)
				.all(),
		).toEqual([
			{
				episode_id: `${attempt.attempt_id}:minted:${attempt.minted_at}`,
				closed_at: null,
				closed_reason: null,
			},
		]);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
	});
});
