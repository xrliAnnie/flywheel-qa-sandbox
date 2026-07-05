/**
 * FLY-638: CommDB session-registry pruning — live delete + boot sweep.
 * Uses a REAL temp comm.db (the SQL + status filter are the whole point) with an
 * injected tmux-liveness probe so no real tmux server is needed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deleteCommDbSession,
	pruneDeadTerminalCommDbSessions,
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
		status: "running" | "completed" | "timeout",
		win = `base:@${execId}`,
	): void {
		db.registerSession(execId, win, "flywheel", `i-${execId}`, "lead-a");
		if (status !== "running") db.updateSessionStatus(execId, status);
	}

	describe("deleteCommDbSession", () => {
		it("deletes an existing row and returns true", () => {
			seed("e1", "completed");
			expect(deleteCommDbSession("e1", "flywheel", dbPath)).toBe(true);
			expect(db.getSession("e1")).toBeUndefined();
		});

		it("is a no-op (false) when the row is absent", () => {
			expect(deleteCommDbSession("missing", "flywheel", dbPath)).toBe(false);
		});

		it("refuses an unsafe project name (path traversal) without opening a db", () => {
			expect(deleteCommDbSession("e1", "../evil")).toBe(false);
		});
	});

	describe("pruneDeadTerminalCommDbSessions", () => {
		it("deletes only PROVABLY-dead terminal rows; keeps alive/indeterminate + running", async () => {
			seed("dead1", "completed", "base:@1");
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
			expect(db.getSession("dead1")).toBeUndefined();
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

		it("returns zeros when there are no terminal sessions", async () => {
			seed("only-running", "running");
			const res = await pruneDeadTerminalCommDbSessions("flywheel", {
				dbPath,
				probe: async () => "dead",
			});
			expect(res).toEqual({ scanned: 0, pruned: 0, kept: 0 });
			expect(db.getSession("only-running")).toBeDefined();
		});
	});
});
