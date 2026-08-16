import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatTurnStatus,
	isTurnDebugOverride,
	recordTurnCommandSideEffects,
	recordTurnWait,
	turnStatus,
	turnWaitAskAfterMs,
} from "../commands/turn.js";
import { currentWorkflowCompletionActivationFromEnv } from "../commands/workflow-activation.js";
import { CommDB } from "../db.js";

/**
 * FLY-887: the shared-worktree TURN table — the single source of truth for which
 * phase (design/implement/qa) currently holds the exclusive right to touch the
 * shared worktree. Bridge is the ONLY writer (grantTurn); runners read it via
 * the `turn` subcommand (turnStatus) before touching the worktree.
 */
describe("CommDB three_stage_turn (FLY-887)", () => {
	let db: CommDB;
	let tmpDir: string;
	let dbPath: string;
	const T0 = 1_700_000_000_000;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-turn-"));
		dbPath = join(tmpDir, "comm.db");
		db = new CommDB(dbPath);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("getTurn returns null when no row exists", () => {
		expect(db.getTurn("ISSUE-1")).toBeNull();
	});

	it("grantTurn creates the row at epoch 1", () => {
		expect(db.grantTurn("ISSUE-1", "exec-design", "design", T0)).toBe(1);
		const t = db.getTurn("ISSUE-1");
		expect(t).not.toBeNull();
		expect(t!.issue_id).toBe("ISSUE-1");
		expect(t!.holder_exec_id).toBe("exec-design");
		expect(t!.phase).toBe("design");
		expect(t!.epoch).toBe(1);
		expect(t!.granted_at).toBe(T0);
	});

	it("atomically hands an activation to the TURN holder and returns its epoch", () => {
		db.registerSession("exec-impl", "win:1", "flywheel", "ISSUE-1", "lead");
		const epoch = db.grantTurn("ISSUE-1", "exec-impl", "implement", T0, {
			project: "flywheel",
			sourceEventId: "rework:req-1:activation-2",
			targetRunId: "run-1",
			activation: {
				activationId: "activation-2",
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				outputCredential: "output-2",
				submissionCredential: "submission-2",
				context: { authority: "qa", summary: "fix the regression" },
			},
		});

		expect(epoch).toBe(1);
		expect(db.getTurn("ISSUE-1")).toMatchObject({
			holder_exec_id: "exec-impl",
			epoch: 1,
			activation_id: "activation-2",
			target_run_id: "run-1",
			target_node_id: "implement",
			target_attempt: 2,
		});
		expect(db.getRunnerWorkflowActivation("exec-impl", 1)).toMatchObject({
			activation_id: "activation-2",
			run_id: "run-1",
			node_id: "implement",
			attempt: 2,
			output_credential: "output-2",
			submission_credential: "submission-2",
		});
		expect(db.getCurrentRunnerWorkflowActivation("exec-impl")).toMatchObject({
			activation_id: "activation-2",
			epoch: 1,
		});
		expect(turnStatus(db, "exec-impl")).toMatchObject({
			answer: "yours",
			epoch: 1,
			activationId: "activation-2",
			runId: "run-1",
			nodeId: "implement",
			attempt: 2,
		});
	});

	it("FLY-1788: a generic runner stays legacy until its TURN and activation are minted together", () => {
		db.registerSession("exec-prd", "win:prd", "flywheel", "ISSUE-PRD", "lead");
		expect(
			currentWorkflowCompletionActivationFromEnv("exec-prd", {
				FLYWHEEL_COMM_DB: dbPath,
			}),
		).toBeNull();

		db.grantTurn("ISSUE-PRD", "exec-prd", "produce", T0, {
			project: "flywheel",
			sourceEventId: "turn:spawn:exec-prd",
			targetRunId: "run-prd",
			activation: {
				activationId: "activation-prd",
				runId: "run-prd",
				nodeId: "produce",
				attempt: 1,
				outputCredential: "output-prd",
				submissionCredential: "submission-prd",
				context: {},
			},
		});

		expect(
			currentWorkflowCompletionActivationFromEnv("exec-prd", {
				FLYWHEEL_COMM_DB: dbPath,
			}),
		).toMatchObject({
			activation_id: "activation-prd",
			run_id: "run-prd",
			node_id: "produce",
			attempt: 1,
		});
	});

	it("durably retries a TURN wake once and acknowledges only the exact activation", () => {
		const wakeId = "carrier-wake:approve-1:activation-2:epoch:1";
		db.enqueueTurnWake({
			wakeId,
			executionId: "exec-impl",
			issueId: "ISSUE-1",
			epoch: 1,
			activationId: "activation-2",
			purpose: "workflow_ship_carrier",
			envelope: {
				fromAgent: "bridge",
				content: "TURN is ready",
				metadata: { wakeId, epoch: 1, activationId: "activation-2" },
			},
			backend: "codex",
			createdAtMs: T0,
		});
		const first = db.claimDueTurnWake({
			nowMs: T0,
			retryAfterMs: 60_000,
			leaseMs: 10_000,
		});
		expect(first).toMatchObject({ wake_id: wakeId, push_count: 0 });
		db.finishTurnWakePush({
			wakeId,
			claimToken: first!.claim_token!,
			pushedAtMs: T0,
			result: "ok",
		});
		expect(
			db.claimDueTurnWake({
				nowMs: T0 + 59_999,
				retryAfterMs: 60_000,
				leaseMs: 10_000,
			}),
		).toBeNull();
		const retry = db.claimDueTurnWake({
			nowMs: T0 + 60_000,
			retryAfterMs: 60_000,
			leaseMs: 10_000,
		});
		expect(retry).toMatchObject({ wake_id: wakeId, push_count: 1 });
		db.finishTurnWakePush({
			wakeId,
			claimToken: retry!.claim_token!,
			pushedAtMs: T0 + 60_000,
			result: "ok",
		});
		expect(
			db.claimDueTurnWake({
				nowMs: T0 + 180_000,
				retryAfterMs: 60_000,
				leaseMs: 10_000,
			}),
		).toBeNull();

		expect(
			db.ackTurnWakes({
				executionId: "exec-impl",
				epoch: 2,
				activationId: "activation-2",
				ackedAtMs: T0 + 180_001,
			}),
		).toBe(0);
		expect(
			db.ackTurnWakes({
				executionId: "exec-impl",
				epoch: 1,
				activationId: "activation-2",
				ackedAtMs: T0 + 180_002,
			}),
		).toBe(1);
		expect(db.getTurnWake(wakeId)).toMatchObject({
			state: "acked",
			push_count: 2,
			acked_at: T0 + 180_002,
		});
		expect(db.listUnprojectedTurnWakeReceipts()).toMatchObject([
			{ wake_id: wakeId, activation_id: "activation-2" },
		]);
		expect(db.markTurnWakeReceiptProjected(wakeId, T0 + 180_003)).toBe(true);
		expect(db.listUnprojectedTurnWakeReceipts()).toEqual([]);
	});

	it("materializes one T2 Lead alert for an unacknowledged wake episode", () => {
		db.registerSession(
			"exec-impl",
			"win:1",
			"flywheel",
			"ISSUE-1",
			"flywheel-eng-lead",
		);
		const wakeId = "wake:no-receipt";
		db.enqueueTurnWake({
			wakeId,
			executionId: "exec-impl",
			issueId: "ISSUE-1",
			epoch: 7,
			purpose: "legacy_recovery",
			envelope: { fromAgent: "bridge", content: "recover TURN" },
			backend: "claude-code",
			createdAtMs: T0,
		});
		const claim = db.claimDueTurnWake({
			nowMs: T0,
			retryAfterMs: 60_000,
			leaseMs: 10_000,
		})!;
		db.finishTurnWakePush({
			wakeId,
			claimToken: claim.claim_token!,
			pushedAtMs: T0,
			result: "ok",
		});
		expect(
			db.materializeTurnWakeNoReceiptAlerts({
				nowMs: T0 + 20 * 60_000,
				alertAfterMs: 20 * 60_000,
			}),
		).toEqual(["turn-wake-alert:wake:no-receipt"]);
		expect(
			db.materializeTurnWakeNoReceiptAlerts({
				nowMs: T0 + 21 * 60_000,
				alertAfterMs: 20 * 60_000,
			}),
		).toEqual([]);
		expect(db.getPendingQuestions("flywheel-eng-lead")).toMatchObject([
			{ id: "turn-wake-alert:wake:no-receipt" },
		]);
	});

	it("never exposes an activation after the holder or epoch has advanced", () => {
		db.registerSession("exec-old", "win:1", "flywheel", "ISSUE-1", "lead");
		db.registerSession("exec-new", "win:2", "flywheel", "ISSUE-1", "lead");
		db.grantTurn("ISSUE-1", "exec-old", "implement", T0, {
			project: "flywheel",
			sourceEventId: "rework:req-1:activation-2",
			activation: {
				activationId: "activation-2",
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				outputCredential: "old-output",
				context: {},
			},
		});
		db.grantTurn("ISSUE-1", "exec-new", "implement", T0 + 1, {
			project: "flywheel",
			sourceEventId: "rework:req-2:activation-3",
			activation: {
				activationId: "activation-3",
				runId: "run-1",
				nodeId: "implement",
				attempt: 3,
				outputCredential: "new-output",
				context: {},
			},
		});

		expect(db.getRunnerWorkflowActivation("exec-old", 1)).not.toBeNull();
		expect(db.getCurrentRunnerWorkflowActivation("exec-old")).toBeNull();
		expect(db.resolveRunnerWorkflowActivation("exec-old")).toMatchObject({
			state: "stale",
			reason: "turn_holder_mismatch",
		});
		expect(db.getCurrentRunnerWorkflowActivation("exec-new")).toMatchObject({
			activation_id: "activation-3",
			epoch: 2,
		});
	});

	it("re-granting the same issue overwrites holder/phase and increments epoch", () => {
		db.grantTurn("ISSUE-1", "exec-design", "design", T0);
		db.grantTurn("ISSUE-1", "exec-impl", "implement", T0 + 5);
		const t = db.getTurn("ISSUE-1");
		expect(t!.holder_exec_id).toBe("exec-impl");
		expect(t!.phase).toBe("implement");
		expect(t!.epoch).toBe(2);
		expect(t!.granted_at).toBe(T0 + 5);
		// Third grant → epoch 3
		db.grantTurn("ISSUE-1", "exec-qa", "qa", T0 + 10);
		expect(db.getTurn("ISSUE-1")!.epoch).toBe(3);
	});

	it("TURN rows are scoped per issue", () => {
		db.grantTurn("ISSUE-1", "exec-a", "design", T0);
		db.grantTurn("ISSUE-2", "exec-b", "design", T0);
		expect(db.getTurn("ISSUE-1")!.holder_exec_id).toBe("exec-a");
		expect(db.getTurn("ISSUE-2")!.holder_exec_id).toBe("exec-b");
		expect(db.getTurn("ISSUE-2")!.epoch).toBe(1);
	});

	it("deleteTurn removes the row (ship-time cleanup)", () => {
		db.grantTurn("ISSUE-1", "exec-a", "qa", T0);
		expect(db.getTurn("ISSUE-1")).not.toBeNull();
		db.deleteTurn("ISSUE-1");
		expect(db.getTurn("ISSUE-1")).toBeNull();
		// idempotent
		expect(() => db.deleteTurn("ISSUE-1")).not.toThrow();
	});

	it("deleteTurnIfCurrent removes only the exact holder and epoch", () => {
		db.grantTurn("ISSUE-1", "exec-a", "qa", T0);
		expect(db.deleteTurnIfCurrent("ISSUE-1", "exec-b", 1)).toBe(false);
		expect(db.deleteTurnIfCurrent("ISSUE-1", "exec-a", 2)).toBe(false);
		expect(db.getTurn("ISSUE-1")).not.toBeNull();
		expect(db.deleteTurnIfCurrent("ISSUE-1", "exec-a", 1)).toBe(true);
		expect(db.getTurn("ISSUE-1")).toBeNull();
		expect(db.deleteTurnIfCurrent("ISSUE-1", "exec-a", 1)).toBe(false);
	});

	it("deleteTurnIfCurrent refuses an epoch that advanced during a probe", () => {
		db.grantTurn("ISSUE-1", "exec-a", "implement", T0);
		const probed = db.getTurn("ISSUE-1")!;
		db.grantTurn("ISSUE-1", "exec-b", "qa", T0 + 1);

		expect(
			db.deleteTurnIfCurrent("ISSUE-1", probed.holder_exec_id, probed.epoch),
		).toBe(false);
		expect(db.getTurn("ISSUE-1")).toMatchObject({
			holder_exec_id: "exec-b",
			epoch: 2,
		});
	});

	it("migration is idempotent — re-opening the same DB does not throw", () => {
		db.grantTurn("ISSUE-1", "exec-a", "design", T0);
		db.close();
		const db2 = new CommDB(dbPath);
		expect(db2.getTurn("ISSUE-1")!.holder_exec_id).toBe("exec-a");
		db2.close();
		db = new CommDB(dbPath); // afterEach closes this
	});

	it("migrates legacy wait ledgers with no-turn hysteresis columns", () => {
		db.close();
		const legacy = new Database(dbPath);
		legacy.exec(`
			DROP TABLE turn_wait_ledger;
			CREATE TABLE turn_wait_ledger (
				execution_id TEXT NOT NULL,
				holder_exec_id TEXT NOT NULL,
				epoch INTEGER NOT NULL,
				first_seen_at INTEGER NOT NULL,
				asked_at INTEGER,
				question_id TEXT,
				last_error TEXT,
				PRIMARY KEY (execution_id, holder_exec_id, epoch)
			);
		`);
		legacy.close();

		db = new CommDB(dbPath);
		const migrated = new Database(dbPath, { readonly: true });
		try {
			const columns = migrated
				.prepare("PRAGMA table_info(turn_wait_ledger)")
				.all() as Array<{ name: string }>;
			expect(columns.map(({ name }) => name)).toEqual(
				expect.arrayContaining(["no_turn_streak", "last_no_turn_at"]),
			);
		} finally {
			migrated.close();
		}
	});

	it("readonly reader tolerates a missing table (returns null, never throws)", () => {
		const roDir = mkdtempSync(join(tmpdir(), "flywheel-turn-ro-"));
		const roPath = join(roDir, "comm.db");
		const seed = new CommDB(roPath);
		seed.close();
		const raw = new Database(roPath);
		raw.exec("DROP TABLE IF EXISTS three_stage_turn");
		raw.close();
		const ro = CommDB.openReadonly(roPath);
		expect(ro.getTurn("ISSUE-1")).toBeNull();
		ro.close();
		rmSync(roDir, { recursive: true, force: true });
	});

	// ─── FLY-921 Fix C: listTurns (Bridge reconcile full-table read) ──────────

	it("listTurns returns every TURN row in this DB", () => {
		db.grantTurn("ISSUE-1", "exec-a", "design", T0);
		db.grantTurn("ISSUE-2", "exec-b", "qa", T0 + 1);
		const rows = db.listTurns();
		expect(rows).toHaveLength(2);
		const byIssue = new Map(rows.map((r) => [r.issue_id, r]));
		expect(byIssue.get("ISSUE-1")).toMatchObject({
			holder_exec_id: "exec-a",
			phase: "design",
			epoch: 1,
		});
		expect(byIssue.get("ISSUE-2")).toMatchObject({
			holder_exec_id: "exec-b",
			phase: "qa",
			epoch: 1,
		});
	});

	it("listTurns returns [] on an empty table", () => {
		expect(db.listTurns()).toEqual([]);
	});

	it("listTurns on a readonly DB missing the table returns [] (never throws)", () => {
		const roDir = mkdtempSync(join(tmpdir(), "flywheel-turn-ro2-"));
		const roPath = join(roDir, "comm.db");
		const seed = new CommDB(roPath);
		seed.close();
		const raw = new Database(roPath);
		raw.exec("DROP TABLE IF EXISTS three_stage_turn");
		raw.close();
		const ro = CommDB.openReadonly(roPath);
		expect(ro.listTurns()).toEqual([]);
		ro.close();
		rmSync(roDir, { recursive: true, force: true });
	});
});

/**
 * FLY-887: the runner-side `turn` self-check contract. A DAG workflow runner must
 * resolve its issue via its own session row, then compare the TURN holder to its
 * own execId. `yours` is the ONLY answer that authorizes touching the worktree.
 */
describe("turnStatus (FLY-887 runner self-check)", () => {
	let db: CommDB;
	let tmpDir: string;
	const T0 = 1_700_000_000_000;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-turn-status-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("no-turn when the exec has no registered session", () => {
		expect(turnStatus(db, "exec-unknown")).toEqual({ answer: "no-turn" });
	});

	it("no-turn when the session exists but no TURN is granted for its issue", () => {
		db.registerSession("exec-impl", "win:1", "flywheel", "ISSUE-1", "lead");
		expect(turnStatus(db, "exec-impl")).toEqual({ answer: "no-turn" });
	});

	it("yours when the TURN holder is this exec", () => {
		db.registerSession("exec-impl", "win:1", "flywheel", "ISSUE-1", "lead");
		db.grantTurn("ISSUE-1", "exec-impl", "implement", 1_700_000_000_000);
		expect(turnStatus(db, "exec-impl")).toEqual({
			answer: "yours",
			phase: "implement",
			epoch: 1,
			holderExecId: "exec-impl",
		});
	});

	it("not-yours when a different exec holds the TURN (stale/late wake)", () => {
		db.registerSession("exec-qa", "win:2", "flywheel", "ISSUE-1", "lead");
		db.grantTurn("ISSUE-1", "exec-impl", "implement", 1_700_000_000_000);
		expect(turnStatus(db, "exec-qa")).toEqual({
			answer: "not-yours",
			phase: "implement",
			epoch: 1,
			holderExecId: "exec-impl",
		});
	});

	it("asks the Lead once per handoff event even after CommDB reopen and replay", () => {
		db.registerSession(
			"exec-qa",
			"win:2",
			"flywheel",
			"ISSUE-1",
			"flywheel-eng-lead",
		);
		db.grantTurn("ISSUE-1", "exec-impl", "implement", 1_700_000_000_000);
		const status = turnStatus(db, "exec-qa");
		expect(
			recordTurnWait(db, "exec-qa", status, {
				observedAtMs: 1_700_000_000_000,
				askAfterMs: 20 * 60_000,
			}),
		).toEqual({ asked: false });
		expect(
			recordTurnWait(db, "exec-qa", status, {
				observedAtMs: 1_700_001_200_000,
				askAfterMs: 20 * 60_000,
			}),
		).toEqual({
			asked: true,
			questionId: "turn-wait:exec-qa:exec-impl:1",
		});

		db.close();
		db = new CommDB(join(tmpDir, "comm.db"));
		for (let replay = 0; replay < 3; replay += 1) {
			expect(
				recordTurnWait(db, "exec-qa", turnStatus(db, "exec-qa"), {
					observedAtMs: 1_700_001_200_001 + replay,
					askAfterMs: 20 * 60_000,
				}),
			).toEqual({
				asked: false,
				questionId: "turn-wait:exec-qa:exec-impl:1",
			});
		}
		expect(db.getPendingQuestions("flywheel-eng-lead")).toMatchObject([
			{
				id: "turn-wait:exec-qa:exec-impl:1",
				from_agent: "exec-qa",
				to_agent: "flywheel-eng-lead",
			},
		]);
	});

	it("clears a wait only after two spaced no-turn observations", () => {
		db.registerSession(
			"exec-qa",
			"win:2",
			"flywheel",
			"ISSUE-1",
			"flywheel-eng-lead",
		);
		db.grantTurn("ISSUE-1", "exec-impl", "implement", T0);
		recordTurnWait(db, "exec-qa", turnStatus(db, "exec-qa"), {
			observedAtMs: T0,
			askAfterMs: 20 * 60_000,
		});

		const noTurn = { answer: "no-turn" as const };
		recordTurnWait(db, "exec-qa", noTurn, {
			observedAtMs: T0 + 1_000,
			askAfterMs: 20 * 60_000,
			noTurnClearMinMs: 30_000,
		});
		expect(db.listTurnWaitLedger("exec-qa")).toMatchObject([
			{ epoch: 1, noTurnStreak: 1, lastNoTurnAt: T0 + 1_000 },
		]);

		// A hot poll is not a second independent observation.
		recordTurnWait(db, "exec-qa", noTurn, {
			observedAtMs: T0 + 20_000,
			askAfterMs: 20 * 60_000,
			noTurnClearMinMs: 30_000,
		});
		expect(db.listTurnWaitLedger("exec-qa")[0]?.noTurnStreak).toBe(1);

		recordTurnWait(db, "exec-qa", noTurn, {
			observedAtMs: T0 + 31_000,
			askAfterMs: 20 * 60_000,
			noTurnClearMinMs: 30_000,
		});
		expect(db.listTurnWaitLedger("exec-qa")).toEqual([]);
	});

	it("resets tentative no-turn state on a concrete tuple and clears on grant", () => {
		db.registerSession(
			"exec-qa",
			"win:2",
			"flywheel",
			"ISSUE-1",
			"flywheel-eng-lead",
		);
		db.grantTurn("ISSUE-1", "exec-impl", "implement", T0);
		const waiting = turnStatus(db, "exec-qa");
		recordTurnWait(db, "exec-qa", waiting, {
			observedAtMs: T0,
			askAfterMs: 20 * 60_000,
		});
		recordTurnWait(
			db,
			"exec-qa",
			{ answer: "no-turn" },
			{
				observedAtMs: T0 + 1_000,
				askAfterMs: 20 * 60_000,
			},
		);
		recordTurnWait(db, "exec-qa", waiting, {
			observedAtMs: T0 + 2_000,
			askAfterMs: 20 * 60_000,
		});
		expect(db.listTurnWaitLedger("exec-qa")[0]).toMatchObject({
			epoch: 1,
			noTurnStreak: 0,
			lastNoTurnAt: null,
		});

		db.grantTurn("ISSUE-1", "exec-qa", "qa", T0 + 3_000);
		recordTurnWait(db, "exec-qa", turnStatus(db, "exec-qa"), {
			observedAtMs: T0 + 3_000,
			askAfterMs: 20 * 60_000,
		});
		expect(db.listTurnWaitLedger("exec-qa")).toEqual([]);
	});

	it("replaces an obsolete wait tuple when the TURN epoch changes", () => {
		db.registerSession("exec-qa", "win:2", "flywheel", "ISSUE-1", "lead");
		db.grantTurn("ISSUE-1", "exec-impl", "implement", T0);
		recordTurnWait(db, "exec-qa", turnStatus(db, "exec-qa"), {
			observedAtMs: T0,
			askAfterMs: 20 * 60_000,
		});
		db.grantTurn("ISSUE-1", "exec-design", "design", T0 + 1_000);
		recordTurnWait(db, "exec-qa", turnStatus(db, "exec-qa"), {
			observedAtMs: T0 + 1_000,
			askAfterMs: 20 * 60_000,
		});
		expect(db.listTurnWaitLedger("exec-qa")).toMatchObject([
			{ holderExecId: "exec-design", epoch: 2 },
		]);
	});

	it("validates the TURN wait threshold and identifies debug overrides", () => {
		expect(turnWaitAskAfterMs({})).toBe(20 * 60_000);
		expect(turnWaitAskAfterMs({ FLYWHEEL_TURN_WAIT_ASK_MINUTES: "5" })).toBe(
			5 * 60_000,
		);
		expect(turnWaitAskAfterMs({ FLYWHEEL_TURN_WAIT_ASK_MINUTES: "720" })).toBe(
			720 * 60_000,
		);
		for (const invalid of ["4", "721", "5.5", "-5", "abc", ""]) {
			expect(
				turnWaitAskAfterMs({ FLYWHEEL_TURN_WAIT_ASK_MINUTES: invalid }),
			).toBe(20 * 60_000);
		}

		expect(isTurnDebugOverride(undefined, "exec-self")).toBe(false);
		expect(isTurnDebugOverride("exec-self", "exec-self")).toBe(false);
		expect(isTurnDebugOverride("exec-other", "exec-self")).toBe(true);
		expect(isTurnDebugOverride("exec-self", undefined)).toBe(true);
	});

	it("keeps wait-ledger and wake-ack side effects off for both debug quadrants", () => {
		const quadrants = [
			{
				explicit: undefined,
				env: "exec-self",
				execId: "exec-self",
				live: true,
			},
			{
				explicit: "exec-self-2",
				env: "exec-self-2",
				execId: "exec-self-2",
				live: true,
			},
			{
				explicit: "exec-debug",
				env: "exec-env",
				execId: "exec-debug",
				live: false,
			},
			{
				explicit: "exec-no-env",
				env: undefined,
				execId: "exec-no-env",
				live: false,
			},
		] as const;
		for (const [index, quadrant] of quadrants.entries()) {
			const waitIssue = `WAIT-${index}`;
			const ackIssue = `ACK-${index}`;
			const waiter = `${quadrant.execId}-wait`;
			const actor = `${quadrant.execId}-ack`;
			db.registerSession(
				waiter,
				`win:w:${index}`,
				"flywheel",
				waitIssue,
				"lead",
			);
			db.grantTurn(waitIssue, `holder-${index}`, "implement", T0);
			const debugOverride = isTurnDebugOverride(
				quadrant.explicit,
				quadrant.env,
			);
			recordTurnCommandSideEffects(db, waiter, turnStatus(db, waiter), {
				observedAtMs: T0,
				askAfterMs: 20 * 60_000,
				debugOverride,
			});

			db.registerSession(actor, `win:a:${index}`, "flywheel", ackIssue, "lead");
			const epoch = db.grantTurn(ackIssue, actor, "qa", T0);
			const wakeId = `debug-quadrant:${index}`;
			db.enqueueTurnWake({
				wakeId,
				executionId: actor,
				issueId: ackIssue,
				epoch,
				purpose: "test",
				envelope: { fromAgent: "bridge", content: "test wake" },
				backend: "codex",
				createdAtMs: T0,
			});
			recordTurnCommandSideEffects(db, actor, turnStatus(db, actor), {
				observedAtMs: T0 + 1,
				askAfterMs: 20 * 60_000,
				debugOverride,
			});

			expect(db.listTurnWaitLedger(waiter).length, quadrant.execId).toBe(
				quadrant.live ? 1 : 0,
			);
			expect(db.getTurnWake(wakeId)?.state, quadrant.execId).toBe(
				quadrant.live ? "acked" : "pending",
			);
		}
	});

	it("formatTurnStatus renders the runner-facing single-line contract", () => {
		expect(formatTurnStatus({ answer: "no-turn" })).toBe("no-turn");
		expect(
			formatTurnStatus({
				answer: "yours",
				phase: "implement",
				epoch: 3,
				holderExecId: "exec-impl",
			}),
		).toBe("yours phase=implement epoch=3");
		expect(
			formatTurnStatus({
				answer: "yours",
				phase: "implement",
				epoch: 4,
				holderExecId: "exec-impl",
				activationId: "activation-4",
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
			}),
		).toBe(
			"yours phase=implement epoch=4 activation=activation-4 run=run-1 node=implement attempt=2",
		);
		expect(
			formatTurnStatus({
				answer: "not-yours",
				phase: "qa",
				epoch: 5,
				holderExecId: "exec-qa",
			}),
		).toBe("not-yours holder=exec-qa phase=qa epoch=5");
	});
});
