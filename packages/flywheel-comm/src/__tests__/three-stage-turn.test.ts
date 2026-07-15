import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatTurnStatus, turnStatus } from "../commands/turn.js";
import { CommDB } from "../db.js";

/**
 * FLY-887: the three-stage TURN table — the single source of truth for which
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
		db.grantTurn("ISSUE-1", "exec-design", "design", T0);
		const t = db.getTurn("ISSUE-1");
		expect(t).not.toBeNull();
		expect(t!.issue_id).toBe("ISSUE-1");
		expect(t!.holder_exec_id).toBe("exec-design");
		expect(t!.phase).toBe("design");
		expect(t!.epoch).toBe(1);
		expect(t!.granted_at).toBe(T0);
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

	it("migration is idempotent — re-opening the same DB does not throw", () => {
		db.grantTurn("ISSUE-1", "exec-a", "design", T0);
		db.close();
		const db2 = new CommDB(dbPath);
		expect(db2.getTurn("ISSUE-1")!.holder_exec_id).toBe("exec-a");
		db2.close();
		db = new CommDB(dbPath); // afterEach closes this
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
 * FLY-887: the runner-side `turn` self-check contract. A three-stage runner must
 * resolve its issue via its own session row, then compare the TURN holder to its
 * own execId. `yours` is the ONLY answer that authorizes touching the worktree.
 */
describe("turnStatus (FLY-887 runner self-check)", () => {
	let db: CommDB;
	let tmpDir: string;

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
				answer: "not-yours",
				phase: "qa",
				epoch: 5,
				holderExecId: "exec-qa",
			}),
		).toBe("not-yours holder=exec-qa phase=qa epoch=5");
	});
});
