import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const commDb of commDbs.splice(0)) commDb.close();
});

function rawStateDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function rawCommDb(commDb: CommDB): Database.Database {
	return (commDb as unknown as { db: Database.Database }).db;
}

describe("FLY-2324 legacy delivery reachability", () => {
	it("does not mint or open an episode for an unbound mailbox row whose recipient is terminal", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"legacy-recipient",
			"legacy-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"legacy-mailbox",
			"flywheel-eng-lead",
			"legacy-recipient",
			"historical instruction",
		);
		rawCommDb(commDb)
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-09-01T00:00:00.000Z", "legacy-mailbox");
		commDb.markSessionTerminalStatus("legacy-recipient", "completed");

		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "legacy-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "completed",
		});

		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass("2026-09-04T08:00:00.000Z")).toEqual({
			examined: 1,
			minted: 0,
			advanced: 0,
		});
		expect(
			new DeliveryContractWatch({
				store,
				commDb,
				projectName: "flywheel",
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			}).runPass("2026-09-04T08:00:00.001Z"),
		).toEqual({ observed: 0, opened: 0, closed: 0, alerted: 0 });
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([]);
		expect(
			rawStateDb(store)
				.prepare(
					"SELECT COUNT(*) AS count FROM workflow_delivery_contract_episode",
				)
				.get(),
		).toEqual({ count: 0 });
	});

	it("does not mint a seven-day-old unbound row whose recipient is absent from both stores", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"missing-recipient",
			"missing-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"missing-recipient-mailbox",
			"flywheel-eng-lead",
			"missing-recipient",
			"orphaned instruction",
		);
		rawCommDb(commDb)
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run("missing-recipient");
		rawCommDb(commDb)
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-08-28T08:00:00.000Z", "missing-recipient-mailbox");
		const store = await StateStore.create(":memory:");
		stores.push(store);

		expect(
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-04T08:00:00.000Z"),
		).toEqual({ examined: 1, minted: 0, advanced: 0 });
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([]);
	});

	it("keeps observing a recent unbound row while its recipient is not yet resolvable", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"pending-recipient",
			"pending-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"pending-recipient-mailbox",
			"flywheel-eng-lead",
			"pending-recipient",
			"spawn is still materializing",
		);
		rawCommDb(commDb)
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run("pending-recipient");
		rawCommDb(commDb)
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-09-04T07:59:00.000Z", "pending-recipient-mailbox");
		const store = await StateStore.create(":memory:");
		stores.push(store);

		expect(
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-04T08:00:00.000Z"),
		).toEqual({ examined: 1, minted: 1, advanced: 0 });
	});

	it("keeps observing a recent row for an approved recipient", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"approved-recipient",
			"approved-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"approved-recipient-mailbox",
			"flywheel-eng-lead",
			"approved-recipient",
			"mailbox remains reachable",
		);
		rawCommDb(commDb)
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-09-04T07:59:00.000Z", "approved-recipient-mailbox");
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "approved-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "approved",
		});

		expect(
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-04T08:00:00.000Z"),
		).toEqual({ examined: 1, minted: 1, advanced: 0 });
	});

	it("preserves active-run terminal-recipient episodes so FLY-2278 can reroute to a successor", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"active-terminal-recipient",
			"active-terminal-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"active-terminal-mailbox",
			"flywheel-eng-lead",
			"active-terminal-recipient",
			"reroute this instruction",
		);
		commDb.markSessionTerminalStatus("active-terminal-recipient", "completed");

		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-active-terminal",
			issueId: "FLY-2324",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.upsertSession({
			execution_id: "active-terminal-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "worker",
		});
		store.upsertWorkflowRunNode({
			runId: "run-active-terminal",
			nodeId: "worker",
			attempt: 1,
			state: "running",
			executionId: "active-terminal-recipient",
		});

		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass("2026-09-04T08:00:00.000Z").minted).toBe(1);
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
		expect(watch.runPass("2026-09-04T08:01:00.000Z").opened).toBe(1);

		commDb.registerSession(
			"active-terminal-successor",
			"active-terminal-successor-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		store.upsertSession({
			execution_id: "active-terminal-successor",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		store.upsertWorkflowRunNode({
			runId: "run-active-terminal",
			nodeId: "worker",
			attempt: 2,
			state: "running",
			executionId: "active-terminal-successor",
		});
		const operations = new DeliveryOperations({
			store,
			commDb,
			projectName: "flywheel",
			resolveRecipient: ({ rootId, sourceExecutionId }) =>
				store.resolveWorkflowDeliveryRecipient(rootId, sourceExecutionId),
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});
		expect(operations.runPass("2026-09-04T08:10:00.000Z")).toMatchObject({
			rerouted: 1,
			operatorRequired: 0,
		});
		expect(commDb.getMessageById("active-terminal-mailbox")).toMatchObject({
			superseded_by: expect.any(String),
		});
	});

	it.each(["active", "held"] as const)(
		"keeps delivery alias protection scoped away from shared readers for a %s run",
		async (runStatus) => {
			const commDb = new CommDB(":memory:");
			commDbs.push(commDb);
			commDb.registerSession(
				"held-terminal-recipient",
				"held-terminal-window",
				"flywheel",
				"FLY-2324",
				"flywheel-eng-lead",
			);
			commDb.insertInstructionWithId(
				"held-terminal-mailbox",
				"flywheel-eng-lead",
				"held-terminal-recipient",
				"preserve while held",
			);
			commDb.markSessionTerminalStatus("held-terminal-recipient", "completed");

			const store = await StateStore.create(":memory:");
			stores.push(store);
			const issueUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
			store.upsertSession({
				execution_id: "held-terminal-recipient",
				issue_id: issueUuid,
				issue_identifier: "FLY-2324",
				project_name: "flywheel",
				status: "completed",
			});
			store.createWorkflowRun({
				runId: "run-held-terminal",
				issueId: issueUuid,
				projectName: "flywheel",
				claimsReadEnrolled: true,
			});
			rawStateDb(store)
				.prepare("UPDATE workflow_run SET status = 'held' WHERE run_id = ?")
				.run("run-held-terminal");
			if (runStatus === "active") {
				rawStateDb(store)
					.prepare("UPDATE workflow_run SET status = 'active' WHERE run_id = ?")
					.run("run-held-terminal");
			}
			rawStateDb(store)
				.prepare("DELETE FROM sessions WHERE execution_id = ?")
				.run("held-terminal-recipient");

			expect(store.getPatrolWorkflowRuns("flywheel", "FLY-2324")).toEqual([]);
			expect(store.getActiveWorkflowRunForIssue("FLY-2324")).toBeUndefined();

			expect(
				new DeliveryProjector({
					store,
					commDb,
					projectName: "flywheel",
				}).runPass("2026-09-04T08:00:00.000Z"),
			).toEqual({ examined: 1, minted: 1, advanced: 0 });
		},
	);

	it("captures durable issue aliases when a shadow workflow run is created", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const issueUuid = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
		store.upsertSession({
			execution_id: "shadow-alias-recipient",
			issue_id: issueUuid,
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "running",
		});
		expect(
			store.applyWorkflowLedgerBatch({
				projectName: "flywheel",
				issueId: issueUuid,
				newRunId: "run-shadow-alias",
				ops: [{ op: "kickback", round: 1 }],
			}),
		).toMatchObject({ runId: "run-shadow-alias", created: true });

		rawStateDb(store)
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run("shadow-alias-recipient");
		expect(
			store.getWorkflowDeliveryReachabilityRuns("flywheel", ["FLY-2324"]),
		).toEqual([
			expect.objectContaining({ runId: "run-shadow-alias", status: "active" }),
		]);
	});

	it("runs the delivery alias backfill only once per database", async () => {
		const directory = mkdtempSync(join(tmpdir(), "fly2324-alias-backfill-"));
		const dbPath = join(directory, "state.db");
		try {
			const first = await StateStore.create(dbPath);
			first.createWorkflowRun({
				runId: "legacy-alias-run",
				issueId: "FLY-2324",
				projectName: "flywheel",
				claimsReadEnrolled: true,
			});
			rawStateDb(first).exec(`
				CREATE TRIGGER reject_replayed_alias_backfill
				BEFORE INSERT ON workflow_run_issue_alias
				BEGIN SELECT RAISE(ABORT, 'alias backfill replayed'); END
			`);
			first.close();

			const reopened = await StateStore.create(dbPath);
			expect(
				rawStateDb(reopened)
					.prepare(
						"SELECT count(*) AS count FROM state_store_migration WHERE migration_id = ?",
					)
					.get("fly-2324-workflow-run-issue-alias-v1"),
			).toEqual({ count: 1 });
			reopened.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("atomically closes an existing severe episode once and preserves its alert timestamps", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"stock-terminal-recipient",
			"stock-terminal-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"stock-terminal-mailbox",
			"flywheel-eng-lead",
			"stock-terminal-recipient",
			"historical stock instruction",
		);
		commDb.markSessionTerminalStatus("stock-terminal-recipient", "completed");

		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "stock-terminal-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "completed",
		});
		const rootId = "flywheel:FLY-2324:mailbox:stock-terminal-mailbox";
		const attemptId = `${rootId}:g1:a1`;
		store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "mailbox",
			contractRef: { table: "mailbox", pk: "stock-terminal-mailbox" },
			mintedAt: "2026-09-01T00:00:00.000Z",
		});
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find((candidate) => candidate.attempt_id === attemptId)!;
		const deliveredAlerts: string[] = [];
		const observe = (severe: boolean, now: string) =>
			store.observeWorkflowDeliveryContract({
				attempt,
				classification: {
					stage: "minted",
					stageEnteredAt: "2026-09-01T00:00:00.000Z",
					terminal: null,
					overdue: true,
					severe,
				},
				runId: null,
				projectName: "flywheel",
				issueId: "FLY-2324",
				now,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				enqueueUnboundAlert: ({ eventId }) => {
					deliveredAlerts.push(eventId);
					return { eventId, state: "sent" };
				},
			});
		observe(false, "2026-09-04T08:00:00.000Z");
		observe(true, "2026-09-04T09:00:00.000Z");
		expect(deliveredAlerts).toHaveLength(2);

		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		projector.runPass("2026-09-04T09:01:00.000Z");
		const watch = new DeliveryContractWatch({
			store,
			commDb,
			projectName: "flywheel",
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
			enqueueUnboundAlert: ({ eventId }) => {
				deliveredAlerts.push(eventId);
				return { eventId, state: "sent" };
			},
		});
		watch.runPass("2026-09-04T09:01:00.001Z");

		expect(
			rawStateDb(store)
				.prepare(
					`SELECT attempt.settlement_reason, episode.alerted_at,
					        episode.severe_alerted_at, episode.closed_at,
					        episode.closed_reason
					   FROM workflow_delivery_attempt attempt
					   JOIN workflow_delivery_contract_episode episode
					     ON episode.attempt_id = attempt.attempt_id
					  WHERE attempt.attempt_id = ?`,
				)
				.get(attemptId),
		).toEqual({
			settlement_reason: "legacy_unreachable",
			alerted_at: "2026-09-04T08:00:00.000Z",
			severe_alerted_at: "2026-09-04T09:00:00.000Z",
			closed_at: "2026-09-04T09:01:00.000Z",
			closed_reason: "legacy_unreachable",
		});
		expect(deliveredAlerts).toHaveLength(2);
		expect(projector.runPass("2026-09-04T09:02:00.000Z").minted).toBe(0);
		expect(watch.runPass("2026-09-04T09:02:00.001Z")).toEqual({
			observed: 0,
			opened: 0,
			closed: 0,
			alerted: 0,
		});
		expect(
			rawStateDb(store)
				.prepare(
					"SELECT COUNT(*) AS count FROM workflow_delivery_contract_episode",
				)
				.get(),
		).toEqual({ count: 1 });
	});

	it("rolls back the legacy settlement when episode closure fails", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"rollback-recipient",
			"rollback-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"rollback-mailbox",
			"flywheel-eng-lead",
			"rollback-recipient",
			"historical instruction",
		);
		commDb.markSessionTerminalStatus("rollback-recipient", "completed");

		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "rollback-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "completed",
		});
		const rootId = "flywheel:FLY-2324:mailbox:rollback-mailbox";
		const attemptId = `${rootId}:g1:a1`;
		store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "mailbox",
			contractRef: { table: "mailbox", pk: "rollback-mailbox" },
			mintedAt: "2026-09-01T00:00:00.000Z",
		});
		store.observeWorkflowDeliveryContract({
			attempt: store.listLiveWorkflowDeliveryAttempts()[0]!,
			classification: {
				stage: "minted",
				stageEnteredAt: "2026-09-01T00:00:00.000Z",
				terminal: null,
				overdue: true,
				severe: false,
			},
			runId: null,
			projectName: "flywheel",
			issueId: "FLY-2324",
			now: "2026-09-04T08:00:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			enqueueUnboundAlert: ({ eventId }) => ({ eventId, state: "sent" }),
		});
		rawStateDb(store).exec(`
			CREATE TRIGGER reject_legacy_episode_close
			BEFORE UPDATE OF closed_at ON workflow_delivery_contract_episode
			WHEN NEW.closed_reason = 'legacy_unreachable'
			BEGIN SELECT RAISE(ABORT, 'episode closure rejected'); END
		`);

		expect(() =>
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-04T08:01:00.000Z"),
		).toThrow("episode closure rejected");
		expect(
			rawStateDb(store)
				.prepare(
					`SELECT attempt.settlement_reason, episode.closed_at, episode.closed_reason
					   FROM workflow_delivery_attempt attempt
					   JOIN workflow_delivery_contract_episode episode
					     ON episode.attempt_id = attempt.attempt_id
					  WHERE attempt.attempt_id = ?`,
				)
				.get(attemptId),
		).toEqual({
			settlement_reason: null,
			closed_at: null,
			closed_reason: null,
		});
	});

	it("does not advance source clocks on a legacy-settled generation", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const rootId = "flywheel:FLY-2324:mailbox:settled-clock-mailbox";
		const attemptId = `${rootId}:g1:a1`;
		expect(
			store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId,
				family: "mailbox",
				contractRef: { table: "mailbox", pk: "settled-clock-mailbox" },
				mintedAt: "2026-01-01T00:00:00.000Z",
			}),
		).toEqual({ minted: 1, advanced: 0 });
		expect(
			store.settleProjectedWorkflowDeliveryAttempt({
				family: "mailbox",
				table: "mailbox",
				pk: "settled-clock-mailbox",
				reason: "legacy_unreachable",
				now: "2026-09-04T08:00:00.000Z",
			}),
		).toBe(true);

		expect(
			store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId,
				family: "mailbox",
				contractRef: { table: "mailbox", pk: "settled-clock-mailbox" },
				mintedAt: "2026-01-01T00:00:00.000Z",
				sentAt: "2026-01-01T00:00:20.000Z",
			}),
		).toEqual({ minted: 0, advanced: 0 });
		expect(
			rawStateDb(store)
				.prepare(
					`SELECT sent_at, settlement_reason
					   FROM workflow_delivery_attempt WHERE attempt_id = ?`,
				)
				.get(attemptId),
		).toEqual({ sent_at: null, settlement_reason: "legacy_unreachable" });
	});

	it("re-arms a legacy-settled source in a new generation when it becomes reachable", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"revived-recipient",
			"revived-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"revived-mailbox",
			"flywheel-eng-lead",
			"revived-recipient",
			"deliver after recovery",
		);
		rawCommDb(commDb)
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-09-04T07:59:00.000Z", "revived-mailbox");

		const store = await StateStore.create(":memory:");
		stores.push(store);
		const setRecipientStatus = (status: string) =>
			store.upsertSession({
				execution_id: "revived-recipient",
				issue_id: "FLY-2324",
				issue_identifier: "FLY-2324",
				project_name: "flywheel",
				status,
			});
		setRecipientStatus("running");
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass("2026-09-04T08:00:00.000Z").minted).toBe(1);

		setRecipientStatus("completed");
		expect(projector.runPass("2026-09-04T08:01:00.000Z").advanced).toBe(1);
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([]);

		rawStateDb(store)
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run("revived-recipient");
		setRecipientStatus("running");
		store.createWorkflowRun({
			runId: "run-revived-1",
			issueId: "FLY-2324",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		expect(projector.runPass("2026-09-04T08:02:00.000Z")).toEqual({
			examined: 1,
			minted: 1,
			advanced: 0,
		});
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([
			expect.objectContaining({
				root_id: "flywheel:FLY-2324:mailbox:revived-mailbox",
				generation: 2,
				attempt_id: "flywheel:FLY-2324:mailbox:revived-mailbox:g2:a1",
				settlement_reason: null,
			}),
		]);
		expect(
			rawStateDb(store)
				.prepare(
					`SELECT settlement_reason, superseded_by_attempt_id
					   FROM workflow_delivery_attempt
					  WHERE generation = 1`,
				)
				.get(),
		).toEqual({
			settlement_reason: "legacy_unreachable",
			superseded_by_attempt_id:
				"flywheel:FLY-2324:mailbox:revived-mailbox:g2:a1",
		});
		expect(
			new DeliveryContractWatch({
				store,
				commDb,
				projectName: "flywheel",
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			}).runPass("2026-09-04T08:13:00.000Z").opened,
		).toBe(1);

		rawStateDb(store)
			.prepare("UPDATE workflow_run SET status = 'terminated' WHERE run_id = ?")
			.run("run-revived-1");
		expect(projector.runPass("2026-09-04T08:14:00.000Z").advanced).toBe(1);
		store.createWorkflowRun({
			runId: "run-revived-2",
			issueId: "FLY-2324",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		expect(projector.runPass("2026-09-04T08:15:00.000Z").minted).toBe(1);
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([
			expect.objectContaining({
				generation: 3,
				attempt_id: "flywheel:FLY-2324:mailbox:revived-mailbox:g3:a1",
			}),
		]);
	});

	it("re-arms an ancient reachable source from recovery time", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"ancient-recipient",
			"ancient-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"ancient-mailbox",
			"flywheel-eng-lead",
			"ancient-recipient",
			"historical instruction",
		);
		rawCommDb(commDb)
			.prepare(
				`UPDATE mailbox
				    SET created_at = ?, delivered_at = ?, notified_at = ?, state = 'LEASED'
				  WHERE id = ?`,
			)
			.run(
				"2026-01-01T00:00:00.000Z",
				"2026-01-01T00:00:10.000Z",
				"2026-01-01T00:00:20.000Z",
				"ancient-mailbox",
			);

		const store = await StateStore.create(":memory:");
		stores.push(store);
		const setRecipientStatus = (status: string) =>
			store.upsertSession({
				execution_id: "ancient-recipient",
				issue_id: "FLY-2324",
				issue_identifier: "FLY-2324",
				project_name: "flywheel",
				status,
			});
		setRecipientStatus("running");
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});

		expect(projector.runPass("2026-01-01T00:01:00.000Z").minted).toBe(1);
		rawStateDb(store)
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run("ancient-recipient");
		commDb.markSessionTerminalStatus("ancient-recipient", "completed");
		expect(projector.runPass("2026-09-04T08:00:00.000Z").advanced).toBe(1);
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([]);
		setRecipientStatus("running");
		rawCommDb(commDb)
			.prepare(
				"UPDATE sessions SET status = 'running', ended_at = NULL WHERE execution_id = ?",
			)
			.run("ancient-recipient");
		store.createWorkflowRun({
			runId: "run-new-for-ancient-issue",
			issueId: "FLY-2324",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		expect(projector.runPass("2026-09-04T08:10:00.000Z")).toEqual({
			examined: 1,
			minted: 1,
			advanced: 1,
		});
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([
			expect.objectContaining({
				generation: 2,
				attempt_id: "flywheel:FLY-2324:mailbox:ancient-mailbox:g2:a1",
				minted_at: "2026-09-04T08:10:00.000Z",
				sent_at: "2026-09-04T08:10:00.000Z",
			}),
		]);
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
		expect(watch.runPass("2026-09-04T08:10:00.001Z")).toEqual({
			observed: 1,
			opened: 0,
			closed: 0,
			alerted: 0,
		});
		expect(
			rawStateDb(store)
				.prepare(
					`SELECT COUNT(*) AS count
					   FROM workflow_delivery_contract_episode
					  WHERE attempt_id = ?`,
				)
				.get("flywheel:FLY-2324:mailbox:ancient-mailbox:g2:a1"),
		).toEqual({ count: 0 });
	});

	it("re-arms an ancient terminal-recipient source for a new run so FLY-2278 can recover it", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"terminal-legacy-recipient",
			"terminal-legacy-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"terminal-legacy-mailbox",
			"flywheel-eng-lead",
			"terminal-legacy-recipient",
			"historical instruction",
		);
		rawCommDb(commDb)
			.prepare(
				`UPDATE mailbox
				    SET created_at = ?, delivered_at = ?, notified_at = ?, state = 'LEASED'
				  WHERE id = ?`,
			)
			.run(
				"2026-01-01T00:00:00.000Z",
				"2026-01-01T00:00:10.000Z",
				"2026-01-01T00:00:20.000Z",
				"terminal-legacy-mailbox",
			);

		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "terminal-legacy-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "running",
		});
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass("2026-01-01T00:01:00.000Z").minted).toBe(1);
		store.upsertSession({
			execution_id: "terminal-legacy-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "completed",
		});
		commDb.markSessionTerminalStatus("terminal-legacy-recipient", "completed");
		expect(projector.runPass("2026-09-04T08:00:00.000Z").advanced).toBe(1);
		store.createWorkflowRun({
			runId: "run-new-for-terminal-recipient",
			issueId: "FLY-2324",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});

		expect(projector.runPass("2026-09-04T08:10:00.000Z")).toEqual({
			examined: 1,
			minted: 1,
			advanced: 1,
		});
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([
			expect.objectContaining({
				generation: 2,
				minted_at: "2026-09-04T08:10:00.000Z",
			}),
		]);
		expect(
			rawStateDb(store)
				.prepare(
					`SELECT count(*) AS attempts,
				            count(superseded_by_attempt_id) AS superseded
				       FROM workflow_delivery_attempt
				      WHERE root_id = ?`,
				)
				.get("flywheel:FLY-2324:mailbox:terminal-legacy-mailbox"),
		).toEqual({ attempts: 2, superseded: 1 });
		expect(
			new DeliveryContractWatch({
				store,
				commDb,
				projectName: "flywheel",
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			}).runPass("2026-09-04T08:10:00.001Z"),
		).toEqual({ observed: 1, opened: 1, closed: 0, alerted: 0 });
		expect(
			rawStateDb(store)
				.prepare(
					`SELECT stage FROM workflow_delivery_contract_episode
					  WHERE attempt_id = ?`,
				)
				.get("flywheel:FLY-2324:mailbox:terminal-legacy-mailbox:g2:a1"),
		).toEqual({ stage: "undeliverable" });
	});

	it("closes a live recent source immediately when its bound run terminates", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"terminated-run-recipient",
			"terminated-run-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"terminated-run-mailbox",
			"flywheel-eng-lead",
			"terminated-run-recipient",
			"bound delivery",
		);

		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-now-terminated",
			issueId: "FLY-2324",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.upsertSession({
			execution_id: "terminated-run-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "running",
		});
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass("2026-09-04T08:00:00.000Z").minted).toBe(1);
		const attempt = store.listLiveWorkflowDeliveryAttempts()[0]!;
		expect(
			store.observeWorkflowDeliveryContract({
				attempt,
				classification: {
					stage: "minted",
					stageEnteredAt: "2026-09-04T08:00:00.000Z",
					terminal: null,
					overdue: true,
					severe: false,
				},
				runId: "run-now-terminated",
				projectName: "flywheel",
				issueId: "FLY-2324",
				now: "2026-09-04T08:01:00.000Z",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}).opened,
		).toBe(1);
		rawStateDb(store)
			.prepare("UPDATE workflow_run SET status = 'terminated' WHERE run_id = ?")
			.run("run-now-terminated");

		expect(projector.runPass("2026-09-04T08:02:00.000Z")).toEqual({
			examined: 1,
			minted: 0,
			advanced: 1,
		});
		expect(
			rawStateDb(store)
				.prepare(
					`SELECT attempt.settlement_reason, episode.closed_reason
					   FROM workflow_delivery_attempt attempt
					   JOIN workflow_delivery_contract_episode episode
					     ON episode.attempt_id = attempt.attempt_id`,
				)
				.get(),
		).toEqual({
			settlement_reason: "legacy_unreachable",
			closed_reason: "legacy_unreachable",
		});
	});

	it("watch closes legacy stock without relying on a preceding projector pass", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"watch-terminal-recipient",
			"watch-terminal-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.insertInstructionWithId(
			"watch-terminal-mailbox",
			"flywheel-eng-lead",
			"watch-terminal-recipient",
			"pre-existing stock",
		);
		commDb.markSessionTerminalStatus("watch-terminal-recipient", "completed");

		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "watch-terminal-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "completed",
		});
		const rootId = "flywheel:FLY-2324:mailbox:watch-terminal-mailbox";
		const attemptId = `${rootId}:g1:a1`;
		store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "mailbox",
			contractRef: { table: "mailbox", pk: "watch-terminal-mailbox" },
			mintedAt: "2026-09-01T00:00:00.000Z",
		});
		const attempt = store.listLiveWorkflowDeliveryAttempts()[0]!;
		store.observeWorkflowDeliveryContract({
			attempt,
			classification: {
				stage: "minted",
				stageEnteredAt: "2026-09-01T00:00:00.000Z",
				terminal: null,
				overdue: true,
				severe: true,
			},
			runId: null,
			projectName: "flywheel",
			issueId: "FLY-2324",
			now: "2026-09-04T07:59:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			enqueueUnboundAlert: ({ eventId }) => ({ eventId, state: "sent" }),
		});
		const alertIds: string[] = [];

		new DeliveryContractWatch({
			store,
			commDb,
			projectName: "flywheel",
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
			enqueueUnboundAlert: ({ eventId }) => {
				alertIds.push(eventId);
				return { eventId, state: "sent" };
			},
		}).runPass("2026-09-04T08:00:00.000Z");

		expect(
			rawStateDb(store)
				.prepare(
					`SELECT attempt.settlement_reason, episode.closed_reason
					   FROM workflow_delivery_attempt attempt
					   JOIN workflow_delivery_contract_episode episode
					     ON episode.attempt_id = attempt.attempt_id`,
				)
				.get(),
		).toEqual({
			settlement_reason: "legacy_unreachable",
			closed_reason: "legacy_unreachable",
		});
		expect(alertIds).toEqual([]);
	});

	it("watch closes a legacy versionless rework attempt", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-versionless-watch",
			issueId: "FLY-2324",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.upsertSession({
			execution_id: "versionless-rework-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "worker",
		});
		store.upsertWorkflowRunNode({
			runId: "run-versionless-watch",
			nodeId: "worker",
			attempt: 1,
			state: "done",
			executionId: "versionless-rework-recipient",
		});
		const db = rawStateDb(store);
		db.prepare(
			`INSERT INTO workflow_actor
			   (execution_id, project_name, issue_id, role, created_at)
			 VALUES ('versionless-rework-recipient', 'flywheel', 'FLY-2324',
			         'worker', '2026-09-01T00:00:00.000Z')`,
		).run();
		db.prepare(
			`INSERT INTO workflow_rework_request
			   (request_id, run_id, source_event_id, authority, source_node_id,
			    source_attempt, base_revision, authority_context_json,
			    authority_context_digest, requested_at)
			 VALUES ('versionless-rework', 'run-versionless-watch',
			         'versionless-rework-event', 'engine', 'worker', 1,
			         'base', '{}', 'digest', '2026-09-01T00:00:00.000Z')`,
		).run();
		db.prepare(
			`INSERT INTO workflow_rework_route_revision
			   (request_id, revision, target_node_id, target_attempt,
			    preferred_actor_execution_id, invalidation_scope_json,
			    verification_policy_json, interpreted_by, interpretation_reason,
			    created_at)
			 VALUES ('versionless-rework', 1, 'worker', 1,
			         'versionless-rework-recipient', '[]', '{}', 'test',
			         'legacy fixture', '2026-09-01T00:00:00.000Z')`,
		).run();
		db.prepare(
			`INSERT INTO workflow_rework_delivery
			   (request_id, route_revision, state, updated_at)
			 VALUES ('versionless-rework', 1, 'awaiting_receipt',
			         '2026-09-01T00:00:00.000Z')`,
		).run();
		const rootId = "flywheel:FLY-2324:rework:versionless-rework";
		const attemptId = `${rootId}:g1:a1`;
		store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "rework",
			contractRef: {
				table: "workflow_rework_delivery",
				pk: "versionless-rework",
			},
			mintedAt: "2026-09-01T00:00:00.000Z",
		});
		store.observeWorkflowDeliveryContract({
			attempt: store.listLiveWorkflowDeliveryAttempts()[0]!,
			classification: {
				stage: "minted",
				stageEnteredAt: "2026-09-01T00:00:00.000Z",
				terminal: null,
				overdue: true,
				severe: true,
			},
			runId: "run-versionless-watch",
			projectName: "flywheel",
			issueId: "FLY-2324",
			now: "2026-09-04T07:59:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		});
		db.prepare(
			"UPDATE workflow_run SET status = 'terminated' WHERE run_id = ?",
		).run("run-versionless-watch");

		expect(
			new DeliveryContractWatch({
				store,
				projectName: "flywheel",
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			}).runPass("2026-09-04T08:00:00.000Z"),
		).toEqual({ observed: 1, opened: 0, closed: 1, alerted: 0 });
		expect(
			db
				.prepare(
					`SELECT attempt.settlement_reason, episode.closed_reason
				   FROM workflow_delivery_attempt attempt
				   JOIN workflow_delivery_contract_episode episode
				     ON episode.attempt_id = attempt.attempt_id
				  WHERE attempt.attempt_id = ?`,
				)
				.get(attemptId),
		).toEqual({
			settlement_reason: "legacy_unreachable",
			closed_reason: "legacy_unreachable",
		});
	});

	it("does not mint an unbound phase wake whose StateStore recipient is terminal", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"legacy-phase-recipient",
			"legacy-phase-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.enqueueRunnerPhaseWake(
			"legacy-phase-recipient",
			{
				id: "legacy-phase-wake",
				to: "legacy-phase-recipient",
				content: "historical phase wake",
				metadata: {},
			},
			Date.parse("2026-09-01T00:00:00.000Z"),
		);
		commDb.markSessionTerminalStatus("legacy-phase-recipient", "completed");

		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "legacy-phase-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "completed",
		});

		expect(
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-04T08:00:00.000Z"),
		).toEqual({ examined: 1, minted: 0, advanced: 0 });
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([]);
	});

	it("does not mint an unbound turn wake whose StateStore recipient is terminal", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"legacy-turn-recipient",
			"legacy-turn-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		commDb.enqueueTurnWake({
			wakeId: "legacy-turn-wake",
			executionId: "legacy-turn-recipient",
			issueId: "FLY-2324",
			epoch: 1,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "historical turn wake" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-01T00:00:00.000Z"),
		});
		commDb.markSessionTerminalStatus("legacy-turn-recipient", "completed");

		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "legacy-turn-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "completed",
		});

		expect(
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-04T08:00:00.000Z"),
		).toEqual({ examined: 1, minted: 0, advanced: 0 });
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([]);
	});

	it("closes a live-recipient orphan at the seven-day boundary but not one millisecond before", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"orphan-live-recipient",
			"orphan-live-window",
			"flywheel",
			"FLY-2324",
			"flywheel-eng-lead",
		);
		for (const id of ["orphan-at-boundary", "orphan-before-boundary"]) {
			commDb.insertInstructionWithId(
				id,
				"flywheel-eng-lead",
				"orphan-live-recipient",
				id,
			);
		}
		const commRaw = rawCommDb(commDb);
		commRaw
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-09-01T00:00:00.000Z", "orphan-at-boundary");
		commRaw
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-09-01T00:00:00.001Z", "orphan-before-boundary");

		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "orphan-live-recipient",
			issue_id: "FLY-2324",
			issue_identifier: "FLY-2324",
			project_name: "flywheel",
			status: "running",
		});

		expect(
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-08T00:00:00.000Z"),
		).toEqual({ examined: 2, minted: 1, advanced: 0 });
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.map((attempt) => JSON.parse(attempt.contract_ref_json).pk),
		).toEqual(["orphan-before-boundary"]);
	});

	it("keeps recent delivery observable after an authorized Linear terminal transition", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		for (const authority of ["unauthorized", "authorized"] as const) {
			commDb.registerSession(
				`${authority}-terminal-issue-recipient`,
				`${authority}-terminal-issue-window`,
				"flywheel",
				`FLY-${authority === "authorized" ? "2324" : "2325"}`,
				"flywheel-eng-lead",
			);
			commDb.insertInstructionWithId(
				`${authority}-terminal-issue-mailbox`,
				"flywheel-eng-lead",
				`${authority}-terminal-issue-recipient`,
				`recent instruction for a ${authority} Done issue`,
			);
			rawCommDb(commDb)
				.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
				.run("2026-09-04T07:59:00.000Z", `${authority}-terminal-issue-mailbox`);
		}

		const store = await StateStore.create(":memory:");
		stores.push(store);
		const unauthorizedIssueUuid = "11111111-2222-4333-8444-555555555555";
		const authorizedIssueUuid = "66666666-7777-4888-8999-aaaaaaaaaaaa";
		for (const [authority, issueUuid, issueIdentifier] of [
			["unauthorized", unauthorizedIssueUuid, "FLY-2325"],
			["authorized", authorizedIssueUuid, "FLY-2324"],
		] as const) {
			store.upsertSession({
				execution_id: `${authority}-terminal-issue-recipient`,
				issue_id: issueUuid,
				issue_identifier: issueIdentifier,
				project_name: "flywheel",
				status: authority === "authorized" ? "approved" : "running",
			});
		}
		store.observeLinearStateAndClaimCloseout({
			project: "flywheel",
			issueUuid: authorizedIssueUuid,
			stateType: "started",
			linearUpdatedAt: "2026-09-04T07:57:00.000Z",
		});
		store.observeLinearStateAndClaimCloseout({
			project: "flywheel",
			issueUuid: authorizedIssueUuid,
			stateType: "completed",
			linearUpdatedAt: "2026-09-04T07:58:00.000Z",
		});
		store.observeLinearStateAndClaimCloseout({
			project: "flywheel",
			issueUuid: unauthorizedIssueUuid,
			stateType: "completed",
			linearUpdatedAt: "2026-09-04T07:58:00.000Z",
		});

		expect(
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass("2026-09-04T08:00:00.000Z"),
		).toEqual({ examined: 2, minted: 2, advanced: 0 });
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.map((attempt) => JSON.parse(attempt.contract_ref_json).pk)
				.sort(),
		).toEqual([
			"authorized-terminal-issue-mailbox",
			"unauthorized-terminal-issue-mailbox",
		]);
	});
});
