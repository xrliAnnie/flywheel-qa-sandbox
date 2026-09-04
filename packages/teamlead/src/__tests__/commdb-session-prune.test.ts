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
	finalizeCommDbSessionCommunications,
	finalizeCommDbTerminalSession,
	finalizeDeadTerminalCommDbSessionById,
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

	describe("finalizeCommDbSessionCommunications (FLY-2313)", () => {
		it("retires communications while preserving the exact pending identity", () => {
			seed("e1", "completed", "runner-flywheel:pending");
			db.enqueueRunnerPhaseWake(
				"e1",
				{ id: "wake-1", to: "e1", content: "retry design" },
				1,
			);
			db.requestRunnerShutdown("e1", "shutdown-1", 2);
			const qid = db.insertQuestion("e1", "lead-a", "ship?", {
				checkpoint: "approve_to_ship",
			});

			expect(
				finalizeCommDbSessionCommunications(
					"e1",
					"flywheel",
					"runner-flywheel:pending",
					dbPath,
				),
			).toEqual({
				ok: true,
				outcome: "finalized",
				retiredGateCount: 1,
				retiredAskCount: 0,
				deletedSessionCount: 0,
			});
			expect(db.getSession("e1")?.tmux_window).toBe("runner-flywheel:pending");
			expect(db.isQuestionPending(qid)).toBe(false);
			expect(db.listRunnerPhaseWakes("e1")).toMatchObject([
				{ message_id: "wake-1", state: "pending" },
			]);
			expect(db.getRunnerShutdown("e1")?.request_id).toBe("shutdown-1");
		});

		it("fails closed without ledger writes when the target changed", () => {
			seed("e1", "completed", "runner-flywheel:@9");
			db.enqueueRunnerPhaseWake(
				"e1",
				{ id: "wake-1", to: "e1", content: "retry design" },
				1,
			);
			db.requestRunnerShutdown("e1", "shutdown-1", 2);
			const qid = db.insertQuestion("e1", "lead-a", "ship?", {
				checkpoint: "approve_to_ship",
			});

			expect(
				finalizeCommDbSessionCommunications(
					"e1",
					"flywheel",
					"runner-flywheel:pending",
					dbPath,
				),
			).toEqual({
				ok: false,
				outcome: "target_changed",
				retiredGateCount: 0,
				retiredAskCount: 0,
				deletedSessionCount: 0,
				error: "target_changed",
			});
			expect(db.getSession("e1")?.tmux_window).toBe("runner-flywheel:@9");
			expect(db.isQuestionPending(qid)).toBe(true);
			expect(db.listRunnerPhaseWakes("e1")).toHaveLength(1);
			expect(db.getRunnerShutdown("e1")?.request_id).toBe("shutdown-1");
		});

		it.each(["failed", "blocked"] as const)(
			"promotes an unmirrored exact row to authoritative %s before guarded deletion",
			(authoritativeStatus) => {
				seed("e1", "running", "runner-flywheel:pending");

				expect(
					finalizeCommDbTerminalSession(
						"e1",
						"flywheel",
						"runner-flywheel:pending",
						authoritativeStatus,
						dbPath,
					),
				).toEqual({
					ok: true,
					outcome: "finalized",
					retiredGateCount: 0,
					retiredAskCount: 0,
					deletedSessionCount: 1,
				});
				expect(db.getSession("e1")).toBeUndefined();
			},
		);

		it.each(["turn_holder", "parked"] as const)(
			"fails closed without ledger writes for a %s runner",
			(reason) => {
				seed("e1", "completed", "runner-flywheel:pending");
				if (reason === "turn_holder") {
					db.grantTurn("i-e1", "e1", "implement", 1);
				} else {
					db.upsertDeclaredState(
						"e1",
						"parked",
						"awaiting founder",
						Date.now(),
						null,
					);
				}
				db.enqueueRunnerPhaseWake(
					"e1",
					{
						id: "founder-wake-1",
						to: "e1",
						content: "founder decided",
						metadata: { origin: "founder", questionId: "founder-gate-1" },
					},
					2,
				);
				db.requestRunnerShutdown("e1", "shutdown-1", 3);
				const qid = db.insertQuestion("e1", "lead-a", "ship?", {
					checkpoint: "approve_to_ship",
				});

				expect(
					finalizeCommDbSessionCommunications(
						"e1",
						"flywheel",
						"runner-flywheel:pending",
						dbPath,
					),
				).toEqual({
					ok: false,
					outcome: reason,
					retiredGateCount: 0,
					retiredAskCount: 0,
					deletedSessionCount: 0,
					error: reason,
				});
				expect(db.isQuestionPending(qid)).toBe(true);
				expect(db.listRunnerPhaseWakes("e1")).toMatchObject([
					{ message_id: "founder-wake-1", state: "pending" },
				]);
				expect(db.getRunnerShutdown("e1")?.request_id).toBe("shutdown-1");
			},
		);
	});

	describe("pruneDeadTerminalCommDbSessions", () => {
		it("deletes only PROVABLY-dead terminal rows in any scan order; keeps alive/indeterminate + running", async () => {
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
			const rawDb = db as unknown as {
				db: { prepare(sql: string): { run(...params: string[]): void } };
			};
			// listSessions orders by started_at, not execution_id. Force the valid
			// scan order opposite to the fixture labels so this contract stays a set.
			rawDb.db
				.prepare("UPDATE sessions SET started_at = ? WHERE execution_id = ?")
				.run("2026-08-18T01:00:00.000Z", "dead1");
			rawDb.db
				.prepare("UPDATE sessions SET started_at = ? WHERE execution_id = ?")
				.run("2026-08-18T01:00:01.000Z", "dead2");

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
			expect(
				[...res.provenDeadTargets].sort((a, b) =>
					a.executionId.localeCompare(b.executionId),
				),
			).toEqual([
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

	describe("finalizeDeadTerminalCommDbSessionById (FLY-2302)", () => {
		it("finalizes a blocked row whose tmux target is proven dead", async () => {
			seed("blocked-dead", "blocked", "base:@blocked");
			const onFinalizeOutcome = vi.fn();
			const openReadonly = vi.fn((path: string) => CommDB.openReadonly(path));
			const openWritable = vi.fn((path: string) => new CommDB(path));

			expect(
				await finalizeDeadTerminalCommDbSessionById(
					"flywheel",
					"blocked-dead",
					{
						dbPath,
						includeCrashPreserve: true,
						probe: async () => "dead",
						onFinalizeOutcome,
						openReadonly,
						openWritable,
					},
				),
			).toBe("finalized");
			expect(openReadonly).toHaveBeenCalledExactlyOnceWith(dbPath);
			expect(openWritable).toHaveBeenCalledExactlyOnceWith(dbPath);
			expect(db.getSession("blocked-dead")).toBeUndefined();
			expect(onFinalizeOutcome).toHaveBeenCalledExactlyOnceWith(
				"blocked-dead",
				"flywheel",
				expect.objectContaining({ ok: true, outcome: "finalized" }),
			);
		});

		it("keeps a blocked row while its crash-preserve pane is alive", async () => {
			seed("blocked-alive", "blocked", "base:@alive");
			const openReadonly = vi.fn((path: string) => CommDB.openReadonly(path));
			const openWritable = vi.fn((path: string) => new CommDB(path));

			expect(
				await finalizeDeadTerminalCommDbSessionById(
					"flywheel",
					"blocked-alive",
					{
						dbPath,
						includeCrashPreserve: true,
						probe: async () => "alive",
						openReadonly,
						openWritable,
					},
				),
			).toBe("kept_alive");
			expect(openReadonly).toHaveBeenCalledExactlyOnceWith(dbPath);
			expect(openWritable).not.toHaveBeenCalled();
			expect(db.getSession("blocked-alive")).toBeDefined();
		});

		it("keeps a blocked row when the tmux probe is indeterminate", async () => {
			seed("blocked-unknown", "blocked", "base:@unknown");

			expect(
				await finalizeDeadTerminalCommDbSessionById(
					"flywheel",
					"blocked-unknown",
					{
						dbPath,
						includeCrashPreserve: true,
						probe: async () => "indeterminate",
					},
				),
			).toBe("kept_indeterminate");
			expect(db.getSession("blocked-unknown")).toBeDefined();
		});

		it("keeps the current TURN holder without probing its tmux target", async () => {
			seed("blocked-holder", "blocked", "base:@holder");
			db.grantTurn("i-blocked-holder", "blocked-holder", "implement", 1_000, {
				project: "flywheel",
				sourceEventId: "turn:blocked-holder",
			});
			const probe = vi.fn(async () => "dead" as const);

			expect(
				await finalizeDeadTerminalCommDbSessionById(
					"flywheel",
					"blocked-holder",
					{
						dbPath,
						includeCrashPreserve: true,
						probe,
					},
				),
			).toBe("kept_turn_holder");
			expect(probe).not.toHaveBeenCalled();
			expect(db.getSession("blocked-holder")).toBeDefined();
		});

		it("keeps a same-id row from another project without probing tmux", async () => {
			db.registerSession(
				"foreign",
				"base:@foreign",
				"other-project",
				"FLY-2302",
				"lead-a",
			);
			db.markSessionTerminalStatus("foreign", "blocked");
			const probe = vi.fn(async () => "dead" as const);

			expect(
				await finalizeDeadTerminalCommDbSessionById("flywheel", "foreign", {
					dbPath,
					includeCrashPreserve: true,
					probe,
				}),
			).toBe("kept_project_mismatch");
			expect(probe).not.toHaveBeenCalled();
			expect(db.getSession("foreign")).toBeDefined();
		});

		it("keeps a running row without probing tmux", async () => {
			seed("still-running", "running", "base:@running");
			const probe = vi.fn(async () => "dead" as const);

			expect(
				await finalizeDeadTerminalCommDbSessionById(
					"flywheel",
					"still-running",
					{
						dbPath,
						includeCrashPreserve: true,
						probe,
					},
				),
			).toBe("kept_status");
			expect(probe).not.toHaveBeenCalled();
			expect(db.getSession("still-running")).toBeDefined();
		});

		it("keeps a parked blocked row without probing tmux", async () => {
			seed("blocked-parked", "blocked", "base:@parked");
			db.upsertDeclaredState(
				"blocked-parked",
				"parked",
				"awaiting replacement",
				Date.now(),
				null,
			);
			const probe = vi.fn(async () => "dead" as const);

			expect(
				await finalizeDeadTerminalCommDbSessionById(
					"flywheel",
					"blocked-parked",
					{
						dbPath,
						includeCrashPreserve: true,
						probe,
					},
				),
			).toBe("kept_parked");
			expect(probe).not.toHaveBeenCalled();
			expect(db.getSession("blocked-parked")).toBeDefined();
		});

		it("returns failed and audits a point-finalize transaction error", async () => {
			seed("blocked-failure", "blocked", "base:@failure");
			const onFinalizeOutcome = vi.fn();
			const finalize = vi
				.spyOn(CommDB.prototype, "finalizePaneLossResidue")
				.mockImplementation(() => {
					throw new Error("forced point-finalize failure");
				});

			try {
				expect(
					await finalizeDeadTerminalCommDbSessionById(
						"flywheel",
						"blocked-failure",
						{
							dbPath,
							includeCrashPreserve: true,
							probe: async () => "dead",
							onFinalizeOutcome,
						},
					),
				).toBe("failed");
			} finally {
				finalize.mockRestore();
			}
			expect(db.getSession("blocked-failure")).toBeDefined();
			expect(onFinalizeOutcome).toHaveBeenCalledExactlyOnceWith(
				"blocked-failure",
				"flywheel",
				expect.objectContaining({
					ok: false,
					outcome: "failed",
					error: "forced point-finalize failure",
				}),
			);
		});

		it("returns no_row without probing when the execution is absent", async () => {
			const probe = vi.fn(async () => "dead" as const);

			expect(
				await finalizeDeadTerminalCommDbSessionById("flywheel", "missing", {
					dbPath,
					includeCrashPreserve: true,
					probe,
				}),
			).toBe("no_row");
			expect(probe).not.toHaveBeenCalled();
		});

		it("keeps blocked when crash-preserve eligibility is disabled", async () => {
			seed("blocked-flag-off", "blocked", "base:@flag-off");
			const probe = vi.fn(async () => "dead" as const);

			expect(
				await finalizeDeadTerminalCommDbSessionById(
					"flywheel",
					"blocked-flag-off",
					{ dbPath, includeCrashPreserve: false, probe },
				),
			).toBe("kept_status");
			expect(probe).not.toHaveBeenCalled();
			expect(db.getSession("blocked-flag-off")).toBeDefined();
		});

		it("fails closed when declared-state lookup throws", async () => {
			seed("blocked-state-error", "blocked", "base:@state-error");
			const declaredState = vi
				.spyOn(CommDB.prototype, "getEffectiveDeclaredState")
				.mockImplementation(() => {
					throw new Error("declared-state unavailable");
				});

			try {
				expect(
					await finalizeDeadTerminalCommDbSessionById(
						"flywheel",
						"blocked-state-error",
						{
							dbPath,
							includeCrashPreserve: true,
							probe: async () => "dead",
						},
					),
				).toBe("kept_parked");
			} finally {
				declaredState.mockRestore();
			}
			expect(db.getSession("blocked-state-error")).toBeDefined();
		});

		it("keeps the row when its tmux target changes during the probe", async () => {
			seed("blocked-target-race", "blocked", "base:@old");

			expect(
				await finalizeDeadTerminalCommDbSessionById(
					"flywheel",
					"blocked-target-race",
					{
						dbPath,
						includeCrashPreserve: true,
						probe: async () => {
							db.registerSession(
								"blocked-target-race",
								"base:@new",
								"flywheel",
								"i-blocked-target-race",
								"lead-a",
							);
							return "dead";
						},
					},
				),
			).toBe("kept_target_changed");
			expect(db.getSession("blocked-target-race")?.tmux_window).toBe(
				"base:@new",
			);
		});
	});
});
