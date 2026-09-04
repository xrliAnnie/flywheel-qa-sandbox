import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];
const roots: string[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const db of commDbs.splice(0)) db.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

const resolveAlertIdentity = ({ projectName }: { projectName: string }) => ({
	leadId: "lead-fly2248",
	projectName,
	leadResolution: "resolved" as const,
});
const enqueueUnboundAlert = (payload: { eventId: string }) => ({
	eventId: payload.eventId,
	state: "sent" as const,
});

describe("FLY-2248 R6#2 projector crash-window recovery", () => {
	it("keeps terminal-unacked CommDB obligations live until consumed or explicitly replaced", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		for (const executionId of [
			"runner-live",
			"runner-blocked",
			"runner-timeout",
			"runner-terminal",
		]) {
			commDb.registerSession(
				executionId,
				`${executionId}-window`,
				"flywheel",
				"FLY-2248",
				"lead-a",
			);
		}
		const raw = (commDb as unknown as { db: Database.Database }).db;
		raw
			.prepare(
				"UPDATE sessions SET status = 'completed' WHERE execution_id = ?",
			)
			.run("runner-terminal");
		raw
			.prepare("UPDATE sessions SET status = 'blocked' WHERE execution_id = ?")
			.run("runner-blocked");
		raw
			.prepare("UPDATE sessions SET status = 'timeout' WHERE execution_id = ?")
			.run("runner-timeout");
		for (const [id, executionId] of [
			["mailbox-live", "runner-live"],
			["mailbox-blocked", "runner-blocked"],
			["mailbox-timeout", "runner-timeout"],
			["mailbox-terminal", "runner-terminal"],
			["mailbox-dead", "runner-live"],
			["mailbox-superseded", "runner-live"],
		] as const) {
			commDb.insertInstructionWithId(id, "lead-a", executionId, id);
		}
		raw
			.prepare("UPDATE mailbox SET state = 'LEASED' WHERE id = ?")
			.run("mailbox-terminal");
		raw
			.prepare(
				"UPDATE mailbox SET state = 'DEAD', dead_reason = 'recipient_terminal' WHERE id = ?",
			)
			.run("mailbox-dead");
		raw
			.prepare("UPDATE mailbox SET superseded_by = 'replacement' WHERE id = ?")
			.run("mailbox-superseded");
		for (const executionId of [
			"runner-live",
			"runner-blocked",
			"runner-timeout",
			"runner-terminal",
		]) {
			commDb.enqueueRunnerPhaseWake(
				executionId,
				{
					id: `phase-${executionId}`,
					to: executionId,
					content: `wake ${executionId}`,
					metadata: {},
				},
				Date.parse("2026-09-02T05:02:00.000Z"),
			);
			commDb.enqueueTurnWake({
				wakeId: `turn-${executionId}`,
				executionId,
				issueId: "FLY-2248",
				epoch: 1,
				purpose: "workflow_transition",
				envelope: { fromAgent: "bridge", content: `turn ${executionId}` },
				backend: "codex",
				createdAtMs: Date.parse("2026-09-02T05:03:00.000Z"),
			});
		}
		commDb.enqueueTurnWake({
			wakeId: "turn-cancelled",
			executionId: "runner-live",
			issueId: "FLY-2248",
			epoch: 2,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "cancelled turn" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-02T05:04:00.000Z"),
		});
		expect(commDb.cancelTurnWake("turn-cancelled", "superseded")).toBe(true);

		const store = await StateStore.create(":memory:");
		stores.push(store);
		const result = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		}).runPass("2026-09-02T05:05:00.000Z");

		expect(result).toEqual({ examined: 15, minted: 15, advanced: 2 });
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.map((attempt) => JSON.parse(attempt.contract_ref_json).pk)
				.sort(),
		).toEqual([
			"mailbox-blocked",
			"mailbox-dead",
			"mailbox-live",
			"mailbox-terminal",
			"mailbox-timeout",
			"phase-runner-blocked",
			"phase-runner-live",
			"phase-runner-terminal",
			"phase-runner-timeout",
			"turn-runner-blocked",
			"turn-runner-live",
			"turn-runner-terminal",
			"turn-runner-timeout",
		]);
	});

	it("does not settle on recipient terminal and closes all episodes on physical terminal", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"runner-terminal-transition",
			"terminal-transition-window",
			"flywheel",
			"FLY-2248",
			"lead-a",
		);
		commDb.insertInstructionWithId(
			"mailbox-terminal-transition",
			"lead-a",
			"runner-terminal-transition",
			"deliver before exit",
		);
		commDb.enqueueRunnerPhaseWake(
			"runner-terminal-transition",
			{
				id: "phase-terminal-transition",
				to: "runner-terminal-transition",
				content: "phase before exit",
				metadata: {},
			},
			Date.parse("2026-09-02T05:00:00.000Z"),
		);
		commDb.enqueueTurnWake({
			wakeId: "turn-terminal-transition",
			executionId: "runner-terminal-transition",
			issueId: "FLY-2248",
			epoch: 1,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "turn before exit" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-02T05:00:00.000Z"),
		});
		const raw = (commDb as unknown as { db: Database.Database }).db;
		raw
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-09-02T05:00:00.000Z", "mailbox-terminal-transition");
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		const watch = new DeliveryContractWatch({
			store,
			projectName: "flywheel",
			resolveAlertIdentity,
			enqueueUnboundAlert,
		});
		expect(projector.runPass("2026-09-02T05:01:00.000Z")).toEqual({
			examined: 3,
			minted: 3,
			advanced: 0,
		});
		expect(watch.runPass("2026-09-02T05:11:00.000Z")).toEqual({
			observed: 3,
			opened: 3,
			closed: 0,
			alerted: 3,
		});
		raw
			.prepare(
				"UPDATE sessions SET status = 'completed' WHERE execution_id = ?",
			)
			.run("runner-terminal-transition");
		raw
			.prepare(
				"UPDATE mailbox SET state = 'DEAD', dead_reason = 'recipient_terminal' WHERE id = ?",
			)
			.run("mailbox-terminal-transition");

		expect(projector.runPass("2026-09-02T05:12:00.000Z")).toEqual({
			examined: 3,
			minted: 0,
			advanced: 0,
		});
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.map(({ family }) => family)
				.sort(),
		).toEqual(["mailbox", "phase_wake", "turn_wake"]);

		raw
			.prepare("UPDATE mailbox SET state = 'ACKED', acked_at = ? WHERE id = ?")
			.run("2026-09-02T05:13:00.000Z", "mailbox-terminal-transition");
		expect(
			commDb.markRunnerPhaseWakeStarted(
				"runner-terminal-transition",
				"phase-terminal-transition",
				Date.parse("2026-09-02T05:13:00.000Z"),
			),
		).toBe(true);
		expect(
			commDb.finishRunnerPhaseWake(
				"runner-terminal-transition",
				"phase-terminal-transition",
				Date.parse("2026-09-02T05:13:00.000Z"),
			),
		).toBe(true);
		expect(
			commDb.cancelTurnWake("turn-terminal-transition", "explicit-test-cancel"),
		).toBe(true);
		expect(projector.runPass("2026-09-02T05:14:00.000Z")).toEqual({
			examined: 3,
			minted: 0,
			advanced: 7,
		});
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([]);
		expect(
			rawDb(store)
				.prepare(
					`SELECT count(*) AS count
					   FROM workflow_delivery_contract_episode episode
					   JOIN workflow_delivery_attempt attempt
					     ON attempt.attempt_id = episode.attempt_id
					  WHERE attempt.settlement_reason = 'source_terminal'
					    AND episode.closed_at = '2026-09-02T05:14:00.000Z'
					    AND episode.closed_reason = 'terminal:settled:source_terminal'`,
				)
				.get(),
		).toEqual({ count: 3 });
	});

	it("FLY-2307 A closes an unbound received launch episode after its run terminates without a binding", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-terminal-launch",
			issueId: "FLY-2307",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.upsertWorkflowRunNode({
			runId: "run-terminal-launch",
			nodeId: "worker",
			attempt: 1,
			state: "running",
			executionId: "terminal-launch-exec",
		});
		store.upsertSession({
			execution_id: "terminal-launch-exec",
			issue_id: "FLY-2307",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		const attemptId = "flywheel:FLY-2307:launch:terminal-launch-exec:g1:a1";
		rawDb(store)
			.prepare(
				`INSERT INTO workflow_delivery_attempt (
				   root_id, generation, attempt, attempt_id, family,
				   contract_ref_json, minted_at, granted_at, sent_at, received_at
				 ) VALUES (?, 1, 1, ?, 'launch', ?, ?, ?, ?, ?)`,
			)
			.run(
				"flywheel:FLY-2307:launch:terminal-launch-exec",
				attemptId,
				JSON.stringify({
					table: "workflow_execution_binding",
					pk: "terminal-launch-exec",
					runId: "run-terminal-launch",
				}),
				"2026-09-02T05:00:00.000Z",
				"2026-09-02T05:00:00.000Z",
				"2026-09-02T05:00:00.000Z",
				"2026-09-02T05:00:00.000Z",
			);
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find(({ family }) => family === "launch");
		expect(attempt).toBeDefined();
		expect(JSON.parse(attempt!.contract_ref_json)).toMatchObject({
			table: "workflow_execution_binding",
			pk: "terminal-launch-exec",
			runId: "run-terminal-launch",
		});
		rawDb(store)
			.prepare("UPDATE workflow_run SET status = 'completed' WHERE run_id = ?")
			.run("run-terminal-launch");
		store.upsertWorkflowRunNode({
			runId: "run-terminal-launch",
			nodeId: "worker",
			attempt: 1,
			state: "done",
			endedAt: "2026-09-02T05:29:00.000Z",
		});
		rawDb(store)
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run("terminal-launch-exec");
		expect(store.getWorkflowRun("run-terminal-launch")?.status).toBe(
			"completed",
		);
		expect(
			store.getWorkflowRunNode("run-terminal-launch", "worker", 1),
		).toMatchObject({
			state: "done",
			ended_at: "2026-09-02T05:29:00.000Z",
		});
		expect(store.getSession("terminal-launch-exec")).toBeUndefined();
		expect(
			store.getWorkflowExecutionBinding("terminal-launch-exec"),
		).toBeUndefined();
		const unboundEvents: string[] = [];
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		const watch = new DeliveryContractWatch({
			store,
			projectName: "flywheel",
			resolveAlertIdentity,
			enqueueUnboundAlert: ({ eventId }) => {
				unboundEvents.push(eventId);
				return { eventId, state: "sent" };
			},
		});
		expect(watch.runPass("2026-09-02T05:30:00.001Z")).toEqual({
			observed: 1,
			opened: 1,
			closed: 0,
			alerted: 1,
		});
		expect(unboundEvents).toHaveLength(1);
		expect(
			rawDb(store)
				.prepare(
					`SELECT stage, run_id, closed_at
					   FROM workflow_delivery_contract_episode
					  WHERE attempt_id = ?`,
				)
				.get(attempt!.attempt_id),
		).toEqual({ stage: "received", run_id: null, closed_at: null });
		expect(
			rawDb(store)
				.prepare(
					`SELECT count(*) AS count
					   FROM workflow_delivery_contract_episode
					  WHERE attempt_id = ? AND run_id IS NOT NULL`,
				)
				.get(attempt!.attempt_id),
		).toEqual({ count: 0 });

		expect(projector.runPass("2026-09-02T05:31:00.000Z")).toEqual({
			examined: 0,
			minted: 0,
			advanced: 1,
		});
		expect(watch.runPass("2026-09-02T05:31:00.001Z")).toEqual({
			observed: 0,
			opened: 0,
			closed: 0,
			alerted: 0,
		});
		expect(unboundEvents).toHaveLength(1);
		expect(
			rawDb(store)
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE family = 'launch'",
				)
				.get(),
		).toMatchObject({ settlement_reason: "run_terminal" });
		expect(
			rawDb(store)
				.prepare(
					"SELECT closed_at, closed_reason FROM workflow_delivery_contract_episode WHERE family = 'launch'",
				)
				.get(),
		).toEqual({
			closed_at: "2026-09-02T05:31:00.000Z",
			closed_reason: "terminal:settled:run_terminal",
		});
	});

	it("FLY-2307 B keeps an active received launch stall open through severe escalation", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-active-launch",
			issueId: "FLY-2248",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		expect(
			store.admitWorkflowExecution({
				runId: "run-active-launch",
				nodeId: "worker",
				executionId: "active-launch-exec",
				attempt: 1,
				family: "review_verdict",
				expiresAt: "2026-09-02T06:00:00.000Z",
				absoluteDeadlineAt: "2026-09-02T07:00:00.000Z",
				now: "2026-09-02T05:00:00.000Z",
			}),
		).toMatchObject({ ok: true });
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find(({ family }) => family === "launch");
		expect(attempt).toBeDefined();
		expect(JSON.parse(attempt!.contract_ref_json)).toMatchObject({
			table: "workflow_execution_binding",
			pk: "active-launch-exec",
			runId: "run-active-launch",
		});
		rawDb(store)
			.prepare(
				"UPDATE workflow_delivery_attempt SET received_at = ? WHERE attempt_id = ?",
			)
			.run("2026-09-02T05:00:00.000Z", attempt!.attempt_id);

		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		const watch = new DeliveryContractWatch({
			store,
			projectName: "flywheel",
			resolveAlertIdentity,
			enqueueUnboundAlert,
		});
		expect(projector.runPass("2026-09-02T05:30:00.000Z")).toEqual({
			examined: 0,
			minted: 0,
			advanced: 0,
		});
		expect(watch.runPass("2026-09-02T05:30:00.001Z")).toEqual({
			observed: 1,
			opened: 1,
			closed: 0,
			alerted: 1,
		});
		expect(watch.runPass("2026-09-02T06:30:00.001Z")).toEqual({
			observed: 1,
			opened: 0,
			closed: 0,
			alerted: 1,
		});
		expect(
			rawDb(store)
				.prepare(
					`SELECT stage, run_id, alerted_at, severe_alerted_at, closed_at
					   FROM workflow_delivery_contract_episode
					  WHERE attempt_id = ?`,
				)
				.get(attempt!.attempt_id),
		).toEqual({
			stage: "received",
			run_id: "run-active-launch",
			alerted_at: "2026-09-02T05:30:00.001Z",
			severe_alerted_at: "2026-09-02T06:30:00.001Z",
			closed_at: null,
		});
		expect(
			store
				.listWorkflowAlertOutbox()
				.map(({ payload }) => payload.severity)
				.sort(),
		).toEqual(["severe", "warning"]);
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.find(({ family }) => family === "launch"),
		).toMatchObject({ settlement_reason: null });
		expect(store.getWorkflowRun("run-active-launch")?.status).toBe("active");
	});

	it("observes an orphan attempt even when its CommDB row was never written", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const rootId = "flywheel:FLY-2248:orphan-mailbox-intent";
		rawDb(store)
			.prepare(
				`INSERT INTO workflow_delivery_attempt (
				   root_id, generation, attempt, attempt_id, family,
				   contract_ref_json, minted_at
				 ) VALUES (?, 1, 1, ?, 'mailbox', ?, ?)`,
			)
			.run(
				rootId,
				`${rootId}:g1:a1`,
				JSON.stringify({ table: "mailbox", pk: "orphan-mailbox-intent" }),
				"2026-09-02T05:00:00.000Z",
			);

		expect(
			new DeliveryContractWatch({
				store,
				resolveAlertIdentity,
				enqueueUnboundAlert,
			}).runPass("2026-09-02T05:10:00.001Z"),
		).toEqual({ observed: 1, opened: 1, closed: 0, alerted: 1 });
		expect(
			rawDb(store)
				.prepare(
					"SELECT stage FROM workflow_delivery_contract_episode WHERE root_id = ?",
				)
				.get(rootId),
		).toEqual({ stage: "minted" });
	});

	it("reconstructs exact mailbox and phase-wake g1 identities from immutable source timestamps", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2248-r6-projector-"));
		roots.push(root);
		const dbPath = join(root, "comm.db");
		const commDb = new CommDB(dbPath);
		commDbs.push(commDb);
		commDb.registerSession(
			"runner-projection",
			"projection-window",
			"flywheel",
			"FLY-2248",
			"lead-a",
		);
		commDb.insertInstructionWithId(
			"mailbox-window-b",
			"lead-a",
			"runner-projection",
			"Recover this row",
		);
		const queuedAt = Date.parse("2026-09-02T05:02:00.000Z");
		commDb.enqueueRunnerPhaseWake(
			"runner-projection",
			{
				id: "phase-window-b",
				to: "runner-projection",
				content: "Recover this wake",
				metadata: {},
			},
			queuedAt,
		);
		const raw = new Database(dbPath);
		raw
			.prepare("UPDATE mailbox SET created_at = ? WHERE id = ?")
			.run("2026-09-02T05:01:00.000Z", "mailbox-window-b");
		raw.close();
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});

		expect(projector.runPass("2026-09-02T05:03:00.000Z")).toEqual({
			examined: 2,
			minted: 2,
			advanced: 0,
		});
		const attempts = store.listLiveWorkflowDeliveryAttempts();
		const mailbox = attempts.find(({ family }) => family === "mailbox")!;
		expect(mailbox).toMatchObject({
			root_id: "flywheel:FLY-2248:mailbox:mailbox-window-b",
			attempt_id: "flywheel:FLY-2248:mailbox:mailbox-window-b:g1:a1",
			minted_at: "2026-09-02T05:01:00.000Z",
		});
		expect(JSON.parse(mailbox.contract_ref_json)).toEqual({
			table: "mailbox",
			pk: "mailbox-window-b",
		});
		const phaseWake = attempts.find(({ family }) => family === "phase_wake")!;
		expect(phaseWake).toMatchObject({
			root_id: "flywheel:FLY-2248:phase_wake:phase-window-b",
			attempt_id: "flywheel:FLY-2248:phase_wake:phase-window-b:g1:a1",
			minted_at: "2026-09-02T05:02:00.000Z",
		});
		expect(JSON.parse(phaseWake.contract_ref_json)).toEqual({
			table: "runner_phase_wakes",
			pk: "phase-window-b",
		});
		expect(projector.runPass("2026-09-02T05:04:00.000Z")).toEqual({
			examined: 2,
			minted: 0,
			advanced: 0,
		});
	});

	it("projects TURN wake mint, send, and receipt clocks from the durable outbox", async () => {
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"runner-turn-projection",
			"turn-projection-window",
			"flywheel",
			"FLY-2248",
			"lead-a",
		);
		const createdAt = Date.parse("2026-09-02T05:10:00.000Z");
		const sentAt = Date.parse("2026-09-02T05:11:00.000Z");
		const receivedAt = Date.parse("2026-09-02T05:12:00.000Z");
		commDb.enqueueTurnWake({
			wakeId: "turn-window-c",
			executionId: "runner-turn-projection",
			issueId: "FLY-2248",
			epoch: 3,
			activationId: "activation-turn-projection",
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "Resume the runner" },
			backend: "codex",
			createdAtMs: createdAt,
		});
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});

		expect(projector.runPass("2026-09-02T05:10:30.000Z")).toEqual({
			examined: 1,
			minted: 1,
			advanced: 0,
		});
		const rootId = "flywheel:FLY-2248:turn_wake:turn-window-c";
		expect(store.listLiveWorkflowDeliveryAttempts()).toContainEqual(
			expect.objectContaining({
				root_id: rootId,
				attempt_id: `${rootId}:g1:a1`,
				family: "turn_wake",
				minted_at: "2026-09-02T05:10:00.000Z",
			}),
		);

		const claim = commDb.claimDueTurnWake({
			nowMs: sentAt,
			retryAfterMs: 60_000,
			leaseMs: 10_000,
		});
		expect(claim).not.toBeNull();
		commDb.finishTurnWakePush({
			wakeId: "turn-window-c",
			claimToken: claim!.claim_token!,
			pushedAtMs: sentAt,
			result: "ok",
		});
		expect(projector.runPass("2026-09-02T05:11:30.000Z").advanced).toBe(1);
		commDb.ackTurnWakes({
			executionId: "runner-turn-projection",
			epoch: 3,
			activationId: "activation-turn-projection",
			ackedAtMs: receivedAt,
		});
		expect(projector.runPass("2026-09-02T05:12:30.000Z").advanced).toBe(3);
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([]);
		expect(
			rawDb(store)
				.prepare(
					`SELECT sent_at, received_at, consumed_at, settlement_reason
					   FROM workflow_delivery_attempt WHERE attempt_id = ?`,
				)
				.get(`${rootId}:g1:a1`),
		).toEqual({
			sent_at: "2026-09-02T05:11:00.000Z",
			received_at: "2026-09-02T05:12:00.000Z",
			consumed_at: "2026-09-02T05:12:00.000Z",
			settlement_reason: "source_terminal",
		});
	});
});
