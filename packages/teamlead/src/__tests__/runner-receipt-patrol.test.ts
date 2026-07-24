import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RunnerReceiptPatrol,
	wakeFailureEpisodeFingerprint,
} from "../bridge/runner-receipt-patrol.js";

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

	function admit(queuedAtMs: number, ordinal = 1) {
		return db.instructionAndIntent({
			instructionId: `instruction-${ordinal}`,
			fromAgent: "lead-1",
			executionId: "exec-1",
			content: "do work",
			intentKey: `instruction:instruction-${ordinal}`,
			envelope: {
				id: `wake-${ordinal}`,
				to: "exec-1",
				content: "wake",
				metadata: { questionId: `question-${ordinal}` },
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
		db.upsertDeclaredState("exec-1", "parked", "awaiting work", 1_000, null);
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
		db.upsertDeclaredState("exec-1", "parked", "awaiting work", 1_000, null);
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

	it("disposes ordinary traffic for a live non-parked runner before the ladder", async () => {
		const wake = admit(1_000);
		db.close();

		await patrol(999_000);

		db = new CommDB(dbPath);
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{
				message_id: wake.message_id,
				purpose: "message_traffic",
				state: "finished",
				started_ack_scope: "normal_traffic",
			},
		]);
		expect(pushWake).not.toHaveBeenCalled();
		expect(nudgeWakePointer).not.toHaveBeenCalled();
		expect(notifyWakeFailure).not.toHaveBeenCalled();
	});

	it("keeps gate-response traffic on the durable ladder for a live runner", async () => {
		const questionId = db.insertQuestion("exec-1", "lead-1", "review?", {
			checkpoint: "review_code",
		});
		const result = db.insertReviewResponseWithWakeIfGateOpen({
			questionId,
			fromAgent: "bridge",
			content: '{"reviewVerdict":"APPROVED"}',
			expectedOwner: "exec-1",
			expectedCheckpoint: "review_code",
			summary: "APPROVED",
			queuedAtMs: 1_000,
		});
		expect(result).not.toBeNull();
		db.close();

		await patrol(91_000);

		db = new CommDB(dbPath);
		expect(pushWake).toHaveBeenCalledOnce();
		expect(db.listRunnerPhaseWakes("exec-1")[0]).toMatchObject({
			message_id: result?.responseId,
			purpose: "gate_response",
			state: "pending",
		});
	});

	it("settles a terminal target at the source instead of raising a wake-failed alert", async () => {
		const wake = admit(1_000);
		db.updateSessionStatus("exec-1", "failed");
		db.close();

		await patrol(2_000);

		db = new CommDB(dbPath);
		expect(notifyWakeFailure).not.toHaveBeenCalled();
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{
				message_id: wake.message_id,
				state: "finished",
				last_push_result: "disposed:terminal_target",
			},
		]);
	});

	it("shares one failure episode across messages until a started receipt closes it", async () => {
		admit(1_000, 1);
		admit(2_000, 2);
		db.upsertDeclaredState("exec-1", "parked", "awaiting work", 1_000, null);
		nudgeWakePointer.mockResolvedValue({
			nudged: false,
			error: "no_tmux_target",
		});
		db.close();

		await patrol(400_000);

		db = new CommDB(dbPath);
		expect(notifyWakeFailure).toHaveBeenCalledTimes(2);
		expect(
			notifyWakeFailure.mock.calls.map(([input]) => input.firstDetectedAtMs),
		).toEqual([1_000, 1_000]);

		for (const wake of db.listRunnerPhaseWakes("exec-1")) {
			db.markRunnerPhaseWakeStarted(wake.execution_id, wake.message_id, 4_001);
		}
		admit(5_000, 3);
		notifyWakeFailure.mockClear();
		db.close();

		await patrol(400_001);

		db = new CommDB(dbPath);
		expect(notifyWakeFailure).toHaveBeenCalledOnce();
		expect(notifyWakeFailure).toHaveBeenCalledWith(
			expect.objectContaining({ firstDetectedAtMs: 5_000 }),
		);
		expect(wakeFailureEpisodeFingerprint("exec-1", 1_000)).toBe(
			wakeFailureEpisodeFingerprint("exec-1", 1_000),
		);
		expect(wakeFailureEpisodeFingerprint("exec-1", 5_000)).not.toBe(
			wakeFailureEpisodeFingerprint("exec-1", 1_000),
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
