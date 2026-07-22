import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerReceiptPatrol } from "../bridge/runner-receipt-patrol.js";

describe("FLY-1392 runner receipt patrol", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: CommDB;
	const pushWake = vi.fn(async () => ({ ok: true }));
	const nudgeWakePointer = vi.fn(async () => ({ nudged: true }));
	const notifyWakeFailure = vi.fn(async () => true);

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "receipt-patrol-"));
		dbPath = join(tmpDir, "comm.db");
		db = new CommDB(dbPath);
		db.registerSession("exec-1", "session", "proj", "FLY-1", "lead-1", "codex");
		pushWake.mockClear();
		nudgeWakePointer.mockClear();
		notifyWakeFailure.mockClear();
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function admit(queuedAtMs: number) {
		return db.instructionAndIntent({
			instructionId: "instruction-1",
			fromAgent: "lead-1",
			executionId: "exec-1",
			content: "do work",
			intentKey: "instruction:instruction-1",
			envelope: {
				id: "wake-1",
				to: "exec-1",
				content: "wake",
				metadata: { questionId: "question-1" },
			},
			queuedAtMs,
		}).wake;
	}

	function patrol(nowMs: number) {
		return new RunnerReceiptPatrol({
			projectNames: ["proj"],
			commDbPathForProject: () => dbPath,
			receiptFoundationEnabled: () => true,
			now: () => nowMs,
			pushWake,
			nudgeWakePointer,
			notifyWakeFailure,
		}).pass();
	}

	it("uses the same hard budget for the verified T1 retry", async () => {
		const wake = admit(1_000);
		const initial = db.claimRunnerReceiptWakePush(
			"exec-1",
			wake.message_id,
			1_000,
			{ t1Ms: 90_000, claimTtlMs: 10_000 },
		)!;
		db.completeRunnerReceiptWakePush({
			executionId: "exec-1",
			messageId: wake.message_id,
			claimToken: initial.claimToken,
			attempt: 1,
			result: "failed",
			nowMs: 1_001,
		});
		db.close();

		await patrol(91_000);

		db = new CommDB(dbPath);
		expect(pushWake).toHaveBeenCalledWith(
			expect.objectContaining({ verified: true }),
		);
		expect(db.listRunnerPhaseWakes("exec-1")[0]).toMatchObject({
			push_attempts: 2,
			last_push_result: "attempt:2:verified",
		});
	});

	it("records a failed T2 wake and immediately enters the visible escalation chain", async () => {
		admit(1_000);
		nudgeWakePointer.mockResolvedValueOnce({
			nudged: false,
			error: "no_tmux_target",
		});
		db.close();

		await patrol(301_000);

		db = new CommDB(dbPath);
		expect(notifyWakeFailure).toHaveBeenCalledOnce();
		expect(db.listRunnerPhaseWakes("exec-1")[0]).toMatchObject({
			t2_result: "forbidden:no_tmux_target",
			escalation_outbox_id: "wake_failed:instruction:instruction-1",
		});
		expect(
			db.getReceiptAlertOutbox("wake_failed:instruction:instruction-1"),
		).toMatchObject({ delivered_at: expect.any(String) });
	});

	it("never swallows a terminal-before-started wake as clean stand-down", async () => {
		admit(1_000);
		db.updateSessionStatus("exec-1", "failed");
		db.close();

		await patrol(2_000);

		db = new CommDB(dbPath);
		expect(notifyWakeFailure).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "terminal_before_started" }),
		);
	});

	it("a started receipt stands down every later ladder stage", async () => {
		const wake = admit(1_000);
		db.markRunnerPhaseWakeStarted("exec-1", wake.message_id, 2_000);
		db.close();

		await patrol(999_000);

		expect(pushWake).not.toHaveBeenCalled();
		expect(nudgeWakePointer).not.toHaveBeenCalled();
		expect(notifyWakeFailure).not.toHaveBeenCalled();
	});

	it("kill switch is a zero-effect sentinel", async () => {
		const wake = admit(1_000);
		db.close();
		await new RunnerReceiptPatrol({
			projectNames: ["proj"],
			commDbPathForProject: () => dbPath,
			receiptFoundationEnabled: () => false,
			now: () => 999_000,
			pushWake,
			nudgeWakePointer,
			notifyWakeFailure,
		}).pass();

		db = new CommDB(dbPath);
		expect(db.listRunnerPhaseWakes("exec-1")[0]).toMatchObject({
			message_id: wake.message_id,
			push_attempts: 0,
			t2_claimed_at: null,
			escalation_outbox_id: null,
		});
		expect(pushWake).not.toHaveBeenCalled();
		expect(nudgeWakePointer).not.toHaveBeenCalled();
		expect(notifyWakeFailure).not.toHaveBeenCalled();
	});
});
