import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

const databases: CommDB[] = [];

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

describe("FLY-2248 generic CommDB delivery reroute", () => {
	it("reroutes a phase wake with deterministic lineage and retires its source", () => {
		const db = new CommDB(":memory:");
		databases.push(db);
		db.registerSession("recipient-old", "old", "flywheel", "FLY-2248", "lead");
		db.registerSession(
			"recipient-next",
			"next",
			"flywheel",
			"FLY-2248",
			"lead",
		);
		db.enqueueRunnerPhaseWake(
			"recipient-old",
			{
				id: "phase-source",
				to: "recipient-old",
				content: "Continue the workflow",
				metadata: { purpose: "resume" },
			},
			Date.parse("2026-09-02T06:00:00.000Z"),
		);
		const rootId = "flywheel:FLY-2248:phase_wake:phase-source";
		const parentAttemptId = `${rootId}:g1:a1`;
		const childId = `phase_wake:reroute:${rootId}:g2`;
		const input = {
			sourceId: "phase-source",
			childId,
			rootId,
			parentAttemptId,
			targetExecutionId: "recipient-next",
			now: "2026-09-02T06:01:00.000Z",
		};

		expect(db.rerouteRunnerPhaseWake(input)).toEqual({ inserted: true });
		expect(db.rerouteRunnerPhaseWake(input)).toEqual({ inserted: false });
		expect(db.listRunnerPhaseWakes("recipient-old")).toContainEqual(
			expect.objectContaining({
				message_id: "phase-source",
				state: "finished",
				t2_result: `rerouted:${parentAttemptId}`,
			}),
		);
		expect(db.listRunnerPhaseWakes("recipient-next")).toContainEqual(
			expect.objectContaining({
				message_id: childId,
				state: "pending",
				content: "Continue the workflow",
				metadata_json: JSON.stringify({
					purpose: "resume",
					rootId,
					parentAttemptId,
				}),
			}),
		);
	});

	it("reroutes a TURN wake to the target's current fenced activation", () => {
		const db = new CommDB(":memory:");
		databases.push(db);
		db.registerSession("recipient-old", "old", "flywheel", "FLY-2248", "lead");
		db.registerSession(
			"recipient-next",
			"next",
			"flywheel",
			"FLY-2248",
			"lead",
		);
		const nowMs = Date.parse("2026-09-02T06:10:00.000Z");
		db.grantTurn("FLY-2248", "recipient-next", "general", nowMs, {
			project: "flywheel",
			sourceEventId: "turn-target",
			activation: {
				activationId: "activation-next",
				runId: "run-next",
				nodeId: "general",
				attempt: 2,
				context: { source: "test" },
			},
		});
		db.enqueueTurnWake({
			wakeId: "turn-source",
			executionId: "recipient-old",
			issueId: "FLY-2248",
			epoch: 1,
			activationId: "activation-old",
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "Continue the workflow" },
			backend: "codex",
			createdAtMs: nowMs,
		});
		const rootId = "flywheel:FLY-2248:turn_wake:turn-source";
		const parentAttemptId = `${rootId}:g1:a1`;
		const childId = `turn_wake:reroute:${rootId}:g2`;
		const input = {
			sourceId: "turn-source",
			childId,
			rootId,
			parentAttemptId,
			targetExecutionId: "recipient-next",
			now: "2026-09-02T06:11:00.000Z",
		};

		expect(db.rerouteTurnWake(input)).toEqual({ inserted: true });
		expect(db.rerouteTurnWake(input)).toEqual({ inserted: false });
		expect(db.getTurnWake("turn-source")).toMatchObject({
			state: "cancelled",
			cancel_reason: `rerouted:${parentAttemptId}`,
		});
		expect(db.getTurnWake(childId)).toMatchObject({
			execution_id: "recipient-next",
			epoch: 1,
			activation_id: "activation-next",
			state: "pending",
		});
		expect(JSON.parse(db.getTurnWake(childId)!.envelope_json)).toMatchObject({
			rootId,
			parentAttemptId,
		});
	});
});

describe("FLY-2248 sanctioned CommDB hold recovery", () => {
	it("requeues one recipient's in-flight mailbox batches with a durable receipt", () => {
		const db = new CommDB(":memory:");
		databases.push(db);
		db.registerSession("recipient", "window", "flywheel", "FLY-2248", "lead");
		for (const id of ["mail-hold-1", "mail-hold-2"]) {
			db.insertInstructionWithId(id, "lead", "recipient", `content:${id}`);
		}
		const raw = (db as unknown as { db: Database.Database }).db;
		raw
			.prepare(
				`UPDATE mailbox SET state = 'LEASED', batch_id = 'batch-held',
				   claimed_by = 'worker', claim_expires_at = ? WHERE to_agent = ?`,
			)
			.run("2026-09-02T08:00:00.000Z", "recipient");
		raw
			.prepare("UPDATE mailbox SET last_error = ? WHERE id = ?")
			.run("content_ref_missing", "mail-hold-2");
		const input = {
			sourceId: "mail-hold-1",
			receiptId: "hold-resume:mailbox-1",
			now: "2026-09-02T07:00:00.000Z",
		};

		expect(db.resumeMailboxInflightHold(input)).toEqual({
			idempotentReplay: false,
			requeued: 2,
		});
		expect(db.resumeMailboxInflightHold(input)).toEqual({
			idempotentReplay: true,
			requeued: 2,
		});
		expect(
			raw
				.prepare(
					"SELECT state, batch_id, claim_expires_at, last_error FROM mailbox WHERE to_agent = ? ORDER BY id",
				)
				.all("recipient"),
		).toEqual([
			{
				state: "QUEUED",
				batch_id: null,
				claim_expires_at: null,
				last_error: null,
			},
			{
				state: "QUEUED",
				batch_id: null,
				claim_expires_at: null,
				last_error: "content_ref_missing",
			},
		]);
		expect(
			raw
				.prepare("SELECT event_id FROM mailbox_log WHERE event_id = ?")
				.get(input.receiptId),
		).toEqual({ event_id: input.receiptId });
	});

	it("rearms a stuck TURN wake with an idempotent in-row receipt", () => {
		const db = new CommDB(":memory:");
		databases.push(db);
		db.registerSession("recipient", "window", "flywheel", "FLY-2248", "lead");
		db.enqueueTurnWake({
			wakeId: "turn-held",
			executionId: "recipient",
			issueId: "FLY-2248",
			epoch: 1,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "Resume" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-02T07:10:00.000Z"),
		});
		const raw = (db as unknown as { db: Database.Database }).db;
		raw
			.prepare(
				`UPDATE turn_wake_outbox SET state = 'sent', push_count = 2,
				   first_push_at = ?, last_push_at = ?, last_push_result = 'no_receipt'
				 WHERE wake_id = 'turn-held'`,
			)
			.run(
				Date.parse("2026-09-02T07:11:00.000Z"),
				Date.parse("2026-09-02T07:12:00.000Z"),
			);
		const input = {
			sourceId: "turn-held",
			receiptId: "hold-resume:turn-1",
		};

		expect(db.resumeTurnWakeHold(input)).toEqual({ idempotentReplay: false });
		expect(db.resumeTurnWakeHold(input)).toEqual({ idempotentReplay: true });
		expect(db.getTurnWake("turn-held")).toMatchObject({
			state: "pending",
			push_count: 0,
			first_push_at: null,
			last_push_at: null,
			last_push_result: null,
			cancel_reason: input.receiptId,
		});
	});

	it("treats mailbox and TURN sources already consumed by the runner as successful no-ops", () => {
		const db = new CommDB(":memory:");
		databases.push(db);
		db.registerSession("recipient", "window", "flywheel", "FLY-2278", "lead");
		db.insertInstructionWithId(
			"mail-consumed",
			"lead",
			"recipient",
			"Already consumed",
		);
		db.markInstructionRead("mail-consumed");
		db.enqueueTurnWake({
			wakeId: "turn-consumed",
			executionId: "recipient",
			issueId: "FLY-2278",
			epoch: 1,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "Already acknowledged" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-03T07:10:00.000Z"),
		});
		expect(
			db.ackTurnWakes({
				executionId: "recipient",
				epoch: 1,
				ackedAtMs: Date.parse("2026-09-03T07:11:00.000Z"),
			}),
		).toBe(1);

		expect(
			db.resumeMailboxInflightHold({
				sourceId: "mail-consumed",
				receiptId: "hold-resume:mail-consumed",
				now: "2026-09-03T07:12:00.000Z",
			}),
		).toEqual({ idempotentReplay: false, requeued: 0, noop: true });
		expect(
			db.resumeTurnWakeHold({
				sourceId: "turn-consumed",
				receiptId: "hold-resume:turn-consumed",
			}),
		).toEqual({ idempotentReplay: false, noop: true });
		const raw = (db as unknown as { db: Database.Database }).db;
		expect(
			raw
				.prepare("SELECT state FROM mailbox WHERE id = ?")
				.get("mail-consumed"),
		).toEqual({ state: "ACKED" });
		expect(db.getTurnWake("turn-consumed")).toMatchObject({ state: "acked" });
	});

	it("treats pruned mailbox and cancelled or pruned TURN sources as successful no-ops", () => {
		const db = new CommDB(":memory:");
		databases.push(db);
		db.registerSession("recipient", "window", "flywheel", "FLY-2278", "lead");
		db.enqueueTurnWake({
			wakeId: "turn-cancelled",
			executionId: "recipient",
			issueId: "FLY-2278",
			epoch: 1,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "Cancelled before resume" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-03T07:10:00.000Z"),
		});
		const raw = (db as unknown as { db: Database.Database }).db;
		raw
			.prepare(
				"UPDATE turn_wake_outbox SET state = 'cancelled' WHERE wake_id = ?",
			)
			.run("turn-cancelled");

		expect(
			db.resumeMailboxInflightHold({
				sourceId: "mail-pruned",
				receiptId: "hold-resume:mail-pruned",
				now: "2026-09-03T07:12:00.000Z",
			}),
		).toEqual({ idempotentReplay: false, requeued: 0, noop: true });
		expect(
			db.resumeTurnWakeHold({
				sourceId: "turn-cancelled",
				receiptId: "hold-resume:turn-cancelled",
			}),
		).toEqual({ idempotentReplay: false, noop: true });
		expect(
			db.resumeTurnWakeHold({
				sourceId: "turn-pruned",
				receiptId: "hold-resume:turn-pruned",
			}),
		).toEqual({ idempotentReplay: false, noop: true });
	});
});

describe("FLY-2278 bounded delivery projection", () => {
	it("returns recipient inflight aggregates from a single mailbox lookup", () => {
		const db = new CommDB(":memory:");
		databases.push(db);
		db.registerSession("recipient", "window", "flywheel", "FLY-2339", "lead");
		db.insertInstructionWithId("mail-target", "lead", "recipient", "target");
		db.insertInstructionWithId("mail-peer", "lead", "recipient", "peer");
		const raw = (db as unknown as { db: Database.Database }).db;
		const update = raw.prepare(
			`UPDATE mailbox
			    SET state = 'LEASED', delivered_at = ?, claim_expires_at = ?, batch_id = ?
			  WHERE id = ?`,
		);
		update.run(
			"2026-09-04T20:00:00.000Z",
			"2026-09-04T21:00:00.000Z",
			"batch-a",
			"mail-target",
		);
		update.run(
			"2026-09-04T20:01:00.000Z",
			"2026-09-04T21:00:00.000Z",
			"batch-b",
			"mail-peer",
		);

		expect(
			db.getRunnerDeliveryProjectionRow(
				"mail-target",
				"2026-09-04T20:30:00.000Z",
			),
		).toMatchObject({
			id: "mail-target",
			inflight_batch_count: 2,
			oldest_inflight_delivered_at: "2026-09-04T20:00:00.000Z",
		});
	});

	it("keeps recent terminal clocks visible but excludes terminal history past retention", () => {
		const db = new CommDB(":memory:");
		databases.push(db);
		db.registerSession("recipient", "window", "flywheel", "FLY-2278", "lead");
		for (const id of [
			"mail-live",
			"mail-dead",
			"mail-acked",
			"mail-superseded",
		]) {
			db.insertInstructionWithId(id, "lead", "recipient", id);
		}
		for (const id of ["phase-live", "phase-finished"]) {
			db.enqueueRunnerPhaseWake(
				"recipient",
				{ id, to: "recipient", content: id },
				Date.parse("2026-09-03T08:00:00.000Z"),
			);
		}
		for (const [wakeId, state] of [
			["turn-live", "sent"],
			["turn-acked", "acked"],
			["turn-cancelled", "cancelled"],
		] as const) {
			db.enqueueTurnWake({
				wakeId,
				executionId: "recipient",
				issueId: "FLY-2278",
				epoch: 1,
				purpose: "workflow_transition",
				envelope: { fromAgent: "bridge", content: wakeId },
				backend: "codex",
				createdAtMs: Date.parse("2026-09-03T08:00:00.000Z"),
			});
			const raw = (db as unknown as { db: Database.Database }).db;
			raw
				.prepare("UPDATE turn_wake_outbox SET state = ? WHERE wake_id = ?")
				.run(state, wakeId);
		}
		const raw = (db as unknown as { db: Database.Database }).db;
		raw
			.prepare(
				"UPDATE mailbox SET state = 'DEAD', dead_reason = 'recipient_terminal' WHERE id = ?",
			)
			.run("mail-dead");
		raw
			.prepare("UPDATE mailbox SET state = 'ACKED', acked_at = ? WHERE id = ?")
			.run("2026-09-03T08:01:00.000Z", "mail-acked");
		raw
			.prepare("UPDATE mailbox SET superseded_by = 'replacement' WHERE id = ?")
			.run("mail-superseded");
		raw
			.prepare(
				"UPDATE runner_phase_wakes SET state = 'finished', finished_at = ? WHERE message_id = ?",
			)
			.run(Date.parse("2026-09-03T08:01:00.000Z"), "phase-finished");
		db.markSessionTerminalStatus("recipient", "completed");

		expect(
			db
				.listRunnerDeliveryProjectionRows("2026-09-03T08:02:00.000Z")
				.map(({ id }) => id),
		).toEqual(["mail-live", "mail-dead", "mail-acked", "mail-superseded"]);
		expect(
			db
				.listRunnerPhaseWakeProjectionRows(
					Date.parse("2026-09-03T08:02:00.000Z"),
				)
				.map(({ message_id }) => message_id),
		).toEqual(["phase-live", "phase-finished"]);
		expect(
			db
				.listRunnerTurnWakeProjectionRows(
					Date.parse("2026-09-03T08:02:00.000Z"),
				)
				.map(({ wake_id }) => wake_id),
		).toEqual(["turn-acked", "turn-cancelled", "turn-live"]);
		const mailboxPage = db.listRunnerDeliveryProjectionRows(
			"2026-09-03T08:02:00.000Z",
			{ limit: 2 },
		);
		expect(
			db.listRunnerDeliveryProjectionRows("2026-09-03T08:02:00.000Z", {
				afterSeq: mailboxPage[1]!.seq,
				limit: 2,
			}),
		).toHaveLength(2);
		const phasePage = db.listRunnerPhaseWakeProjectionRows(
			Date.parse("2026-09-03T08:02:00.000Z"),
			{ limit: 1 },
		);
		expect(
			db.listRunnerPhaseWakeProjectionRows(
				Date.parse("2026-09-03T08:02:00.000Z"),
				{ afterQueueSeq: phasePage[0]!.queue_seq, limit: 1 },
			),
		).toHaveLength(1);
		const turnPage = db.listRunnerTurnWakeProjectionRows(
			Date.parse("2026-09-03T08:02:00.000Z"),
			{ limit: 2 },
		);
		expect(
			db.listRunnerTurnWakeProjectionRows(
				Date.parse("2026-09-03T08:02:00.000Z"),
				{ afterQueueSeq: turnPage[1]!.queue_seq, limit: 2 },
			),
		).toHaveLength(1);

		raw
			.prepare(
				`UPDATE mailbox SET created_at = ?, acked_at = CASE WHEN id = 'mail-acked' THEN ? ELSE acked_at END
				  WHERE id IN ('mail-acked','mail-superseded')`,
			)
			.run("2026-08-30T08:00:00.000Z", "2026-08-30T08:01:00.000Z");
		raw
			.prepare(
				"UPDATE runner_phase_wakes SET queued_at = ?, finished_at = ? WHERE message_id = ?",
			)
			.run(
				Date.parse("2026-08-30T08:00:00.000Z"),
				Date.parse("2026-08-30T08:01:00.000Z"),
				"phase-finished",
			);
		raw
			.prepare(
				`UPDATE turn_wake_outbox SET created_at = ?, acked_at = CASE WHEN wake_id = 'turn-acked' THEN ? ELSE acked_at END
				  WHERE wake_id IN ('turn-acked','turn-cancelled')`,
			)
			.run(
				Date.parse("2026-08-30T08:00:00.000Z"),
				Date.parse("2026-08-30T08:01:00.000Z"),
			);
		expect(
			db
				.listRunnerDeliveryProjectionRows("2026-09-03T08:02:00.000Z")
				.map(({ id }) => id),
		).toEqual(["mail-live", "mail-dead"]);
		expect(
			db
				.listRunnerPhaseWakeProjectionRows(
					Date.parse("2026-09-03T08:02:00.000Z"),
				)
				.map(({ message_id }) => message_id),
		).toEqual(["phase-live"]);
		expect(
			db
				.listRunnerTurnWakeProjectionRows(
					Date.parse("2026-09-03T08:02:00.000Z"),
				)
				.map(({ wake_id }) => wake_id),
		).toEqual(["turn-live"]);
		expect(
			db.getRunnerDeliveryProjectionRow(
				"mail-acked",
				"2026-09-03T08:02:00.000Z",
				true,
			),
		).toBeUndefined();
		expect(
			db.getRunnerPhaseWakeProjectionRow(
				"phase-finished",
				Date.parse("2026-09-03T08:02:00.000Z"),
				true,
			),
		).toBeUndefined();
		expect(
			db.getRunnerTurnWakeProjectionRow(
				"turn-acked",
				Date.parse("2026-09-03T08:02:00.000Z"),
				true,
			),
		).toBeUndefined();
		expect(
			db.getRunnerDeliveryProjectionRow(
				"mail-acked",
				"2026-09-03T08:02:00.000Z",
			),
		).toBeDefined();
	});
});
