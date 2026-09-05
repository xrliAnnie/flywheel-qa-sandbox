import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB, type PhaseWakeInput } from "../db.js";

describe("FLY-1774 Codex idle doorbell wakes", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1774-doorbell-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function raw() {
		return (db as unknown as { db: import("better-sqlite3").Database }).db;
	}

	function registerPhase(executionId = "exec-1") {
		db.registerSession(
			executionId,
			"flywheel:@1",
			"flywheel",
			"FLY-1774",
			"flywheel-eng-lead",
			"codex",
			true,
		);
	}

	function leaseBatch(ids: string[], batchId: string, retry = 0) {
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

	function batchEnvelope(
		batchId: string,
		memberIds: string[],
		retry = 0,
	): PhaseWakeInput {
		return {
			id: `transport-${batchId}-${retry}`,
			to: "runner-agent",
			content: "transport body must not become the durable wake body",
			metadata: {
				flywheelId: `${batchId}#r${retry}`,
				durableBatchId: batchId,
				memberIds,
				execId: "exec-1",
			},
		};
	}

	it("migrates phase capability, defaults old callers off, and keeps it monotonic", () => {
		db.registerSession(
			"exec-plain",
			"@1",
			"flywheel",
			"FLY-1",
			"lead",
			"codex",
		);
		expect(db.getSession("exec-plain")?.phase_keep_alive).toBe(0);

		registerPhase();
		expect(db.getSession("exec-1")?.phase_keep_alive).toBe(1);
		db.assertPhaseKeepAliveSessionRunning("exec-1");

		db.registerSession(
			"exec-1",
			"flywheel:@2",
			"flywheel",
			"FLY-1774",
			"flywheel-eng-lead",
			"codex",
			false,
		);
		expect(db.getSession("exec-1")?.phase_keep_alive).toBe(1);

		db.updateSessionStatusIfRunning("exec-1", "completed");
		expect(() => db.assertPhaseKeepAliveSessionRunning("exec-1")).toThrow(
			/phase keep-alive session is not running/,
		);
	});

	it("queues one batch doorbell without acknowledging any mailbox member", () => {
		registerPhase();
		const first = db.insertInstruction("lead", "exec-1", "first");
		const second = db.insertInstruction("lead", "exec-1", "second");
		const batchId = "mailbox-batch:batch-a";
		const memberIds = leaseBatch([first, second], batchId);

		const queued = db.enqueueRunnerDoorbellWake(
			"exec-1",
			batchEnvelope(batchId, memberIds),
			1_000,
		);

		expect(queued.kind).toBe("queued");
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{
				message_id: `doorbell:${batchId}#r0`,
				source_instruction_id: null,
				state: "pending",
				purpose: "message_traffic",
			},
		]);
		expect(db.listRunnerPhaseWakes("exec-1")[0]?.content).toContain(
			"flywheel-comm inbox --exec-id exec-1",
		);
		expect(db.listRunnerPhaseWakes("exec-1")[0]?.content).not.toContain(
			"transport body",
		);
		expect(
			raw()
				.prepare(
					"SELECT id, state, acked_at FROM mailbox WHERE id IN (?, ?) ORDER BY seq",
				)
				.all(first, second),
		).toEqual([
			{ id: first, state: "LEASED", acked_at: null },
			{ id: second, state: "LEASED", acked_at: null },
		]);

		expect(
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				batchEnvelope(batchId, memberIds),
				1_001,
			).kind,
		).toBe("already_covered");
		expect(db.listRunnerPhaseWakes("exec-1")).toHaveLength(1);
	});

	it("keeps batch doorbells live for an existing non-loop phase worker", () => {
		// Loop-target identity lives outside CommDB's legacy phase capability.
		// A non-loop shared Codex phase therefore still registers this bit.
		registerPhase();
		const instruction = db.insertInstruction("lead", "exec-1", "handoff");
		const batchId = "mailbox-batch:non-loop";
		const memberIds = leaseBatch([instruction], batchId);

		expect(
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				batchEnvelope(batchId, memberIds),
				1_001,
			).kind,
		).toBe("queued");
	});

	it("receiver ingress never bypasses the durable doorbell consumer fence", () => {
		db.registerSession(
			"exec-1",
			"flywheel:@1",
			"flywheel",
			"FLY-1774",
			"flywheel-eng-lead",
			"codex",
			false,
		);
		db.updateSessionStatusIfRunning("exec-1", "completed");
		const instruction = db.insertInstruction("lead", "exec-1", "handoff");
		const batchId = "mailbox-batch:state-store-candidate";
		const memberIds = leaseBatch([instruction], batchId);

		expect(
			db.enqueueRunnerReceiverDelivery(
				"exec-1",
				batchEnvelope(batchId, memberIds),
				1_002,
			),
		).toEqual({ kind: "no_consumer" });
		expect(db.listRunnerPhaseWakes("exec-1")).toEqual([]);
		expect(
			raw()
				.prepare("SELECT state, acked_at FROM mailbox WHERE id = ?")
				.get(instruction),
		).toEqual({ state: "LEASED", acked_at: null });
	});

	it("receiver ingress leaves a single instruction unread without a consumer", () => {
		db.registerSession(
			"exec-1",
			"flywheel:@1",
			"flywheel",
			"FLY-1774",
			"flywheel-eng-lead",
			"codex",
			false,
		);
		const instruction = db.insertInstruction("lead", "exec-1", "handoff");

		expect(
			db.enqueueRunnerReceiverDelivery(
				"exec-1",
				{
					id: "transport-single",
					to: "exec-1",
					content: "handoff",
					metadata: { flywheelId: instruction, execId: "exec-1" },
				},
				1_003,
			),
		).toEqual({ kind: "no_consumer" });
		expect(db.listRunnerPhaseWakes("exec-1")).toEqual([]);
		expect(
			raw()
				.prepare("SELECT state, acked_at FROM mailbox WHERE id = ?")
				.get(instruction),
		).toEqual({ state: "QUEUED", acked_at: null });
	});

	it("durably covers a reused attempt and merges response check pointers", () => {
		registerPhase();
		const instruction = db.insertInstruction("lead", "exec-1", "first");
		const batchA = "mailbox-batch:a";
		const membersA = leaseBatch([instruction], batchA);
		const first = db.enqueueRunnerDoorbellWake(
			"exec-1",
			batchEnvelope(batchA, membersA),
			2_000,
		);
		expect(first.kind).toBe("queued");

		const questionId = db.insertQuestion("exec-1", "lead", "question");
		db.insertResponse(questionId, "lead", "answer");
		const responseId = raw()
			.prepare("SELECT id FROM mailbox WHERE ref_id = ?")
			.get(questionId) as { id: string };
		const batchB = "mailbox-batch:b";
		const membersB = leaseBatch([responseId.id], batchB);
		const reused = db.enqueueRunnerDoorbellWake(
			"exec-1",
			batchEnvelope(batchB, membersB),
			2_001,
		);

		expect(reused.kind).toBe("reused");
		expect(db.listRunnerPhaseWakes("exec-1")).toHaveLength(1);
		expect(db.listRunnerPhaseWakes("exec-1")[0]?.content).toContain(
			`flywheel-comm check ${questionId}`,
		);

		expect(
			db.markRunnerPhaseWakeStarted("exec-1", first.wake.message_id, 2_002),
		).toBe(true);
		expect(
			db.finishRunnerPhaseWake("exec-1", first.wake.message_id, 2_003),
		).toBe(true);
		expect(
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				batchEnvelope(batchB, membersB),
				2_004,
			).kind,
		).toBe("already_covered");
		expect(db.listRunnerPhaseWakes("exec-1")).toHaveLength(1);
	});

	it("allows a new lease retry only after the prior doorbell finishes", () => {
		registerPhase();
		const instruction = db.insertInstruction("lead", "exec-1", "retry me");
		const batchId = "mailbox-batch:retry";
		const members = leaseBatch([instruction], batchId);
		const first = db.enqueueRunnerDoorbellWake(
			"exec-1",
			batchEnvelope(batchId, members),
			2_100,
		);
		expect(first.kind).toBe("queued");
		if (first.kind !== "queued") throw new Error("expected queued doorbell");

		db.markRunnerPhaseWakeStarted("exec-1", first.wake.message_id, 2_101);
		db.finishRunnerPhaseWake("exec-1", first.wake.message_id, 2_102);
		leaseBatch([instruction], batchId, 1);
		expect(
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				batchEnvelope(batchId, members, 1),
				2_103,
			).kind,
		).toBe("queued");
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{ state: "finished", message_id: `doorbell:${batchId}#r0` },
			{ state: "pending", message_id: `doorbell:${batchId}#r1` },
		]);
	});

	it("does not mark a new attempt covered while its carrier wake is started", () => {
		registerPhase();
		const firstId = db.insertInstruction("lead", "exec-1", "first");
		const firstBatch = "mailbox-batch:started-a";
		const firstMembers = leaseBatch([firstId], firstBatch);
		const first = db.enqueueRunnerDoorbellWake(
			"exec-1",
			batchEnvelope(firstBatch, firstMembers),
			2_200,
		);
		if (first.kind !== "queued") throw new Error("expected queued doorbell");
		db.markRunnerPhaseWakeStarted("exec-1", first.wake.message_id, 2_201);

		const secondId = db.insertInstruction("lead", "exec-1", "second");
		const secondBatch = "mailbox-batch:started-b";
		const secondMembers = leaseBatch([secondId], secondBatch);
		expect(
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				batchEnvelope(secondBatch, secondMembers),
				2_202,
			).kind,
		).toBe("reused");

		db.finishRunnerPhaseWake("exec-1", first.wake.message_id, 2_203);
		expect(
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				batchEnvelope(secondBatch, secondMembers),
				2_204,
			).kind,
		).toBe("queued");
	});

	it("treats settled and stale transport envelopes as consumable no-ops", () => {
		registerPhase();
		const settled = db.insertInstruction("lead", "exec-1", "settled");
		const settledBatch = "mailbox-batch:settled";
		const settledMembers = leaseBatch([settled], settledBatch);
		db.markInstructionRead(settled);
		expect(
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				batchEnvelope(settledBatch, settledMembers),
				3_000,
			).kind,
		).toBe("already_settled");

		const stale = db.insertInstruction("lead", "exec-1", "stale");
		const staleBatch = "mailbox-batch:stale";
		const staleMembers = leaseBatch([stale], staleBatch);
		raw()
			.prepare(
				"UPDATE mailbox SET state='QUEUED', batch_id=NULL, claimed_by=NULL, claim_expires_at=NULL WHERE id=?",
			)
			.run(stale);
		expect(
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				batchEnvelope(staleBatch, staleMembers),
				3_001,
			).kind,
		).toBe("stale_attempt");
		expect(db.listRunnerPhaseWakes("exec-1")).toEqual([]);
	});

	it("sweeps instructions, response-only pointers, and negative controls", () => {
		expect(db.sweepRunnerDoorbellWake("missing", 4_000).kind).toBe(
			"no_consumer",
		);
		db.registerSession("plain", "@1", "flywheel", "FLY-1", "lead", "codex");
		db.insertInstruction("lead", "plain", "must not wake");
		expect(db.sweepRunnerDoorbellWake("plain", 4_001).kind).toBe("no_consumer");
		expect(db.listRunnerPhaseWakes("plain")).toEqual([]);

		registerPhase();
		expect(db.sweepRunnerDoorbellWake("exec-1", 4_002).kind).toBe(
			"no_messages",
		);
		const instruction = db.insertInstruction("lead", "exec-1", "wake me");
		expect(db.sweepRunnerDoorbellWake("exec-1", 4_003).kind).toBe("queued");
		expect(db.sweepRunnerDoorbellWake("exec-1", 4_004).kind).toBe(
			"already_covered",
		);
		expect(db.getUnreadInstructions("exec-1").map((row) => row.id)).toEqual([
			instruction,
		]);

		const responseExec = "exec-response";
		db.registerSession(
			responseExec,
			"@2",
			"flywheel",
			"FLY-1774",
			"lead",
			"codex",
			true,
		);
		const questionId = db.insertQuestion(responseExec, "lead", "answer me");
		db.insertResponse(questionId, "lead", "done");
		expect(db.sweepRunnerDoorbellWake(responseExec, 4_005).kind).toBe("queued");
		const responseWake = db.listRunnerPhaseWakes(responseExec)[0]!;
		expect(responseWake.content).toContain(`flywheel-comm check ${questionId}`);
		expect(responseWake.content).not.toContain("flywheel-comm inbox");
	});

	it("deduplicates sweep and batch legs without suppressing non-doorbell wakes", () => {
		registerPhase();
		db.enqueueRunnerPhaseWake(
			"exec-1",
			{ id: "park-wake", to: "runner-agent", content: "resume phase" },
			4_100,
		);
		const instruction = db.insertInstruction("lead", "exec-1", "wake me");
		const batchId = "mailbox-batch:cross-leg";
		const members = leaseBatch([instruction], batchId);

		expect(db.sweepRunnerDoorbellWake("exec-1", 4_101).kind).toBe("queued");
		expect(
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				batchEnvelope(batchId, members),
				4_102,
			).kind,
		).toBe("already_covered");
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{ message_id: "park-wake", purpose: "park_wake" },
			{
				message_id: `doorbell:${batchId}#r0`,
				purpose: "message_traffic",
			},
		]);
	});

	it("sweep chooses the oldest leased batch and leaves other groups uncovered", () => {
		registerPhase();
		const oldest = db.insertInstruction("lead", "exec-1", "oldest");
		const newer = db.insertInstruction("lead", "exec-1", "newer");
		const queued = db.insertInstruction("lead", "exec-1", "queued");
		const oldestMembers = leaseBatch([oldest], "mailbox-batch:oldest", 1);
		leaseBatch([newer], "mailbox-batch:newer", 0);

		expect(db.sweepRunnerDoorbellWake("exec-1", 4_200).kind).toBe("queued");
		const wake = db.listRunnerPhaseWakes("exec-1")[0]!;
		expect(wake.message_id).toBe("doorbell:mailbox-batch:oldest#r1");
		const metadata = JSON.parse(wake.metadata_json ?? "{}") as {
			memberIds?: string[];
		};
		expect(metadata.memberIds).toEqual(oldestMembers);
		const uncovered = raw()
			.prepare(
				"SELECT delivery_id FROM mailbox WHERE id IN (?, ?) ORDER BY seq",
			)
			.all(newer, queued)
			.map((row) => (row as { delivery_id: string }).delivery_id);
		for (const deliveryId of uncovered) {
			expect(metadata.memberIds).not.toContain(deliveryId);
		}
	});

	it("fails loud on malformed members and recipient ownership mismatch", () => {
		registerPhase();
		expect(() =>
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				batchEnvelope("mailbox-batch:bad", []),
				4_300,
			),
		).toThrow(/malformed runner mailbox batch/);

		db.registerSession(
			"exec-2",
			"@2",
			"flywheel",
			"FLY-1774",
			"lead",
			"codex",
			true,
		);
		const foreign = db.insertInstruction("lead", "exec-2", "foreign");
		const batchId = "mailbox-batch:foreign";
		const foreignMembers = leaseBatch([foreign], batchId);
		expect(() =>
			db.enqueueRunnerDoorbellWake(
				"exec-1",
				{
					...batchEnvelope(batchId, foreignMembers),
					metadata: {
						...batchEnvelope(batchId, foreignMembers).metadata,
						execId: "exec-1",
					},
				},
				4_301,
			),
		).toThrow(/ownership mismatch/);
	});

	it.each(["pending", "started"] as const)(
		"terminalization disposes %s doorbells in the same lifecycle write",
		(state) => {
			registerPhase();
			db.insertInstruction("lead", "exec-1", "terminal race");
			const queued = db.sweepRunnerDoorbellWake("exec-1", 5_000);
			expect(queued.kind).toBe("queued");
			if (state === "started") {
				expect(
					db.markRunnerPhaseWakeStarted(
						"exec-1",
						queued.wake.message_id,
						5_001,
					),
				).toBe(true);
			}

			db.markSessionTerminalStatus("exec-1", "failed");
			expect(db.listRunnerPhaseWakes("exec-1")[0]).toMatchObject({
				state: "finished",
				last_push_result: "disposed:terminal_target",
			});
			expect(db.sweepRunnerDoorbellWake("exec-1", 5_002).kind).toBe(
				"no_consumer",
			);
		},
	);

	it("adapter-style terminal CAS atomically disposes a pending doorbell", () => {
		registerPhase();
		db.insertInstruction("lead", "exec-1", "terminal race");
		expect(db.sweepRunnerDoorbellWake("exec-1", 5_100).kind).toBe("queued");

		db.updateSessionStatusIfRunning("exec-1", "completed");
		expect(db.getSession("exec-1")?.status).toBe("completed");
		expect(db.listRunnerPhaseWakes("exec-1")[0]).toMatchObject({
			state: "finished",
			last_push_result: "disposed:terminal_target",
		});
	});
});
