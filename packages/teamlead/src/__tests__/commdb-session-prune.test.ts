/**
 * FLY-638: CommDB session-registry pruning — live delete + boot sweep.
 * Uses a REAL temp comm.db (the SQL + status filter are the whole point) with an
 * injected tmux-liveness probe so no real tmux server is needed.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commDbPathForProject } from "../bridge/commdb-path.js";
import {
	finalizeCommDbSession,
	pruneDeadTerminalCommDbSessions,
	resolveCommDbPath,
} from "../bridge/commdb-session-prune.js";

describe("commdb-session-prune (FLY-638)", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly638-prune-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function seed(
		execId: string,
		status: "running" | "completed" | "timeout" | "failed" | "blocked",
		win = `base:@${execId}`,
	): void {
		db.registerSession(execId, win, "flywheel", `i-${execId}`, "lead-a");
		if (status === "failed" || status === "blocked") {
			db.markSessionTerminalStatus(execId, status);
		} else if (status !== "running") {
			db.updateSessionStatus(execId, status);
		}
	}

	describe("finalizeCommDbSession", () => {
		it("uses the same FLYWHEEL_COMM_DIR resolver as gate retirement", () => {
			const previousDir = process.env.FLYWHEEL_COMM_DIR;
			const previousRoot = process.env.FLYWHEEL_COMM_ROOT;
			const commRoot = join(dir, "comm-root");
			const projectDir = join(commRoot, "flywheel");
			mkdirSync(projectDir, { recursive: true });
			const isolated = new CommDB(join(projectDir, "comm.db"));
			isolated.close();
			try {
				process.env.FLYWHEEL_COMM_DIR = commRoot;
				delete process.env.FLYWHEEL_COMM_ROOT;
				expect(resolveCommDbPath("flywheel")).toBe(
					commDbPathForProject("flywheel"),
				);
			} finally {
				if (previousDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
				else process.env.FLYWHEEL_COMM_DIR = previousDir;
				if (previousRoot === undefined) delete process.env.FLYWHEEL_COMM_ROOT;
				else process.env.FLYWHEEL_COMM_ROOT = previousRoot;
			}
		});

		it("terminal-disposes pending gates while deleting the existing row by default", () => {
			seed("e1", "completed");
			db.enqueueRunnerPhaseWake(
				"e1",
				{ id: "wake-1", to: "e1", content: "retry design" },
				1,
			);
			db.requestRunnerShutdown("e1", "shutdown-1", 2);
			const qid = db.insertQuestion("e1", "lead-a", "ship?", {
				checkpoint: "approve_to_ship",
			});
			expect(finalizeCommDbSession("e1", "flywheel", dbPath)).toEqual({
				ok: true,
				outcome: "finalized",
				retiredGateCount: 1,
				// FLY-1328: no checkpoint-less asks on this session to cascade.
				retiredAskCount: 0,
				deletedSessionCount: 1,
			});
			expect(db.getSession("e1")).toBeUndefined();
			expect(db.isQuestionPending(qid)).toBe(false);
			expect(db.listRunnerPhaseWakes("e1")).toEqual([]);
			expect(db.getRunnerShutdown("e1")).toBeNull();
			expect(db.getMessageById(qid)?.relay_state).toBe("terminal_disposed");
		});

		it("is an explicit successful no-op when the DB is absent", () => {
			expect(finalizeCommDbSession("missing", "../evil")).toEqual({
				ok: true,
				outcome: "no_db",
				retiredGateCount: 0,
				retiredAskCount: 0,
				deletedSessionCount: 0,
			});
		});

		it("surfaces transaction failure and leaves session + gate intact", () => {
			seed("e1", "completed");
			db.enqueueRunnerPhaseWake(
				"e1",
				{ id: "wake-1", to: "e1", content: "retry design" },
				1,
			);
			db.requestRunnerShutdown("e1", "shutdown-1", 2);
			const qid = db.insertQuestion("e1", "lead-a", "ship?", {
				checkpoint: "approve_to_ship",
			});
			(db as unknown as { db: { exec(sql: string): void } }).db.exec(`
				CREATE TRIGGER abort_finalize BEFORE DELETE ON sessions
				WHEN OLD.execution_id = 'e1'
				BEGIN SELECT RAISE(ABORT, 'forced'); END
			`);
			const result = finalizeCommDbSession("e1", "flywheel", dbPath);
			expect(result).toMatchObject({ ok: false, outcome: "failed" });
			expect(db.getSession("e1")).toBeDefined();
			expect(db.isQuestionPending(qid)).toBe(true);
			expect(db.listRunnerPhaseWakes("e1")).toHaveLength(1);
			expect(db.getRunnerShutdown("e1")?.request_id).toBe("shutdown-1");
		});
	});

	describe("pruneDeadTerminalCommDbSessions", () => {
		it("deletes only PROVABLY-dead terminal rows; keeps alive/indeterminate + running", async () => {
			seed("dead1", "completed", "base:@1");
			db.enqueueRunnerPhaseWake(
				"dead1",
				{ id: "wake-dead", to: "dead1", content: "stale" },
				1,
			);
			db.requestRunnerShutdown("dead1", "shutdown-dead", 2);
			seed("dead2", "timeout", "base:@2");
			seed("parked", "completed", "base:@3"); // terminal but tmux alive
			seed("flaky", "completed", "base:@5"); // terminal but probe indeterminate
			seed("run", "running", "base:@4"); // running → never a prune candidate

			const res = await pruneDeadTerminalCommDbSessions("flywheel", {
				dbPath,
				probe: async (w) => {
					if (w === "base:@3") return "alive";
					if (w === "base:@5") return "indeterminate";
					return "dead";
				},
			});

			// Only terminal rows are scanned (running is excluded by the SQL filter).
			expect(res.scanned).toBe(4);
			expect(res.pruned).toBe(2); // dead1 + dead2 (proven dead)
			expect(res.kept).toBe(2); // parked (alive) + flaky (indeterminate)
			expect(res.failed).toBe(0);
			expect(res.provenDeadTargets).toEqual([
				{ executionId: "dead1", tmuxWindow: "base:@1" },
				{ executionId: "dead2", tmuxWindow: "base:@2" },
			]);
			expect(db.getSession("dead1")).toBeUndefined();
			expect(db.listRunnerPhaseWakes("dead1")).toEqual([]);
			expect(db.getRunnerShutdown("dead1")).toBeNull();
			expect(db.getSession("dead2")).toBeUndefined();
			expect(db.getSession("parked")).toBeDefined(); // alive → kept
			expect(db.getSession("flaky")).toBeDefined(); // indeterminate → kept (no proof of death)
			expect(db.getSession("run")).toBeDefined(); // running → untouched
		});

		it("NEVER deletes when the probe is indeterminate (no proof of death)", async () => {
			seed("t1", "completed", "base:@1");
			seed("t2", "timeout", "base:@2");
			const res = await pruneDeadTerminalCommDbSessions("flywheel", {
				dbPath,
				probe: async () => "indeterminate",
			});
			expect(res.scanned).toBe(2);
			expect(res.pruned).toBe(0);
			expect(res.kept).toBe(2);
			expect(db.getSession("t1")).toBeDefined();
			expect(db.getSession("t2")).toBeDefined();
		});

		it("FLY-1374 never finalizes the current TURN holder even when its stale window target probes dead", async () => {
			seed("holder", "completed", "stale:@holder");
			db.grantTurn("FLY-1374", "holder", "implement", 1_000, {
				project: "flywheel",
				sourceEventId: "turn:holder",
			});

			const probe = vi.fn(async () => "dead" as const);
			const res = await pruneDeadTerminalCommDbSessions("flywheel", {
				dbPath,
				probe,
			});

			expect(res).toMatchObject({
				scanned: 1,
				pruned: 0,
				parkedVetoed: 1,
			});
			expect(probe).not.toHaveBeenCalled();
			expect(db.getSession("holder")).toBeDefined();
			expect(db.getTurn("FLY-1374")?.holder_exec_id).toBe("holder");
		});

		it("FLY-1374 rechecks TURN authority atomically when a holder is granted during the liveness probe", async () => {
			seed("holder", "completed", "stale:@holder");

			const res = await pruneDeadTerminalCommDbSessions("flywheel", {
				dbPath,
				probe: async () => {
					db.grantTurn("FLY-1374", "holder", "implement", 1_000, {
						project: "flywheel",
						sourceEventId: "turn:holder-during-probe",
					});
					return "dead";
				},
			});

			expect(res).toMatchObject({
				scanned: 1,
				pruned: 0,
				parkedVetoed: 1,
			});
			expect(res.provenDeadTargets).toEqual([]);
			expect(db.getSession("holder")).toBeDefined();
			expect(db.getTurn("FLY-1374")?.holder_exec_id).toBe("holder");
		});

		it("FLY-1066 harvest expands the proven-dead scan to failed/blocked", async () => {
			seed("failed-dead", "failed", "base:@failed");
			seed("blocked-dead", "blocked", "base:@blocked");
			seed("failed-alive", "failed", "base:@alive");

			const res = await pruneDeadTerminalCommDbSessions("flywheel", {
				dbPath,
				includeCrashPreserve: true,
				probe: async (window) => (window === "base:@alive" ? "alive" : "dead"),
			});

			expect(res).toEqual({
				scanned: 3,
				pruned: 2,
				kept: 1,
				failed: 0,
				provenDeadTargets: [
					{ executionId: "failed-dead", tmuxWindow: "base:@failed" },
					{ executionId: "blocked-dead", tmuxWindow: "base:@blocked" },
				],
				// FLY-1329 (A4): parkedVetoed joins the counters.
				parkedVetoed: 0,
			});
			expect(db.getSession("failed-dead")).toBeUndefined();
			expect(db.getSession("blocked-dead")).toBeUndefined();
			expect(db.getSession("failed-alive")).toBeDefined();
		});

		it("keeps successful dead-target evidence when audit recording throws", async () => {
			seed("audit-throws", "completed", "base:@7");

			const res = await pruneDeadTerminalCommDbSessions("flywheel", {
				dbPath,
				probe: async () => "dead",
				onFinalizeOutcome: () => {
					throw new Error("StateStore unavailable");
				},
			});

			expect(res).toEqual({
				scanned: 1,
				pruned: 1,
				kept: 0,
				failed: 0,
				provenDeadTargets: [
					{ executionId: "audit-throws", tmuxWindow: "base:@7" },
				],
				// FLY-1329 (A4): parkedVetoed joins the counters.
				parkedVetoed: 0,
			});
			expect(db.getSession("audit-throws")).toBeUndefined();
		});

		it("harvest flag off preserves the legacy completed/timeout scan exactly", async () => {
			seed("failed-dead", "failed", "base:@failed");
			seed("blocked-dead", "blocked", "base:@blocked");
			seed("completed-dead", "completed", "base:@completed");

			const probe = vi.fn(async () => "dead" as const);
			const res = await pruneDeadTerminalCommDbSessions("flywheel", {
				dbPath,
				includeCrashPreserve: false,
				probe,
			});

			expect(res).toEqual({
				scanned: 1,
				pruned: 1,
				kept: 0,
				failed: 0,
				provenDeadTargets: [
					{ executionId: "completed-dead", tmuxWindow: "base:@completed" },
				],
				// FLY-1329 (A4): parkedVetoed joins the counters.
				parkedVetoed: 0,
			});
			expect(probe).toHaveBeenCalledExactlyOnceWith("base:@completed");
			expect(db.getSession("failed-dead")).toBeDefined();
			expect(db.getSession("blocked-dead")).toBeDefined();
			expect(db.getSession("completed-dead")).toBeUndefined();
		});

		it("returns zeros when there are no terminal sessions", async () => {
			seed("only-running", "running");
			const res = await pruneDeadTerminalCommDbSessions("flywheel", {
				dbPath,
				probe: async () => "dead",
			});
			expect(res).toEqual({
				scanned: 0,
				pruned: 0,
				kept: 0,
				failed: 0,
				provenDeadTargets: [],
				// FLY-1329 (A4): parkedVetoed joins the counters.
				parkedVetoed: 0,
			});
			expect(db.getSession("only-running")).toBeDefined();
		});
	});
});
