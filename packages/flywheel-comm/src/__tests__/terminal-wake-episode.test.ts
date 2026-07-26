import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

describe("FLY-1448 terminal wake-failure episodes", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1448-terminal-wake-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		db.registerSession(
			"exec-terminal",
			"session",
			"flywheel",
			"FLY-1448",
			"flywheel-eng-lead",
			"codex",
		);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function admit(ordinal: number, metadata: Record<string, unknown> = {}) {
		const instructionId = `instruction-${ordinal}`;
		return db.instructionAndIntent({
			instructionId,
			fromAgent: "flywheel-eng-lead",
			executionId: "exec-terminal",
			content: `work ${ordinal}`,
			intentKey: `instruction:${instructionId}`,
			envelope: {
				id: `wake-${ordinal}`,
				to: "exec-terminal",
				content: `wake ${ordinal}`,
				metadata,
			},
			queuedAtMs: 1_000 + ordinal,
		}).wake;
	}

	it("finishes repeated terminal wakes atomically under one lifecycle episode", () => {
		const lifecycleId = "terminal-life-a";
		const results = [1, 2, 3].map((ordinal) => {
			const wake = admit(ordinal);
			return db.completeRunnerPhaseWakeTerminal({
				executionId: wake.execution_id,
				messageId: wake.message_id,
				reason: "terminal_before_started",
				terminalLifecycleId: lifecycleId,
				nowMs: 2_000 + ordinal,
			});
		});

		expect(results.every(Boolean)).toBe(true);
		expect(
			new Set(results.map((result) => result?.episodeFingerprint)),
		).toEqual(new Set([`terminal:exec-terminal:${lifecycleId}`]));
		expect(
			db.listRunnerWakeFailureEpisodes("exec-terminal", "terminal"),
		).toMatchObject([
			{
				generation: 1,
				terminal_lifecycle_id: lifecycleId,
				closed_at: null,
				last_message_id: "instruction:instruction-3",
			},
		]);
		expect(
			db.listRunnerPhaseWakes("exec-terminal").map((wake) => ({
				state: wake.state,
				scope: wake.started_ack_scope,
				outbox: wake.escalation_outbox_id,
			})),
		).toEqual([
			{
				state: "finished",
				scope: "terminal",
				outbox: results[0]?.alert.id,
			},
			{
				state: "finished",
				scope: "terminal",
				outbox: results[0]?.alert.id,
			},
			{
				state: "finished",
				scope: "terminal",
				outbox: results[0]?.alert.id,
			},
		]);
		expect(results[1]?.alert.id).toBe(results[0]?.alert.id);
		expect(results[2]?.alert.id).toBe(results[0]?.alert.id);
		expect(
			db.revalidateRunnerReceiptWakeAlert(results[0]?.alert.id ?? "", 3_000),
		).toBeTruthy();
	});

	it("closes the old episode and opens a new generation after revival", () => {
		const firstWake = admit(1);
		const first = db.completeRunnerPhaseWakeTerminal({
			executionId: firstWake.execution_id,
			messageId: firstWake.message_id,
			reason: "terminal_before_started",
			terminalLifecycleId: "terminal-life-a",
			nowMs: 2_000,
		});
		const secondWake = admit(2);
		const second = db.completeRunnerPhaseWakeTerminal({
			executionId: secondWake.execution_id,
			messageId: secondWake.message_id,
			reason: "terminal_before_started",
			terminalLifecycleId: "terminal-life-b",
			nowMs: 3_000,
		});

		expect(second?.alert.id).not.toBe(first?.alert.id);
		expect(
			db.listRunnerWakeFailureEpisodes("exec-terminal", "terminal"),
		).toMatchObject([
			{
				generation: 1,
				terminal_lifecycle_id: "terminal-life-a",
				closed_at: new Date(3_000).toISOString(),
			},
			{
				generation: 2,
				terminal_lifecycle_id: "terminal-life-b",
				closed_at: null,
			},
		]);
	});

	it("keeps founder-origin terminal failures message-scoped and visible", () => {
		const firstWake = admit(1, { origin: "founder" });
		const secondWake = admit(2, { origin: "founder" });
		const first = db.completeRunnerPhaseWakeTerminal({
			executionId: firstWake.execution_id,
			messageId: firstWake.message_id,
			reason: "terminal_before_started",
			terminalLifecycleId: "terminal-life-a",
			nowMs: 2_000,
		});
		const second = db.completeRunnerPhaseWakeTerminal({
			executionId: secondWake.execution_id,
			messageId: secondWake.message_id,
			reason: "terminal_before_started",
			terminalLifecycleId: "terminal-life-a",
			nowMs: 3_000,
		});

		expect(first?.identityKind).toBe("founder_message");
		expect(second?.identityKind).toBe("founder_message");
		expect(second?.alert.id).not.toBe(first?.alert.id);
		expect(
			db.listRunnerWakeFailureEpisodes("exec-terminal", "terminal"),
		).toEqual([]);
		expect(
			db.revalidateRunnerReceiptWakeAlert(first?.alert.id ?? "", 4_000),
		).toBeTruthy();
	});
});
