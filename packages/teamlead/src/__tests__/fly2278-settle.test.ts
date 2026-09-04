import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import type { DeliveryContractClassification } from "../bridge/delivery-contract/types.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const commDb of commDbs.splice(0)) commDb.close();
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function setupOpenEpisode(suffix: string): Promise<{
	store: StateStore;
	attemptId: string;
}> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const rootId = `flywheel:FLY-2278:mailbox:${suffix}`;
	const attemptId = `${rootId}:g1:a1`;
	store.createWorkflowRun({
		runId: `run-${suffix}`,
		issueId: "FLY-2278",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.projectWorkflowDeliveryAttempt({
		rootId,
		attemptId,
		family: "mailbox",
		contractRef: { table: "mailbox", pk: suffix },
		mintedAt: "2026-09-03T14:00:00.000Z",
		sentAt: "2026-09-03T14:01:00.000Z",
	});
	const attempt = store
		.listLiveWorkflowDeliveryAttempts()
		.find((row) => row.attempt_id === attemptId)!;
	store.observeWorkflowDeliveryContract({
		attempt,
		classification: {
			stage: "sent",
			stageEnteredAt: "2026-09-03T14:01:00.000Z",
			terminal: null,
			overdue: true,
			severe: false,
		} as DeliveryContractClassification,
		runId: `run-${suffix}`,
		projectName: "flywheel",
		issueId: "FLY-2278",
		now: "2026-09-03T14:16:00.000Z",
		alertIdentity: {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved",
		},
	});
	return { store, attemptId };
}

describe("FLY-2278 M1 terminal settlement", () => {
	it("closes unbound terminal-recipient mailbox work and atomically settles ACKED work", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"runner-projector-settle",
			"window-projector-settle",
			"flywheel",
			"FLY-2278",
			"flywheel-eng-lead",
		);
		for (const id of ["mailbox-terminal-unacked", "mailbox-acked"] as const) {
			commDb.insertInstructionWithId(
				id,
				"flywheel-eng-lead",
				"runner-projector-settle",
				id,
			);
		}
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass("2026-09-03T14:00:00.000Z")).toEqual({
			examined: 2,
			minted: 2,
			advanced: 0,
		});
		for (const id of ["mailbox-terminal-unacked", "mailbox-acked"] as const) {
			const attempt = store
				.listLiveWorkflowDeliveryAttempts()
				.find((row) => JSON.parse(row.contract_ref_json).pk === id)!;
			store.observeWorkflowDeliveryContract({
				attempt,
				classification: {
					stage: "minted",
					stageEnteredAt: attempt.minted_at,
					terminal: null,
					overdue: true,
					severe: false,
				},
				runId: null,
				projectName: "flywheel",
				issueId: "FLY-2278",
				now: "2026-09-03T14:16:00.000Z",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				enqueueUnboundAlert: ({ eventId }) => ({
					eventId,
					state: "sent",
				}),
			});
		}
		const commRaw = (commDb as unknown as { db: Database.Database }).db;
		commRaw
			.prepare(
				"UPDATE sessions SET status = 'completed' WHERE execution_id = ?",
			)
			.run("runner-projector-settle");
		commRaw
			.prepare(
				"UPDATE mailbox SET state = 'DEAD', dead_reason = 'recipient_terminal' WHERE id = ?",
			)
			.run("mailbox-terminal-unacked");
		commRaw
			.prepare("UPDATE mailbox SET state = 'ACKED', acked_at = ? WHERE id = ?")
			.run("2026-09-03T14:20:00.000Z", "mailbox-acked");

		projector.runPass("2026-09-03T14:21:00.000Z");

		const livePhysicalIds = store
			.listLiveWorkflowDeliveryAttempts()
			.map((row) => JSON.parse(row.contract_ref_json).pk);
		expect(livePhysicalIds).not.toContain("mailbox-terminal-unacked");
		expect(livePhysicalIds).not.toContain("mailbox-acked");
		expect(
			rawDb(store)
				.prepare(
					`SELECT attempt.settlement_reason, episode.closed_at, episode.closed_reason
					   FROM workflow_delivery_attempt attempt
					   JOIN workflow_delivery_contract_episode episode
					     ON episode.attempt_id = attempt.attempt_id
					  WHERE json_extract(attempt.contract_ref_json, '$.pk') = ?`,
				)
				.get("mailbox-terminal-unacked"),
		).toEqual({
			settlement_reason: "legacy_unreachable",
			closed_at: "2026-09-03T14:21:00.000Z",
			closed_reason: "legacy_unreachable",
		});
		expect(
			rawDb(store)
				.prepare(
					`SELECT attempt.settlement_reason, episode.closed_at, episode.closed_reason
					   FROM workflow_delivery_attempt attempt
					   JOIN workflow_delivery_contract_episode episode
					     ON episode.attempt_id = attempt.attempt_id
					  WHERE json_extract(attempt.contract_ref_json, '$.pk') = ?`,
				)
				.get("mailbox-acked"),
		).toEqual({
			settlement_reason: "source_terminal",
			closed_at: "2026-09-03T14:21:00.000Z",
			closed_reason: "terminal:settled:source_terminal",
		});
	});

	it("settles the live attempt and closes its episode atomically with caller time", async () => {
		const { store, attemptId } = await setupOpenEpisode("settle-success");
		expect(
			store.settleProjectedWorkflowDeliveryAttempt({
				family: "mailbox",
				table: "mailbox",
				pk: "settle-success",
				reason: "source_terminal",
				now: "2026-09-03T14:20:00.000Z",
			}),
		).toBe(true);
		expect(
			rawDb(store)
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(attemptId),
		).toEqual({ settlement_reason: "source_terminal" });
		expect(
			rawDb(store)
				.prepare(
					"SELECT closed_at, closed_reason FROM workflow_delivery_contract_episode WHERE attempt_id = ?",
				)
				.get(attemptId),
		).toEqual({
			closed_at: "2026-09-03T14:20:00.000Z",
			closed_reason: "terminal:settled:source_terminal",
		});
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.some((row) => row.settlement_reason !== null),
		).toBe(false);
	});

	it("rolls the attempt settlement back when episode closure fails", async () => {
		const { store, attemptId } = await setupOpenEpisode("settle-rollback");
		rawDb(store).exec(`
			CREATE TRIGGER fly2278_fail_episode_close
			BEFORE UPDATE ON workflow_delivery_contract_episode
			WHEN OLD.attempt_id = '${attemptId}'
			BEGIN SELECT RAISE(ABORT, 'injected episode close failure'); END;
		`);
		expect(() =>
			store.settleProjectedWorkflowDeliveryAttempt({
				family: "mailbox",
				table: "mailbox",
				pk: "settle-rollback",
				reason: "run_terminal",
				now: "2026-09-03T14:20:00.000Z",
			}),
		).toThrow("injected episode close failure");
		expect(
			rawDb(store)
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(attemptId),
		).toEqual({ settlement_reason: null });
		expect(
			rawDb(store)
				.prepare(
					"SELECT closed_at FROM workflow_delivery_contract_episode WHERE attempt_id = ?",
				)
				.get(attemptId),
		).toEqual({ closed_at: null });
	});

	it("settles a versionless rework attempt from its run fallback after the physical row is gone", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-versionless-rework",
			issueId: "FLY-2278",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		const rootId = "flywheel:FLY-2278:rework:missing-rework";
		const attemptId = `${rootId}:g1:a1`;
		store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "rework",
			contractRef: {
				table: "workflow_rework_delivery",
				pk: "missing-rework",
			},
			mintedAt: "2026-09-03T14:00:00.000Z",
			sentAt: "2026-09-03T14:01:00.000Z",
		});
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find((row) => row.attempt_id === attemptId)!;
		store.observeWorkflowDeliveryContract({
			attempt,
			classification: {
				stage: "sent",
				stageEnteredAt: "2026-09-03T14:01:00.000Z",
				terminal: null,
				overdue: true,
				severe: false,
			},
			runId: "run-versionless-rework",
			projectName: "flywheel",
			issueId: "FLY-2278",
			now: "2026-09-03T14:16:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		});
		rawDb(store)
			.prepare("UPDATE workflow_run SET status = 'completed' WHERE run_id = ?")
			.run("run-versionless-rework");

		expect(
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-03T14:20:00.000Z"),
		).toEqual({ examined: 0, minted: 0, advanced: 1 });
		expect(
			rawDb(store)
				.prepare(
					`SELECT attempt.settlement_reason, episode.closed_reason
					   FROM workflow_delivery_attempt attempt
					   JOIN workflow_delivery_contract_episode episode
					     ON episode.attempt_id = attempt.attempt_id
					  WHERE attempt.attempt_id = ?`,
				)
				.get(attemptId),
		).toEqual({
			settlement_reason: "run_terminal",
			closed_reason: "terminal:settled:run_terminal",
		});
	});

	it("settles a pruned CommDB attempt when its episode-owning run is terminal", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-pruned-mailbox",
			issueId: "FLY-2278",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		const rootId = "flywheel:FLY-2278:mailbox:pruned-mailbox";
		const attemptId = `${rootId}:g1:a1`;
		store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "mailbox",
			contractRef: { table: "mailbox", pk: "pruned-mailbox" },
			mintedAt: "2026-09-03T15:00:00.000Z",
			sentAt: "2026-09-03T15:01:00.000Z",
		});
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find((row) => row.attempt_id === attemptId)!;
		store.observeWorkflowDeliveryContract({
			attempt,
			classification: {
				stage: "undeliverable",
				stageEnteredAt: "2026-09-03T15:02:00.000Z",
				terminal: null,
				overdue: true,
				severe: false,
			},
			runId: "run-pruned-mailbox",
			projectName: "flywheel",
			issueId: "FLY-2278",
			now: "2026-09-03T15:16:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		});
		rawDb(store)
			.prepare("UPDATE workflow_run SET status = 'completed' WHERE run_id = ?")
			.run("run-pruned-mailbox");

		expect(
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-03T15:20:00.000Z"),
		).toEqual({ examined: 0, minted: 0, advanced: 1 });
		expect(
			rawDb(store)
				.prepare(
					`SELECT attempt.settlement_reason, episode.closed_reason
					   FROM workflow_delivery_attempt attempt
					   JOIN workflow_delivery_contract_episode episode
					     ON episode.attempt_id = attempt.attempt_id
					  WHERE attempt.attempt_id = ?`,
				)
				.get(attemptId),
		).toEqual({
			settlement_reason: "run_terminal",
			closed_reason: "terminal:settled:run_terminal",
		});
	});

	it("settles a pruned CommDB attempt even when it never acquired run ownership", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const rootId = "flywheel:FLY-2278:mailbox:pruned-unbound-mailbox";
		const attemptId = `${rootId}:g1:a1`;
		store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "mailbox",
			contractRef: { table: "mailbox", pk: "pruned-unbound-mailbox" },
			mintedAt: "2026-09-03T16:00:00.000Z",
		});
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find((row) => row.attempt_id === attemptId)!;
		store.observeWorkflowDeliveryContract({
			attempt,
			classification: {
				stage: "minted",
				stageEnteredAt: "2026-09-03T16:00:00.000Z",
				terminal: null,
				overdue: true,
				severe: false,
			},
			runId: null,
			projectName: "flywheel",
			issueId: "FLY-2278",
			now: "2026-09-03T16:06:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			enqueueUnboundAlert: ({ eventId }) => ({
				eventId,
				state: "sent",
			}),
		});

		expect(
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-03T16:07:00.000Z"),
		).toEqual({ examined: 0, minted: 0, advanced: 1 });
		expect(
			rawDb(store)
				.prepare(
					`SELECT attempt.settlement_reason, episode.closed_reason
					   FROM workflow_delivery_attempt attempt
					   JOIN workflow_delivery_contract_episode episode
					     ON episode.attempt_id = attempt.attempt_id
					  WHERE attempt.attempt_id = ?`,
				)
				.get(attemptId),
		).toEqual({
			settlement_reason: "source_pruned",
			closed_reason: "terminal:settled:source_pruned",
		});
	});

	it("has no disappeared episode fallback in production source", () => {
		const stateStoreSource = readFileSync(
			resolve(process.cwd(), "src/StateStore.ts"),
			"utf8",
		);
		const watchSource = readFileSync(
			resolve(process.cwd(), "src/bridge/delivery-contract/watch.ts"),
			"utf8",
		);
		expect(`${stateStoreSource}\n${watchSource}`).not.toMatch(
			/["']disappeared["']/,
		);
	});
});
