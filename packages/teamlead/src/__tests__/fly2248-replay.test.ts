import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const db of commDbs.splice(0)) db.close();
});

function rawDb(store: StateStore): Database.Database {
	return (
		store as unknown as {
			db: { raw: Database.Database };
		}
	).db.raw;
}

describe("FLY-2248 live-incident replay bed", () => {
	it("replay #1: a minted handoff stalled for three hours opens one durable episode and one alert", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const now = "2026-09-01T23:00:00.000Z";
		const mintedAt = "2026-09-01T20:00:00.000Z";
		const rootId = "flywheel:FLY-2248:handoff-1";
		const attemptId = `${rootId}:g1:a1`;
		const db = rawDb(store);
		const unboundAlertIds: string[] = [];

		db.prepare(
			`INSERT INTO workflow_delivery_attempt (
				root_id, generation, attempt, attempt_id, family,
				contract_ref_json, minted_at
			) VALUES (?, 1, 1, ?, 'gate_holder', ?, ?)`,
		).run(
			rootId,
			attemptId,
			JSON.stringify({
				runId: "run-replay-1",
				table: "question_intent",
				pk: "handoff-1",
			}),
			mintedAt,
		);

		const watch = new DeliveryContractWatch({
			store,
			resolveAlertIdentity: ({ projectName }) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
			enqueueUnboundAlert: (payload) => {
				unboundAlertIds.push(payload.eventId);
				return { eventId: payload.eventId, state: "sent" };
			},
		});
		const result = watch.runPass(now);

		expect(result).toEqual({ observed: 1, opened: 1, closed: 0, alerted: 1 });
		const episode = db
			.prepare(
				`SELECT family, root_id, attempt_id, stage, closed_at, escalation_uid
				 FROM workflow_delivery_contract_episode`,
			)
			.get() as Record<string, unknown>;
		expect(episode).toMatchObject({
			family: "gate_holder",
			root_id: rootId,
			attempt_id: attemptId,
			stage: "minted",
			closed_at: null,
			escalation_uid: `delivery_contract_stalled:${attemptId}:minted:${mintedAt}`,
		});
		expect(unboundAlertIds).toEqual([
			`delivery_contract_stalled:${attemptId}:minted:${mintedAt}`,
		]);
		expect(store.listWorkflowAlertOutbox()).toEqual([]);
	});

	it("replay #4: an unpushed phase wake rings while a freshly pushed wake stays quiet", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const queuedAtMs = Date.parse("2026-09-01T20:00:00.000Z");
		const pushedAtMs = Date.parse("2026-09-01T20:15:00.000Z");
		const now = "2026-09-01T20:20:00.000Z";

		for (const executionId of ["runner-unpushed", "runner-pushed"]) {
			commDb.registerSession(
				executionId,
				`${executionId}-session`,
				"flywheel",
				"FLY-2248",
				"flywheel-eng-lead",
			);
			commDb.enqueueRunnerPhaseWake(
				executionId,
				{
					id: `phase-${executionId}`,
					to: executionId,
					content: `wake ${executionId}`,
					metadata: {},
				},
				queuedAtMs,
			);
		}
		const commRaw = (commDb as unknown as { db: Database.Database }).db;
		for (const executionId of ["runner-unpushed", "runner-pushed"]) {
			commRaw
				.prepare(
					`UPDATE runner_phase_wakes
					    SET admission_state = 'queued', envelope_json = ?
					  WHERE execution_id = ? AND message_id = ?`,
				)
				.run(
					JSON.stringify({
						id: `phase-${executionId}`,
						to: executionId,
						content: `wake ${executionId}`,
						metadata: {},
					}),
					executionId,
					`phase-${executionId}`,
				);
		}
		const pushedClaim = commDb.claimRunnerReceiptWakePush(
			"runner-pushed",
			"phase-runner-pushed",
			pushedAtMs,
			{ t1Ms: 90_000, claimTtlMs: 10_000 },
		);
		expect(pushedClaim).toMatchObject({ attempt: 1 });
		expect(
			commDb.completeRunnerReceiptWakePush({
				executionId: "runner-pushed",
				messageId: "phase-runner-pushed",
				claimToken: pushedClaim!.claimToken,
				attempt: pushedClaim!.attempt,
				result: "delivered",
				nowMs: pushedAtMs,
			}),
		).toBe(true);

		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass(now)).toEqual({
			examined: 2,
			minted: 2,
			advanced: 1,
		});
		const attempts = store
			.listLiveWorkflowDeliveryAttempts()
			.filter(({ family }) => family === "phase_wake");
		expect(attempts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					attempt_id:
						"flywheel:FLY-2248:phase_wake:phase-runner-unpushed:g1:a1",
					sent_at: null,
				}),
				expect.objectContaining({
					attempt_id: "flywheel:FLY-2248:phase_wake:phase-runner-pushed:g1:a1",
					sent_at: "2026-09-01T20:15:00.000Z",
				}),
			]),
		);

		const unboundAlertIds: string[] = [];
		const watch = new DeliveryContractWatch({
			store,
			projectName: "flywheel",
			resolveAlertIdentity: ({ projectName }) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
			enqueueUnboundAlert: (payload) => {
				unboundAlertIds.push(payload.eventId);
				return { eventId: payload.eventId, state: "sent" };
			},
		});
		expect(watch.runPass(now)).toEqual({
			observed: 2,
			opened: 1,
			closed: 0,
			alerted: 1,
		});
		expect(unboundAlertIds).toEqual([
			"delivery_contract_stalled:flywheel:FLY-2248:phase_wake:phase-runner-unpushed:g1:a1:minted:2026-09-01T20:00:00.000Z",
		]);
		expect(
			rawDb(store)
				.prepare(
					"SELECT attempt_id, stage FROM workflow_delivery_contract_episode ORDER BY attempt_id",
				)
				.all(),
		).toEqual([
			{
				attempt_id: "flywheel:FLY-2248:phase_wake:phase-runner-unpushed:g1:a1",
				stage: "minted",
			},
		]);
	});
});
