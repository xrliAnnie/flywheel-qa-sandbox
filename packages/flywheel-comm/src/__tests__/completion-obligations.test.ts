import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check } from "../commands/check.js";
import { inbox } from "../commands/inbox.js";
import {
	type CompletionObligation,
	DRAIN_PAGE_MAX_BYTES,
	DRAIN_PAGE_MAX_LINES,
	paginateUnreadObligations,
	sha256Utf8,
} from "../completion-obligations.js";
import { CommDB, type PhaseWakeInput } from "../db.js";

const EXEC = "exec-1";
const ACTIVATION = "activation:exec-1:run-1:implement:1";

describe("FLY-2373 completion obligations", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly2373-obligations-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function raw(): Database.Database {
		return (db as unknown as { db: Database.Database }).db;
	}

	function registerPhase(executionId = EXEC, phase = true) {
		db.registerSession(
			executionId,
			"flywheel:@1",
			"flywheel",
			"FLY-2373",
			"flywheel-eng-lead",
			"codex",
			phase,
		);
	}

	function leaseBatch(ids: string[], batchId: string, retry = 0): string[] {
		const placeholders = ids.map(() => "?").join(",");
		raw()
			.prepare(
				`UPDATE mailbox
				    SET state = 'LEASED', batch_id = ?, lease_retry_count = ?,
				        claimed_by = 'bridge:1',
				        claim_expires_at = '2099-01-01T00:00:00.000Z'
				  WHERE id IN (${placeholders})`,
			)
			.run(batchId, retry, ...ids);
		return raw()
			.prepare(
				`SELECT delivery_id FROM mailbox WHERE id IN (${placeholders}) ORDER BY seq`,
			)
			.all(...ids)
			.map((row) => (row as { delivery_id: string }).delivery_id);
	}

	function ringDeferredDoorbell(batchId: string, memberIds: string[]) {
		const envelope: PhaseWakeInput = {
			id: `transport-${batchId}`,
			to: "runner-agent",
			content: "transport body",
			metadata: {
				flywheelId: `${batchId}#r0`,
				durableBatchId: batchId,
				memberIds,
				execId: EXEC,
			},
		};
		const result = db.enqueueRunnerDoorbellWake(EXEC, envelope, 1_000, {
			admissionState: "deferred_midturn",
			turnGeneration: 1,
		});
		if (!("wake" in result)) throw new Error(`doorbell ${result.kind}`);
		return result.wake;
	}

	function responseTo(questionId: string, content: string): string {
		db.insertResponse(questionId, "flywheel-eng-lead", content);
		return (
			raw()
				.prepare(
					"SELECT id FROM mailbox WHERE ref_id = ? AND type = 'response'",
				)
				.get(questionId) as { id: string }
		).id;
	}

	function deliveryId(mailboxId: string): string {
		return (
			raw()
				.prepare("SELECT delivery_id FROM mailbox WHERE id = ?")
				.get(mailboxId) as { delivery_id: string }
		).delivery_id;
	}

	function reworkWake(messageId: string, content: string, wakeId = "wake-r1") {
		return db.enqueueRunnerPhaseWake(
			EXEC,
			{
				id: messageId,
				to: "runner-agent",
				content,
				metadata: {
					kind: "workflow_rework",
					wakeId,
					activationId: ACTIVATION,
					epoch: 2,
				},
			},
			2_000,
			{ admissionState: "deferred_midturn", turnGeneration: 1 },
		).wake;
	}

	describe("consumption receipts", () => {
		it("signs an inbox receipt for the exact body, but not under the debug override", () => {
			registerPhase();
			const first = db.insertInstruction("flywheel-eng-lead", EXEC, "do A");
			inbox({ execId: EXEC, dbPath });
			expect(db.listContentConsumption(EXEC)).toEqual([
				expect.objectContaining({
					subject_kind: "mailbox",
					subject_id: deliveryId(first),
					content_sha256: sha256Utf8("do A"),
					source_kind: "inbox",
					activation_id: "",
				}),
			]);

			db.insertInstruction("flywheel-eng-lead", EXEC, "do B");
			const debug = inbox({ execId: EXEC, dbPath, debugExecOverride: true });
			expect(debug.instructions.map((m) => m.content)).toEqual(["do B"]);
			expect(db.listContentConsumption(EXEC)).toHaveLength(1);
		});

		it("signs a check receipt on the consuming read only; getResponse stays pure", () => {
			registerPhase();
			const questionId = db.insertQuestion(EXEC, "flywheel-eng-lead", "ok?");
			const responseId = responseTo(questionId, "APPROVED");
			expect(db.getResponse(questionId)?.content).toBe("APPROVED");
			expect(db.listContentConsumption(EXEC)).toEqual([]);

			expect(check({ questionId, dbPath, executionId: EXEC })).toMatchObject({
				status: "answered",
				content: "APPROVED",
			});
			expect(db.listContentConsumption(EXEC)).toEqual([
				expect.objectContaining({
					subject_id: deliveryId(responseId),
					content_sha256: sha256Utf8("APPROVED"),
					source_kind: "check",
				}),
			]);
		});

		it("keeps the enum CHECK enforced for retry-safe inserts", () => {
			expect(() =>
				raw()
					.prepare(
						`INSERT INTO runner_content_consumption
						   (receipt_id, execution_id, subject_kind, subject_id,
						    content_sha256, source_kind, consumed_at)
						 VALUES ('r', ?, 'mailbox', 's', ?, 'client_claimed', 'now')
						 ON CONFLICT(execution_id, subject_kind, subject_id, content_sha256, activation_id)
						 DO NOTHING`,
					)
					.run(EXEC, "a".repeat(64)),
			).toThrow(/CHECK constraint failed/);
		});
	});

	describe("resolution", () => {
		it("treats a live instruction as unread and a consumed one as settled", () => {
			registerPhase();
			const id = db.insertInstruction("flywheel-eng-lead", EXEC, "read me");
			const before = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(before.unread).toEqual([
				expect.objectContaining({
					type: "instruction",
					leadInstructionId: id,
					body: "read me",
					historical: false,
				}),
			]);
			expect(before.mailboxIds).toEqual([id]);

			inbox({ execId: EXEC, dbPath });
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual(
				[],
			);
		});

		it("settles a mid-turn doorbell once its instruction member is consumed through inbox (Q1 shape)", () => {
			registerPhase();
			const id = db.insertInstruction("flywheel-eng-lead", EXEC, "passphrase");
			const members = leaseBatch([id], "mailbox-batch:a");
			const wake = ringDeferredDoorbell("mailbox-batch:a", members);
			expect(wake).toMatchObject({
				state: "pending",
				admission_state: "deferred_midturn",
				push_attempts: 0,
			});

			const before = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(before.unread.map((o) => o.body)).toEqual(["passphrase"]);
			expect(before.unread[0]?.wakeMessageIds).toEqual([wake.message_id]);
			expect(before.phaseWakeIds).toEqual([wake.message_id]);

			inbox({ execId: EXEC, dbPath });
			const after = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(after.unread).toEqual([]);
			expect(after.wakes).toEqual([
				expect.objectContaining({
					messageId: wake.message_id,
					satisfied: true,
					evidence: expect.objectContaining({
						receiptIds: [expect.stringMatching(/^consume:/)],
					}),
				}),
			]);
			// The wake itself was never started: run-state is not the evidence.
			expect(db.listRunnerPhaseWakes(EXEC)[0]).toMatchObject({
				state: "pending",
				admission_state: "deferred_midturn",
			});
		});

		it("settles a mid-turn review-verdict doorbell once the runner checks it (Q2 shape)", () => {
			registerPhase();
			const questionId = db.insertQuestion(EXEC, "flywheel-eng-lead", "review");
			const responseId = responseTo(questionId, "reviewVerdict APPROVED");
			const members = leaseBatch([responseId], "mailbox-batch:v");
			ringDeferredDoorbell("mailbox-batch:v", members);

			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual([
				expect.objectContaining({ type: "response", questionId }),
			]);
			check({ questionId, dbPath, executionId: EXEC });
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual(
				[],
			);
		});

		it("re-offers a doorbell member that was ACKed without a consumption receipt, marked historical", () => {
			registerPhase();
			const id = db.insertInstruction("flywheel-eng-lead", EXEC, "old order");
			const members = leaseBatch([id], "mailbox-batch:h");
			ringDeferredDoorbell("mailbox-batch:h", members);
			db.markInstructionRead(id);

			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual([
				expect.objectContaining({
					leadInstructionId: id,
					body: "old order",
					historical: true,
				}),
			]);
		});

		it("does not treat a DEAD (expired) doorbell member as read", () => {
			registerPhase();
			const id = db.insertInstruction(
				"flywheel-eng-lead",
				EXEC,
				"expired order",
			);
			ringDeferredDoorbell(
				"mailbox-batch:d",
				leaseBatch([id], "mailbox-batch:d"),
			);
			raw()
				.prepare(
					"UPDATE mailbox SET state = 'DEAD', dead_at = '2026-09-26T00:00:00.000Z', dead_reason = 'expired' WHERE id = ?",
				)
				.run(id);
			const resolution = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(resolution.unread).toEqual([
				expect.objectContaining({ body: "expired order", historical: true }),
			]);
			db.acknowledgeCompletionDrainRead({
				executionId: EXEC,
				activationId: ACTIVATION,
				readId: "read_dead",
				subjects: resolution.unread,
				nowMs: 5_000,
			});
			expect(
				raw().prepare("SELECT state FROM mailbox WHERE id = ?").get(id),
			).toEqual({ state: "DEAD" });
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual(
				[],
			);
		});

		it("keeps the doorbell text as the obligation when a member row is gone", () => {
			registerPhase();
			const id = db.insertInstruction("flywheel-eng-lead", EXEC, "vanishing");
			const wake = ringDeferredDoorbell(
				"mailbox-batch:g",
				leaseBatch([id], "mailbox-batch:g"),
			);
			raw()
				.prepare(
					"UPDATE runner_phase_wakes SET metadata_json = json_set(metadata_json, '$.memberIds', json_array('no-such-delivery')) WHERE message_id = ?",
				)
				.run(wake.message_id);
			const resolution = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(resolution.unread).toContainEqual(
				expect.objectContaining({
					subjectKind: "inline_wake",
					subjectId: `wake:${wake.message_id}`,
					sourceStatus: "source_missing",
				}),
			);
			// The doorbell text is only a pointer: reading it must never settle
			// the missing Lead body it stood for (fail closed, plan §3.5).
			const ack = db.acknowledgeCompletionDrainRead({
				executionId: EXEC,
				activationId: ACTIVATION,
				readId: "read_missing",
				subjects: resolution.unread,
				nowMs: 5_000,
			});
			expect(ack.rejected).toContainEqual(
				expect.objectContaining({
					subjectId: `wake:${wake.message_id}`,
					reason: "source_missing",
				}),
			);
			expect(
				db
					.resolveCompletionObligations(EXEC, ACTIVATION)
					.unread.map((obligation) => obligation.sourceStatus),
			).toEqual(["source_missing"]);
			// Even a receipt for the pointer text itself cannot stand in for the
			// missing source.
			const pointer = resolution.unread.find(
				(obligation) => obligation.sourceStatus === "source_missing",
			);
			raw()
				.prepare(
					`INSERT INTO runner_content_consumption
					   (receipt_id, execution_id, subject_kind, subject_id, content_sha256,
					    source_kind, activation_id, consumed_at)
					 VALUES ('consume:pointer', ?, 'inline_wake', ?, ?, 'drain_ack', ?, 'now')`,
				)
				.run(EXEC, pointer?.subjectId, pointer?.contentSha256, ACTIVATION);
			expect(
				db.resolveCompletionObligations(EXEC, ACTIVATION).wakes[0]?.satisfied,
			).toBe(false);
		});

		it("does not let a legacy transport ACK stand in for reading the instruction body", () => {
			registerPhase();
			const id = db.insertInstruction("flywheel-eng-lead", EXEC, "legacy body");
			db.enqueueRunnerPhaseWake(
				EXEC,
				{
					id: "legacy-transport",
					to: "runner-agent",
					content: `[lead-instruction ${id}]\nlegacy body`,
					metadata: { flywheelId: id, execId: EXEC },
				},
				1_000,
				{ admissionState: "deferred_midturn", turnGeneration: 1 },
			);
			expect(
				raw().prepare("SELECT state FROM mailbox WHERE id = ?").get(id),
			).toEqual({ state: "ACKED" });

			const resolution = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(resolution.unread).toEqual([
				expect.objectContaining({
					subjectKind: "mailbox",
					subjectId: deliveryId(id),
					body: "legacy body",
					historical: true,
				}),
			]);
		});

		it("keeps a raw park wake unread until the drain ACK signs its exact inline body", () => {
			registerPhase();
			db.enqueueRunnerPhaseWake(
				EXEC,
				{ id: "park-1", to: "runner-agent", content: "[phase-wake p] resume" },
				1_000,
				{ admissionState: "deferred_midturn", turnGeneration: 1 },
			);
			const before = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(before.unread).toEqual([
				expect.objectContaining({
					subjectKind: "inline_wake",
					subjectId: "wake:park-1",
					body: "[phase-wake p] resume",
				}),
			]);

			const ack = db.acknowledgeCompletionDrainRead({
				executionId: EXEC,
				activationId: ACTIVATION,
				readId: "read_1",
				subjects: before.unread,
				nowMs: 5_000,
			});
			expect(ack.rejected).toEqual([]);
			expect(ack.accepted).toHaveLength(1);
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual(
				[],
			);
			// Inline receipts are activation-bound.
			expect(
				db.resolveCompletionObligations(EXEC, "activation:other").unread,
			).toHaveLength(1);
		});

		it("lets a copy delivered as a turn input satisfy a byte-identical duplicate of the same durable wake (Q4)", () => {
			registerPhase();
			const body = "[phase-wake wake-r1] rework context";
			const delivered = reworkWake("transport-a", body);
			const duplicate = reworkWake("transport-b", body);
			// Daemon delivery: claim (started) → turn/start → finishWake.
			db.markRunnerPhaseWakeStarted(EXEC, delivered.message_id, 3_000);
			db.finishRunnerPhaseWake(EXEC, delivered.message_id, 3_100);

			const resolution = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(resolution.unread).toEqual([]);
			expect(resolution.wakes).toEqual([
				expect.objectContaining({
					messageId: duplicate.message_id,
					satisfied: true,
					evidence: {
						receiptIds: [],
						turnInputWakeIds: [delivered.message_id],
					},
				}),
			]);
		});

		it("survives a wake row with malformed metadata JSON instead of failing the whole drain", () => {
			registerPhase();
			const body = "[phase-wake wake-r1] rework context";
			reworkWake("transport-a", body);
			db.enqueueRunnerPhaseWake(
				EXEC,
				{ id: "transport-bad", to: "runner-agent", content: "legacy" },
				2_500,
				{ admissionState: "queued" },
			);
			raw()
				.prepare(
					"UPDATE runner_phase_wakes SET metadata_json = '{not json', state = 'finished', started_ack_scope = 'message' WHERE message_id = 'transport-bad'",
				)
				.run();
			const resolution = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(resolution.unread).toEqual([
				expect.objectContaining({ subjectId: "turn-wake:wake-r1", body }),
			]);
			const ack = db.acknowledgeCompletionDrainRead({
				executionId: EXEC,
				activationId: ACTIVATION,
				readId: "read_bad",
				subjects: resolution.unread,
				nowMs: 5_000,
			});
			expect(ack.rejected).toEqual([]);
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual(
				[],
			);
		});

		it("does not treat a claimed-but-undelivered (started) wake as read", () => {
			registerPhase();
			const claimed = reworkWake("transport-a", "[phase-wake wake-r1] claimed");
			db.markRunnerPhaseWakeStarted(EXEC, claimed.message_id, 3_000);
			const resolution = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(resolution.unread).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ sourceStatus: "in_flight" }),
				]),
			);
			expect(resolution.wakes[0]).toMatchObject({
				messageId: claimed.message_id,
				satisfied: false,
			});
			// A started copy is not a turn-input delivery for its duplicate either.
			reworkWake("transport-b", "[phase-wake wake-r1] claimed");
			expect(
				db
					.resolveCompletionObligations(EXEC, ACTIVATION)
					.wakes.every((wake) => !wake.satisfied),
			).toBe(true);
			db.finishRunnerPhaseWake(EXEC, claimed.message_id, 3_500);
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual(
				[],
			);
		});

		it("fences a wake the daemon already claimed for dispatch until it is delivered (claim then complete)", () => {
			registerPhase();
			const id = db.insertInstruction(
				"flywheel-eng-lead",
				EXEC,
				"doorbell body",
			);
			const members = leaseBatch([id], "mailbox-batch:f");
			const queued = db.enqueueRunnerDoorbellWake(
				EXEC,
				{
					id: "transport-f",
					to: "runner-agent",
					content: "t",
					metadata: {
						flywheelId: "mailbox-batch:f#r0",
						durableBatchId: "mailbox-batch:f",
						memberIds: members,
						execId: EXEC,
					},
				},
				1_000,
				{ admissionState: "queued" },
			);
			if (!("wake" in queued)) throw new Error(queued.kind);
			const wake = queued.wake;
			inbox({ execId: EXEC, dbPath, now: () => 2_000 });
			// The runner's inbox marked the doorbell started (exec_cli) — settleable.
			expect(db.listRunnerPhaseWakes(EXEC)[0]).toMatchObject({
				state: "started",
				started_ack_scope: "exec_cli",
			});
			expect(
				db.resolveCompletionObligations(EXEC, ACTIVATION).wakes[0]?.satisfied,
			).toBe(true);
			// The daemon then claims it for a turn (replay): dispatch is in flight.
			expect(db.claimRunnerPhaseWakeStart(EXEC, wake.message_id, 2_500)).toBe(
				"replay",
			);
			const inFlight = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(inFlight.wakes[0]).toMatchObject({
				messageId: wake.message_id,
				satisfied: false,
			});
			expect(inFlight.unread).toEqual([
				expect.objectContaining({ sourceStatus: "in_flight" }),
			]);
			const ack = db.acknowledgeCompletionDrainRead({
				executionId: EXEC,
				activationId: ACTIVATION,
				readId: "read_inflight",
				subjects: inFlight.unread,
				nowMs: 3_000,
			});
			expect(ack.rejected).toEqual([
				expect.objectContaining({ reason: "in_flight" }),
			]);
			expect(() =>
				db.settleCompletionWakes({
					executionId: EXEC,
					activationId: ACTIVATION,
					completionEventId: "wfc:x",
					wakes: inFlight.wakes,
					nowMs: 3_000,
				}),
			).toThrow(/unsatisfied wake/);
			db.finishRunnerPhaseWake(EXEC, wake.message_id, 3_500);
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual(
				[],
			);
		});

		it("keeps a legacy instruction wake that inbox marked started but never returned", () => {
			registerPhase();
			const id = db.insertInstruction("flywheel-eng-lead", EXEC, "legacy only");
			db.enqueueRunnerPhaseWake(
				EXEC,
				{
					id: "legacy-transport",
					to: "runner-agent",
					content: `[lead-instruction ${id}]\nlegacy only`,
					metadata: { flywheelId: id, execId: EXEC },
				},
				1_000,
				{ admissionState: "queued" },
			);
			const pulled = inbox({ execId: EXEC, dbPath, now: () => 2_000 });
			expect(pulled.instructions).toEqual([]);
			expect(db.listRunnerPhaseWakes(EXEC)[0]).toMatchObject({
				state: "started",
				started_ack_scope: "exec_cli",
			});
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual([
				expect.objectContaining({ body: "legacy only" }),
			]);
		});

		it("never deduplicates different bodies under the same wake id", () => {
			registerPhase();
			const delivered = reworkWake("transport-a", "[phase-wake w] v1");
			reworkWake("transport-b", "[phase-wake w] v2 new findings");
			// Daemon delivery: claim (started) → turn/start → finishWake.
			db.markRunnerPhaseWakeStarted(EXEC, delivered.message_id, 3_000);
			db.finishRunnerPhaseWake(EXEC, delivered.message_id, 3_100);

			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual([
				expect.objectContaining({ body: "[phase-wake w] v2 new findings" }),
			]);
		});

		it("collapses two pending copies of one durable wake into one read obligation", () => {
			registerPhase();
			const body = "[phase-wake wake-r1] rework";
			const a = reworkWake("transport-a", body);
			const b = reworkWake("transport-b", body);

			const before = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(before.unread).toHaveLength(1);
			expect(before.unread[0]).toMatchObject({
				subjectId: "turn-wake:wake-r1",
				wakeMessageIds: [a.message_id, b.message_id].sort(),
			});
			db.acknowledgeCompletionDrainRead({
				executionId: EXEC,
				activationId: ACTIVATION,
				readId: "read_2",
				subjects: before.unread,
				nowMs: 5_000,
			});
			const after = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(after.unread).toEqual([]);
			expect(after.wakes.every((wake) => wake.satisfied)).toBe(true);
		});

		it("resolves a legacy question-answered wake to the response body it points at", () => {
			registerPhase();
			const questionId = db.insertQuestion(EXEC, "flywheel-eng-lead", "q");
			responseTo(questionId, "the answer");
			db.enqueueRunnerPhaseWake(
				EXEC,
				{
					id: "answered-1",
					to: "runner-agent",
					content: `Run 'flywheel-comm check ${questionId}'`,
					metadata: { questionId, kind: "ask_answered" },
				},
				1_000,
				{ admissionState: "deferred_midturn", turnGeneration: 1 },
			);
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual([
				expect.objectContaining({ type: "response", body: "the answer" }),
			]);
			check({ questionId, dbPath, executionId: EXEC });
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual(
				[],
			);
		});

		it("ignores pending wakes for a non-phase (Claude) lifecycle, like the producer", () => {
			registerPhase(EXEC, false);
			db.enqueueRunnerPhaseWake(
				EXEC,
				{ id: "park-1", to: "runner-agent", content: "resume" },
				1_000,
				{ admissionState: "queued" },
			);
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION)).toMatchObject({
				unread: [],
				wakes: [],
			});
		});

		it("changes the obligation digest when a new member merges into a pending doorbell", () => {
			registerPhase();
			const first = db.insertInstruction("flywheel-eng-lead", EXEC, "first");
			ringDeferredDoorbell(
				"mailbox-batch:m1",
				leaseBatch([first], "mailbox-batch:m1"),
			);
			inbox({ execId: EXEC, dbPath });
			const settled = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(settled.unread).toEqual([]);

			const second = db.insertInstruction("flywheel-eng-lead", EXEC, "second");
			const merged = db.enqueueRunnerDoorbellWake(
				EXEC,
				{
					id: "transport-m2",
					to: "runner-agent",
					content: "t",
					metadata: {
						flywheelId: "mailbox-batch:m2#r0",
						durableBatchId: "mailbox-batch:m2",
						memberIds: leaseBatch([second], "mailbox-batch:m2"),
						execId: EXEC,
					},
				},
				1_001,
			);
			expect(merged.kind).toBe("reused");
			const after = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(after.unread.map((o) => o.body)).toEqual(["second"]);
			expect(after.wakes[0]?.obligationDigest).not.toBe(
				settled.wakes[0]?.obligationDigest,
			);
		});
	});

	describe("drain acknowledgement", () => {
		it("refuses a subject whose body changed after the read envelope was issued", () => {
			registerPhase();
			db.insertInstruction("flywheel-eng-lead", EXEC, "v1");
			const read = db.resolveCompletionObligations(EXEC, ACTIVATION).unread;
			raw()
				.prepare("UPDATE mailbox SET content = 'v2' WHERE to_agent = ?")
				.run(EXEC);

			const ack = db.acknowledgeCompletionDrainRead({
				executionId: EXEC,
				activationId: ACTIVATION,
				readId: "read_3",
				subjects: read,
				nowMs: 5_000,
			});
			expect(ack.accepted).toEqual([]);
			expect(ack.rejected).toEqual([
				expect.objectContaining({ reason: "content_changed" }),
			]);
			expect(db.listContentConsumption(EXEC)).toEqual([]);
			expect(db.resolveCompletionObligations(EXEC, ACTIVATION).unread).toEqual([
				expect.objectContaining({ body: "v2" }),
			]);
		});

		it("ACKs a live mailbox subject and signs a drain receipt", () => {
			registerPhase();
			const id = db.insertInstruction("flywheel-eng-lead", EXEC, "live");
			const read = db.resolveCompletionObligations(EXEC, ACTIVATION).unread;
			db.acknowledgeCompletionDrainRead({
				executionId: EXEC,
				activationId: ACTIVATION,
				readId: "read_4",
				subjects: read,
				nowMs: 5_000,
			});
			expect(
				raw().prepare("SELECT state FROM mailbox WHERE id = ?").get(id),
			).toEqual({ state: "ACKED" });
			expect(db.listContentConsumption(EXEC)).toEqual([
				expect.objectContaining({ source_kind: "drain_ack" }),
			]);
		});
	});

	describe("settlement", () => {
		it("finishes a satisfied wake so turn-boundary promotion and doorbell merges skip it", () => {
			registerPhase();
			db.grantTurn("FLY-2373", EXEC, "implement", 100);
			db.markTurnStarted(EXEC, "turn-a");
			const id = db.insertInstruction("flywheel-eng-lead", EXEC, "one");
			const wake = ringDeferredDoorbell(
				"mailbox-batch:s",
				leaseBatch([id], "mailbox-batch:s"),
			);
			inbox({ execId: EXEC, dbPath });
			const resolution = db.resolveCompletionObligations(EXEC, ACTIVATION);

			expect(
				db.withImmediateTransaction(() =>
					db.settleCompletionWakes({
						executionId: EXEC,
						activationId: ACTIVATION,
						completionEventId: "wfc:1",
						wakes: resolution.wakes,
						nowMs: 9_000,
					}),
				),
			).toBe(1);
			expect(db.listRunnerPhaseWakes(EXEC)[0]).toMatchObject({
				message_id: wake.message_id,
				state: "finished",
				started_ack_scope: "drain_settled",
			});
			expect(db.listRunnerWakeSettlements(EXEC)).toEqual([
				expect.objectContaining({
					wake_message_id: wake.message_id,
					reason: "content_consumed",
					completion_event_id: "wfc:1",
				}),
			]);
			expect(db.markTurnCompleted(EXEC, "turn-a")).toEqual({
				ok: true,
				promoted: 0,
			});
			// A reader that observed the wake before settlement must not replay it.
			expect(db.claimRunnerPhaseWakeStart(EXEC, wake.message_id, 9_500)).toBe(
				"disposed",
			);

			const later = db.insertInstruction("flywheel-eng-lead", EXEC, "later");
			const next = db.enqueueRunnerDoorbellWake(
				EXEC,
				{
					id: "transport-s2",
					to: "runner-agent",
					content: "t",
					metadata: {
						flywheelId: "mailbox-batch:s2#r0",
						durableBatchId: "mailbox-batch:s2",
						memberIds: leaseBatch([later], "mailbox-batch:s2"),
						execId: EXEC,
					},
				},
				9_001,
			);
			expect(next.kind).toBe("queued");
		});

		it("refuses to settle an unsatisfied wake", () => {
			registerPhase();
			db.enqueueRunnerPhaseWake(
				EXEC,
				{ id: "park-1", to: "runner-agent", content: "resume" },
				1_000,
				{ admissionState: "deferred_midturn", turnGeneration: 1 },
			);
			const resolution = db.resolveCompletionObligations(EXEC, ACTIVATION);
			expect(() =>
				db.settleCompletionWakes({
					executionId: EXEC,
					activationId: ACTIVATION,
					completionEventId: "wfc:1",
					wakes: resolution.wakes,
					nowMs: 9_000,
				}),
			).toThrow(/unsatisfied wake park-1/);
		});
	});
});

describe("FLY-2373 carrier-safe drain pages", () => {
	function obligation(body: string): CompletionObligation {
		return {
			subjectKind: "mailbox",
			subjectId: "delivery-1",
			contentSha256: sha256Utf8(body),
			type: "instruction",
			sender: "flywheel-eng-lead",
			body,
			createdAt: "2026-09-26T00:00:00.000Z",
			leadInstructionId: "msg-1",
			wakeMessageIds: [],
			historical: false,
			sourceStatus: "ok",
		};
	}

	it("returns a normal instruction whole on one page", () => {
		const pages = paginateUnreadObligations([obligation("say the passphrase")]);
		expect(pages).toHaveLength(1);
		expect(pages[0]?.text).toContain("[lead-instruction msg-1]");
		expect(pages[0]?.text).toContain("say the passphrase");
		expect(pages[0]?.count).toBe(1);
	});

	it("splits an oversized body across pages under both limits without losing a byte", () => {
		const body = Array.from(
			{ length: 400 },
			(_, index) => `line ${index} ${"é".repeat(40)} 🚀`,
		).join("\n");
		const pages = paginateUnreadObligations([
			obligation(body),
			obligation("x"),
		]);
		expect(pages.length).toBeGreaterThan(3);
		for (const page of pages) {
			expect(Buffer.byteLength(page.text, "utf8")).toBeLessThanOrEqual(
				DRAIN_PAGE_MAX_BYTES,
			);
			expect(page.text.split("\n").length - 1).toBeLessThanOrEqual(
				DRAIN_PAGE_MAX_LINES,
			);
			expect(page.sha256).toBe(sha256Utf8(page.text));
		}
		const rebuilt = pages
			.map((page) => page.text)
			.join("")
			.split(/=== BEGIN \[1\/2\][^\n]*\n/)
			.slice(1)
			.map((chunk) =>
				chunk.replace(
					/\n=== (CONTINUES ON NEXT PAGE|END) \[1\/2\]\n(?:=== BEGIN \[2\/2\][\s\S]*)?$/,
					"",
				),
			)
			.join("");
		expect(rebuilt).toBe(body);
	});
});
