import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommDB, patrolJudgmentFingerprint } from "../db.js";

interface RawDb {
	exec(sql: string): void;
	prepare(sql: string): { run(...params: unknown[]): unknown };
}

describe("FLY-1925 CommDB patrol loop snapshot", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	function database(): { path: string; writer: CommDB; raw: RawDb } {
		const dir = mkdtempSync(join(tmpdir(), "fly1925-comm-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		const writer = new CommDB(path, true, false);
		const raw = (writer as unknown as { db: RawDb }).db;
		return { path, writer, raw };
	}

	it("takes one typed snapshot and unions an off-roster TURN holder into waits", () => {
		const { path, writer, raw } = database();
		const nowMs = Date.parse("2026-08-20T12:00:00.000Z");
		raw
			.prepare(
				`INSERT INTO three_stage_turn
			   (issue_id, holder_exec_id, phase, epoch, granted_at, target_run_id,
			    target_node_id, target_attempt, activation_id)
			 VALUES ('issue-1', 'exec-holder', 'qa', 3, ?, 'run-1', 'qa', 1,
			         'activation-holder')`,
			)
			.run(nowMs - 60_000);
		raw
			.prepare(
				`INSERT INTO turn_wait_ledger
			   (execution_id, holder_exec_id, epoch, first_seen_at)
			 VALUES
			   ('exec-waiter', 'exec-holder', 3, ?),
			   ('exec-holder', 'exec-holder', 3, ?)`,
			)
			.run(nowMs - 31 * 60_000, nowMs - 5 * 60_000);
		raw
			.prepare(
				`INSERT INTO turn_wake_outbox
			   (wake_id, execution_id, issue_id, epoch, activation_id, purpose,
			    envelope_json, backend, state, push_count, episode_id, created_at)
			 VALUES ('wake-1', 'exec-holder', 'issue-1', 3, 'activation-holder',
			         'phase-wake', '{}', 'codex', 'sent', 1, 'episode-1', ?)`,
			)
			.run(nowMs - 30_000);
		raw
			.prepare(
				`INSERT INTO runner_declared_states
			   (execution_id, kind, reason, created_at, expires_at, updated_at)
			 VALUES ('exec-waiter', 'parked', 'test', ?, ?, ?)`,
			)
			.run(nowMs - 1_000, nowMs + 60_000, nowMs - 1_000);

		const reader = CommDB.openReadonly(path);
		try {
			const snapshot = reader.readPatrolTurnSnapshot({
				issueIds: ["issue-1"],
				executionIds: ["exec-waiter"],
				nowMs,
			});
			expect(snapshot.judgment.available).toBe(true);
			if (!snapshot.judgment.available) throw new Error("judgment unavailable");
			expect(snapshot.judgment.turns.get("issue-1")).toMatchObject({
				holderExecId: "exec-holder",
				phase: "qa",
				epoch: 3,
				targetRunId: "run-1",
				targetNodeId: "qa",
				targetAttempt: 1,
				activationId: "activation-holder",
			});
			expect(snapshot.judgment.waits.get("exec-waiter")).toEqual([
				{
					executionId: "exec-waiter",
					holderExecId: "exec-holder",
					epoch: 3,
					firstSeenAt: nowMs - 31 * 60_000,
				},
			]);
			expect(snapshot.judgment.waits.get("exec-holder")).toEqual([
				{
					executionId: "exec-holder",
					holderExecId: "exec-holder",
					epoch: 3,
					firstSeenAt: nowMs - 5 * 60_000,
				},
			]);
			expect(snapshot.judgment.wakes.get("issue-1")).toEqual([
				{
					issueId: "issue-1",
					state: "sent",
					pushCount: 1,
					executionId: "exec-holder",
					epoch: 3,
					activationId: "activation-holder",
				},
			]);
			expect(snapshot.display).toEqual({
				available: true,
				declared: new Map([["exec-waiter", "parked"]]),
			});
			const initial = patrolJudgmentFingerprint(snapshot.judgment, "issue-1", [
				"exec-waiter",
			]);
			expect(
				reader.rereadJudgmentFingerprint("issue-1", ["exec-waiter"]),
			).toEqual({ available: true, fingerprint: initial });

			raw
				.prepare(
					"UPDATE turn_wake_outbox SET push_count = 2 WHERE wake_id = 'wake-1'",
				)
				.run();
			const changed = reader.rereadJudgmentFingerprint("issue-1", [
				"exec-waiter",
			]);
			expect(changed.available).toBe(true);
			if (changed.available) expect(changed.fingerprint).not.toBe(initial);

			raw
				.prepare(
					"UPDATE turn_wake_outbox SET push_count = 1 WHERE wake_id = 'wake-1'",
				)
				.run();
			raw
				.prepare(
					`INSERT INTO turn_wait_ledger
				   (execution_id, holder_exec_id, epoch, first_seen_at)
				 VALUES ('exec-waiter', 'old-holder', 1, ?)`,
				)
				.run(nowMs - 1_000);
			const insertedWait = reader.rereadJudgmentFingerprint("issue-1", [
				"exec-waiter",
			]);
			expect(insertedWait.available).toBe(true);
			if (insertedWait.available) {
				expect(insertedWait.fingerprint).not.toBe(initial);
			}
			raw
				.prepare(
					"DELETE FROM turn_wait_ledger WHERE execution_id = 'exec-waiter' AND epoch = 1",
				)
				.run();
			raw
				.prepare(
					"UPDATE turn_wait_ledger SET first_seen_at = first_seen_at + 1 WHERE execution_id = 'exec-waiter'",
				)
				.run();
			const changedAge = reader.rereadJudgmentFingerprint("issue-1", [
				"exec-waiter",
			]);
			expect(changedAge.available).toBe(true);
			if (changedAge.available)
				expect(changedAge.fingerprint).not.toBe(initial);
		} finally {
			reader.close();
			writer.close();
		}
	});

	it("fails judgment honestly when any critical table is absent", () => {
		const { path, writer, raw } = database();
		raw.exec("DROP TABLE turn_wait_ledger");
		writer.close();
		const reader = CommDB.openReadonly(path);
		try {
			expect(
				reader.readPatrolTurnSnapshot({
					issueIds: ["issue-1"],
					executionIds: ["exec-1"],
					nowMs: 1,
				}),
			).toMatchObject({
				judgment: {
					available: false,
					missingSources: ["turn_wait_ledger"],
				},
			});
		} finally {
			reader.close();
		}
	});

	it("treats declared-state absence as display-only degradation", () => {
		const { path, writer, raw } = database();
		raw.exec("DROP TABLE runner_declared_states");
		writer.close();
		const reader = CommDB.openReadonly(path);
		try {
			const snapshot = reader.readPatrolTurnSnapshot({
				issueIds: ["issue-1"],
				executionIds: ["exec-1"],
				nowMs: 1,
			});
			expect(snapshot.judgment.available).toBe(true);
			expect(snapshot.display).toEqual({ available: false });
		} finally {
			reader.close();
		}
	});
});
