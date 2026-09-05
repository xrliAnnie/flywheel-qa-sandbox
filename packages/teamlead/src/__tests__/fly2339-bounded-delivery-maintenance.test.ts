import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DeliveryProjector,
	type DeliveryProjectorCursor,
} from "../bridge/delivery-contract/projector.js";
import {
	DeliveryContractWatch,
	type DeliveryWatchCursor,
} from "../bridge/delivery-contract/watch.js";
import {
	DeliveryOperations,
	type DeliveryOperationsCursor,
} from "../bridge/delivery-operations.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];
const now = "2026-09-04T20:30:00.000Z";

function rawStateDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const commDb of commDbs.splice(0)) commDb.close();
});

describe("FLY-2339 bounded delivery maintenance", () => {
	it("resolves all 4,271 projection identities in under one second", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const db = rawStateDb(store);
		const insert = db.prepare(
			`INSERT INTO workflow_delivery_attempt
			   (root_id, generation, attempt, attempt_id, family,
			    contract_ref_json, minted_at)
			 VALUES (?, 1, 1, ?, 'mailbox', ?, ?)`,
		);
		db.transaction(() => {
			for (let index = 0; index < 4_271; index++) {
				const physicalId = `mail-${String(index).padStart(4, "0")}`;
				const rootId = `flywheel:FLY-2339:mailbox:${physicalId}`;
				insert.run(
					rootId,
					`${rootId}:g1:a1`,
					JSON.stringify({ table: "mailbox", pk: physicalId }),
					now,
				);
			}
		})();

		const startedAt = performance.now();
		for (let index = 0; index < 4_271; index++) {
			const physicalId = `mail-${String(index).padStart(4, "0")}`;
			const rootId = `flywheel:FLY-2339:mailbox:${physicalId}`;
			expect(
				store.resolveWorkflowDeliveryProjectionIdentity({
					family: "mailbox",
					table: "mailbox",
					physicalId,
					fallbackRootId: rootId,
				}).attemptId,
			).toBe(`${rootId}:g1:a1`);
		}
		expect(performance.now() - startedAt).toBeLessThan(1_000);
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"recipient",
			"window",
			"flywheel",
			"FLY-2339",
			"flywheel-eng-lead",
		);
		for (let index = 0; index < 4_271; index++) {
			const physicalId = `mail-${String(index).padStart(4, "0")}`;
			commDb.insertInstructionWithId(
				physicalId,
				"flywheel-eng-lead",
				"recipient",
				"fixture",
			);
		}
		(commDb as unknown as { db: Database.Database }).db
			.prepare("UPDATE mailbox SET created_at = ?")
			.run(now);
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		let projectorCursor: DeliveryProjectorCursor | undefined;
		let examined = 0;
		const projectorStartedAt = performance.now();
		do {
			const page = projector.runPass(now, projectorCursor);
			examined += page.examined;
			projectorCursor = page.nextCursor;
		} while (projectorCursor);
		expect(examined).toBe(4_271);
		expect(performance.now() - projectorStartedAt).toBeLessThan(1_000);

		db.prepare(
			"UPDATE workflow_delivery_attempt SET settlement_reason = 'fixture_terminal' WHERE attempt_id < ?",
		).run("flywheel:FLY-2339:mailbox:mail-4159:g1:a1");
		const watch = new DeliveryContractWatch({
			store,
			commDb,
			projectName: "flywheel",
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});
		let cursor: DeliveryWatchCursor | undefined;
		let observed = 0;
		const watchStartedAt = performance.now();
		do {
			const page = watch.runPass(now, cursor);
			observed += page.observed;
			cursor = page.nextCursor;
		} while (cursor);
		expect(observed).toBe(112);
		expect(performance.now() - watchStartedAt).toBeLessThan(1_000);
	});

	it("observes at most 64 attempts per watch page without full CommDB scans", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		for (let index = 0; index < 65; index++) {
			const physicalId = `mail-${String(index).padStart(3, "0")}`;
			const rootId = `flywheel:FLY-2339:mailbox:${physicalId}`;
			store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId: `${rootId}:g1:a1`,
				family: "mailbox",
				contractRef: {
					projectName: "flywheel",
					issueId: "FLY-2339",
					table: "mailbox",
					pk: physicalId,
				},
				mintedAt: now,
				sentAt: now,
			});
		}
		const listMailbox = vi.fn(() => []);
		const listTurnWake = vi.fn(() => []);
		const getMailbox = vi.fn(() => undefined);
		const commDb = {
			listRunnerDeliveryProjectionRows: listMailbox,
			listRunnerTurnWakeProjectionRows: listTurnWake,
			getRunnerDeliveryProjectionRow: getMailbox,
			getRunnerPhaseWakeProjectionRow: vi.fn(() => undefined),
			getRunnerTurnWakeProjectionRow: vi.fn(() => undefined),
		} as unknown as CommDB;
		const watch = new DeliveryContractWatch({
			store,
			commDb,
			projectName: "flywheel",
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		const first = watch.runPass(now);
		expect(first).toMatchObject({ observed: 64 });
		expect(first.nextCursor).toBeDefined();
		expect(listMailbox).not.toHaveBeenCalled();
		expect(listTurnWake).not.toHaveBeenCalled();
		expect(getMailbox).toHaveBeenCalledTimes(64);

		const second = watch.runPass(now, first.nextCursor);
		expect(second).toEqual({ observed: 1, opened: 0, closed: 0, alerted: 0 });
	});

	it("keeps StateStore pages on live-only partial indexes", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const db = rawStateDb(store);
		const detail = (sql: string, ...params: unknown[]) =>
			(
				db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
					detail: string;
				}>
			).map((row) => row.detail);

		expect(
			detail(
				`SELECT root_id FROM workflow_delivery_attempt
				  WHERE superseded_by_attempt_id IS NULL AND settlement_reason IS NULL
				    AND root_id >= ? AND root_id < ? AND root_id > ?
				  ORDER BY root_id LIMIT ?`,
				"flywheel:",
				"flywheel;",
				"flywheel:FLY-2000",
				65,
			).join("\n"),
		).toContain("idx_wda_live_by_root");
		const episodePlan = detail(
			`SELECT episode_id FROM workflow_delivery_contract_episode
				  WHERE closed_at IS NULL AND stage = 'undeliverable'
				    AND (root_id, family) > (?, ?)
				  ORDER BY root_id, family LIMIT ?`,
			"flywheel:FLY-2000",
			"mailbox",
			65,
		).join("\n");
		expect(episodePlan).toContain(
			"SEARCH workflow_delivery_contract_episode USING INDEX idx_wdce_open_undeliverable_by_root",
		);
		expect(episodePlan).not.toContain(
			"SCAN workflow_delivery_contract_episode",
		);
		expect(
			detail(
				`SELECT operation_id FROM workflow_delivery_operation
				  WHERE kind = 'hold_resume' AND state IN ('staged','applied')
				    AND operation_id > ? ORDER BY operation_id LIMIT ?`,
				"operation-0000",
				65,
			).join("\n"),
		).toContain("idx_wdo_pending_hold_by_id");
	});

	it("projects at most 64 source objects per page and drains the remainder", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"recipient",
			"window",
			"flywheel",
			"FLY-2339",
			"flywheel-eng-lead",
		);
		for (let index = 0; index < 65; index++) {
			commDb.insertInstructionWithId(
				`mail-${String(index).padStart(3, "0")}`,
				"flywheel-eng-lead",
				"recipient",
				"bounded projection",
			);
		}
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		const mailboxPages = vi.spyOn(commDb, "listRunnerDeliveryProjectionRows");

		const first = projector.runPass(now);
		expect(first).toMatchObject({ examined: 64, minted: 64 });
		expect(first.nextCursor).toBeDefined();
		expect(first.nextCursor).not.toHaveProperty("activeSources");
		expect(mailboxPages).toHaveBeenCalledWith(
			now,
			expect.objectContaining({ includeInflight: false }),
		);

		let page = projector.runPass(now, first.nextCursor);
		expect(page).toMatchObject({ examined: 1, minted: 1, advanced: 0 });
		while (page.nextCursor) page = projector.runPass(now, page.nextCursor);
		expect(page.nextCursor).toBeUndefined();
		expect(store.listLiveWorkflowDeliveryAttempts()).toHaveLength(65);
	});

	it("skips already-current active and settled terminal projection rows", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"recipient",
			"window",
			"flywheel",
			"FLY-2339",
			"flywheel-eng-lead",
		);
		for (let index = 0; index < 65; index++) {
			const physicalId = `terminal-${String(index).padStart(3, "0")}`;
			const rootId = `flywheel:FLY-2339:mailbox:${physicalId}`;
			store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId: `${rootId}:g1:a1`,
				family: "mailbox",
				contractRef: { table: "mailbox", pk: physicalId },
				mintedAt: now,
			});
			commDb.insertInstructionWithId(
				physicalId,
				"flywheel-eng-lead",
				"recipient",
				"terminal",
			);
		}
		rawStateDb(store)
			.prepare(
				"UPDATE workflow_delivery_attempt SET settlement_reason = 'source_terminal' WHERE root_id < ?",
			)
			.run("flywheel:FLY-2339:mailbox:terminal-032");
		(commDb as unknown as { db: Database.Database }).db
			.prepare(
				"UPDATE mailbox SET state = 'ACKED', acked_at = ?, created_at = ? WHERE id < ?",
			)
			.run(now, now, "terminal-032");
		(commDb as unknown as { db: Database.Database }).db
			.prepare("UPDATE mailbox SET created_at = ? WHERE id >= ?")
			.run(now, "terminal-032");
		const projectAttempt = vi.spyOn(store, "projectWorkflowDeliveryAttempt");
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		let cursor: DeliveryProjectorCursor | undefined;
		do cursor = projector.runPass(now, cursor).nextCursor;
		while (cursor);
		expect(projectAttempt).not.toHaveBeenCalled();
	});

	it("forgets active sources when a new projector drain starts", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"recipient",
			"window",
			"flywheel",
			"FLY-2339",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"mail-1",
			"flywheel-eng-lead",
			"recipient",
			"bounded projection",
		);
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		let cursor: DeliveryProjectorCursor | undefined;
		do cursor = projector.runPass(now, cursor).nextCursor;
		while (cursor);

		(commDb as unknown as { db: Database.Database }).db
			.prepare("UPDATE mailbox SET state = 'ACKED', acked_at = ? WHERE id = ?")
			.run(now, "mail-1");
		do cursor = projector.runPass(now, cursor).nextCursor;
		while (cursor);

		expect(
			rawStateDb(store)
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE root_id = ?",
				)
				.get("flywheel:FLY-2339:mailbox:mail-1"),
		).toEqual({ settlement_reason: "source_terminal" });
	});

	it("runs at most 64 delivery operations per page", () => {
		const pending = Array.from({ length: 4_271 }, (_, index) => ({
			operationId: `operation-${String(index).padStart(4, "0")}`,
			runId: "run-1",
			shape: "mailbox_inflight_slots_exhausted",
			holdEventUid: `hold-${index}`,
			state: "applied" as const,
			physicalId: `mail-${index}`,
			family: "mailbox" as const,
			rootId: `flywheel:FLY-2339:mailbox:mail-${index}`,
			sourceAttemptId: null,
			targetActivationId: null,
			episodeId: null,
		}));
		const listPending = vi.fn(
			(options?: { afterOperationId?: string; limit?: number }) =>
				pending
					.filter(
						(operation) =>
							!options?.afterOperationId ||
							operation.operationId > options.afterOperationId,
					)
					.slice(0, options?.limit),
		);
		let projected = 0;
		const store = {
			listPendingWorkflowHoldResumeOperations: listPending,
			getWorkflowRun: vi.fn(() => ({
				project_name: "flywheel",
				issue_id: "FLY-2339",
			})),
			projectWorkflowHoldResume: () => {
				projected++;
			},
			listOpenUndeliverableDeliveryEpisodes: vi.fn(() => []),
			alertStalledWorkflowDeliveryOperations: vi.fn(() => 0),
		} as unknown as StateStore;
		const operations = new DeliveryOperations({
			store,
			commDb: {} as CommDB,
			projectName: "flywheel",
			resolveRecipient: () => null,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		const first = operations.runPass(now);
		expect(projected).toBe(64);
		expect(first.nextCursor).toBeDefined();

		let cursor = first.nextCursor;
		const startedAt = performance.now();
		while (cursor) cursor = operations.runPass(now, cursor).nextCursor;
		expect(projected).toBe(4_271);
		expect(performance.now() - startedAt).toBeLessThan(1_000);
	});

	it("drains more than one page of real open episodes without skipping", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const db = rawStateDb(store);
		const insertAttempt = db.prepare(
			`INSERT INTO workflow_delivery_attempt
			   (root_id, generation, attempt, attempt_id, family,
			    contract_ref_json, minted_at)
			 VALUES (?, 1, 1, ?, 'mailbox', ?, ?)`,
		);
		const insertEpisode = db.prepare(
			`INSERT INTO workflow_delivery_contract_episode
			   (episode_id, family, root_id, attempt_id, run_id, stage,
			    stage_entered_at, opened_at, escalation_uid)
			 VALUES (?, 'mailbox', ?, ?, 'run-1', 'undeliverable', ?, ?, ?)`,
		);
		db.transaction(() => {
			for (let index = 0; index < 65; index++) {
				const physicalId = `episode-${String(index).padStart(3, "0")}`;
				const rootId = `flywheel:FLY-2339:mailbox:${physicalId}`;
				const attemptId = `${rootId}:g1:a1`;
				insertAttempt.run(
					rootId,
					attemptId,
					JSON.stringify({ table: "mailbox", pk: physicalId }),
					now,
				);
				insertEpisode.run(
					`episode-${String(index).padStart(3, "0")}`,
					rootId,
					attemptId,
					now,
					now,
					`escalation-${index}`,
				);
			}
		})();
		const operations = new DeliveryOperations({
			store,
			commDb: { getMessageById: () => undefined } as unknown as CommDB,
			resolveRecipient: () => null,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		let cursor: DeliveryOperationsCursor | undefined = { lane: "episode" };
		let examined = 0;
		do {
			const page = operations.runPass(now, cursor);
			examined += page.examined;
			cursor = page.nextCursor;
		} while (cursor);
		expect(examined).toBe(65);
	});

	it("continues to the stalled scan when an episode page exactly fills its budget", () => {
		const episodes = Array.from({ length: 64 }, (_, index) => ({
			episode_id: `episode-${index}`,
			run_id: "run-1",
			family: "mailbox" as const,
			root_id: `flywheel:FLY-2339:mailbox:${index}`,
			attempt_id: `attempt-${index}`,
			contract_ref_json: JSON.stringify({
				table: "mailbox",
				pk: `mail-${index}`,
			}),
		}));
		const alertStalled = vi.fn(() => 0);
		const store = {
			listOpenUndeliverableDeliveryEpisodes: vi.fn(() => episodes),
			getWorkflowRun: vi.fn(() => undefined),
			hasWorkflowDeliveryRerouteOperatorRequired: vi.fn(() => false),
			alertStalledWorkflowDeliveryOperations: alertStalled,
		} as unknown as StateStore;
		const operations = new DeliveryOperations({
			store,
			commDb: { getMessageById: () => undefined } as unknown as CommDB,
			resolveRecipient: () => null,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		const first = operations.runPass(now, { lane: "episode" });
		expect(first.nextCursor).toEqual({ lane: "stalled" });
		expect(alertStalled).not.toHaveBeenCalled();
		operations.runPass(now, first.nextCursor);
		expect(alertStalled).toHaveBeenCalledOnce();
	});
});
