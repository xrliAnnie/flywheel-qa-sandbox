/**
 * FLY-817: CommDB↔Bridge-FSM reconcile — delete CommDB `running` rows whose FSM
 * is a non-preserve terminal outcome AND whose tmux target is provably dead.
 *
 * Uses a REAL temp comm.db (the SQL + status semantics are the whole point) with
 * an injected FSM-status lookup + an injected tmux-liveness probe, so no real
 * StateStore / tmux server is needed. Mirrors the FLY-638 sibling test shape.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RECONCILE_DELETABLE_STATES,
	reconcileCommDbRunningAgainstFsm,
} from "../bridge/commdb-fsm-reconcile.js";

describe("commdb-fsm-reconcile (FLY-817)", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly817-reconcile-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	/** Seed a CommDB `running` row (the only shape a zombie ever has). */
	function seedRunning(execId: string, win = `base:@${execId}`): void {
		db.registerSession(execId, win, "flywheel", `i-${execId}`, "lead-a");
	}

	/** FSM lookup from a plain map — undefined ⇒ no FSM row (test scratch). */
	function fsmFrom(map: Record<string, string>) {
		return (id: string): string | undefined => map[id];
	}

	describe("RECONCILE_DELETABLE_STATES", () => {
		it("= AUTO_CLOSE_STATES ∪ {approved} = OUTCOME − {approved_to_ship, failed, blocked}", () => {
			expect([...RECONCILE_DELETABLE_STATES].sort()).toEqual(
				[
					"approved",
					"completed",
					"deferred",
					"rejected",
					"shelved",
					"terminated",
				].sort(),
			);
			// Preserve + still-active states are deliberately absent.
			for (const s of ["failed", "blocked", "approved_to_ship"]) {
				expect(RECONCILE_DELETABLE_STATES.has(s)).toBe(false);
			}
		});
	});

	it("deletes deletable-terminal rows whose tmux target is DEAD (incl legacy `approved`)", async () => {
		for (const st of [
			"completed",
			"rejected",
			"deferred",
			"shelved",
			"terminated",
			"approved",
		]) {
			seedRunning(st);
		}
		const fsm = fsmFrom({
			completed: "completed",
			rejected: "rejected",
			deferred: "deferred",
			shelved: "shelved",
			terminated: "terminated",
			approved: "approved",
		});
		const res = await reconcileCommDbRunningAgainstFsm("flywheel", fsm, {
			dbPath,
			probe: async () => "dead",
		});
		expect(res.scanned).toBe(6);
		expect(res.reconciled).toBe(6);
		expect(res.keptNonTerminal).toBe(0);
		expect(res.keptPreserve).toBe(0);
		expect(res.keptAliveTarget).toBe(0);
		for (const st of ["completed", "approved", "terminated"]) {
			expect(db.getSession(st)).toBeUndefined();
		}
	});

	it("runner-death regression: terminal FSM finalizes its pending checkpoint gate", async () => {
		seedRunning("dead-runner");
		const qid = db.insertQuestion("dead-runner", "lead-a", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmFrom({ "dead-runner": "completed" }),
			{ dbPath, probe: async () => "dead" },
		);
		expect(result.reconciled).toBe(1);
		db.close();
		db = new CommDB(dbPath, false);
		expect(db.getSession("dead-runner")).toBeUndefined();
		expect(db.isQuestionPending(qid)).toBe(false);
	});

	it("finalize failure keeps both session and gate and does not count reconciled", async () => {
		seedRunning("dead-runner");
		const qid = db.insertQuestion("dead-runner", "lead-a", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmFrom({ "dead-runner": "completed" }),
			{
				dbPath,
				probe: async () => "dead",
				finalizeSession: () => {
					throw new Error("locked");
				},
			},
		);
		expect(result.reconciled).toBe(0);
		expect(result.finalizeFailed).toBe(1);
		expect(db.getSession("dead-runner")).toBeDefined();
		expect(db.isQuestionPending(qid)).toBe(true);
	});

	it("BLOCKER 1: NEVER deletes preserve rows (failed/blocked), even with a dead tmux target", async () => {
		seedRunning("f1");
		seedRunning("b1");
		const probe = vi.fn(async () => "dead" as const);
		const res = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmFrom({ f1: "failed", b1: "blocked" }),
			{ dbPath, probe },
		);
		expect(res.scanned).toBe(2);
		expect(res.reconciled).toBe(0);
		expect(res.keptPreserve).toBe(2);
		expect(db.getSession("f1")).toBeDefined();
		expect(db.getSession("b1")).toBeDefined();
		// Preserve rows are decided by FSM alone — never probed.
		expect(probe).not.toHaveBeenCalled();
	});

	it("BLOCKER 2: keeps deletable-terminal rows whose tmux target is ALIVE or INDETERMINATE (no stranding)", async () => {
		seedRunning("alive1");
		seedRunning("flaky1");
		const res = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmFrom({ alive1: "completed", flaky1: "terminated" }),
			{
				dbPath,
				probe: async (w) => (w === "base:@alive1" ? "alive" : "indeterminate"),
			},
		);
		expect(res.scanned).toBe(2);
		expect(res.reconciled).toBe(0);
		expect(res.keptAliveTarget).toBe(2);
		expect(db.getSession("alive1")).toBeDefined();
		expect(db.getSession("flaky1")).toBeDefined();
	});

	it("keeps non-terminal FSM rows without probing (running/awaiting_review/approved_to_ship/pending/reconnecting)", async () => {
		const states = {
			r1: "running",
			ar1: "awaiting_review",
			ats1: "approved_to_ship",
			p1: "pending",
			rc1: "reconnecting",
		};
		for (const id of Object.keys(states)) seedRunning(id);
		const probe = vi.fn(async () => "dead" as const);
		const res = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmFrom(states),
			{ dbPath, probe },
		);
		expect(res.scanned).toBe(5);
		expect(res.reconciled).toBe(0);
		expect(res.keptNonTerminal).toBe(5);
		for (const id of Object.keys(states))
			expect(db.getSession(id)).toBeDefined();
		expect(probe).not.toHaveBeenCalled();
	});

	it("keeps rows with NO FSM row (test-scratch exemption) without probing", async () => {
		seedRunning("orphan1");
		const probe = vi.fn(async () => "dead" as const);
		const res = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmFrom({}), // no FSM evidence
			{ dbPath, probe },
		);
		expect(res.scanned).toBe(1);
		expect(res.reconciled).toBe(0);
		expect(res.keptNonTerminal).toBe(1);
		expect(db.getSession("orphan1")).toBeDefined();
		expect(probe).not.toHaveBeenCalled();
	});

	it("FSM-first ordering: probes ONLY deletable-terminal rows", async () => {
		seedRunning("del1"); // deletable → probed
		seedRunning("keep1"); // non-terminal → not probed
		seedRunning("pres1"); // preserve → not probed
		const probed: string[] = [];
		await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmFrom({ del1: "completed", keep1: "awaiting_review", pres1: "failed" }),
			{
				dbPath,
				probe: async (w) => {
					probed.push(w);
					return "dead";
				},
			},
		);
		expect(probed).toEqual(["base:@del1"]);
	});

	it("mixed scenario: only (deletable terminal + tmux dead) deleted; exact counters", async () => {
		seedRunning("gone", "base:@gone"); // completed + dead → delete
		seedRunning("app", "base:@app"); // approved + dead → delete
		seedRunning("live", "base:@live"); // terminated + alive → keptAliveTarget
		seedRunning("fail", "base:@fail"); // failed → keptPreserve
		seedRunning("review", "base:@review"); // awaiting_review → keptNonTerminal
		seedRunning("scratch", "base:@scratch"); // no FSM → keptNonTerminal
		const res = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmFrom({
				gone: "completed",
				app: "approved",
				live: "terminated",
				fail: "failed",
				review: "awaiting_review",
			}),
			{ dbPath, probe: async (w) => (w === "base:@live" ? "alive" : "dead") },
		);
		expect(res).toEqual({
			scanned: 6,
			reconciled: 2,
			keptNonTerminal: 2,
			keptPreserve: 1,
			keptAliveTarget: 1,
			finalizeFailed: 0,
		});
		expect(db.getSession("gone")).toBeUndefined();
		expect(db.getSession("app")).toBeUndefined();
		expect(db.getSession("live")).toBeDefined();
		expect(db.getSession("fail")).toBeDefined();
		expect(db.getSession("review")).toBeDefined();
		expect(db.getSession("scratch")).toBeDefined();
	});

	it("ignores CommDB completed/timeout rows (not `running` candidates)", async () => {
		db.registerSession("c1", "base:@c1", "flywheel", "i-c1", "lead-a");
		db.updateSessionStatus("c1", "completed");
		db.registerSession("t1", "base:@t1", "flywheel", "i-t1", "lead-a");
		db.updateSessionStatus("t1", "timeout");
		const res = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmFrom({ c1: "completed", t1: "terminated" }),
			{ dbPath, probe: async () => "dead" },
		);
		expect(res.scanned).toBe(0); // neither is `running`
		expect(res.reconciled).toBe(0);
		expect(db.getSession("c1")).toBeDefined();
		expect(db.getSession("t1")).toBeDefined();
	});

	it("`pending` placeholder target deletes when the probe returns dead", async () => {
		seedRunning("pend", "runner-flywheel:pending");
		const res = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmFrom({ pend: "completed" }),
			{ dbPath, probe: async () => "dead" },
		);
		expect(res.reconciled).toBe(1);
		expect(db.getSession("pend")).toBeUndefined();
	});

	describe("best-effort (never throws)", () => {
		it("returns zeros for a nonexistent dbPath", async () => {
			const res = await reconcileCommDbRunningAgainstFsm(
				"flywheel",
				fsmFrom({}),
				{ dbPath: join(dir, "does-not-exist.db"), probe: async () => "dead" },
			);
			expect(res).toEqual({
				scanned: 0,
				reconciled: 0,
				keptNonTerminal: 0,
				keptPreserve: 0,
				keptAliveTarget: 0,
				finalizeFailed: 0,
			});
		});

		it("swallows a probe throw (does not reject; row kept)", async () => {
			seedRunning("boom");
			const res = await reconcileCommDbRunningAgainstFsm(
				"flywheel",
				fsmFrom({ boom: "completed" }),
				{
					dbPath,
					probe: async () => {
						throw new Error("tmux exploded");
					},
				},
			);
			// The throw aborts the loop mid-scan but never propagates.
			expect(res.reconciled).toBe(0);
			expect(db.getSession("boom")).toBeDefined();
		});

		it("refuses an unsafe project name (path traversal) without opening a db", async () => {
			const res = await reconcileCommDbRunningAgainstFsm(
				"../evil",
				fsmFrom({}),
				{ probe: async () => "dead" },
			);
			expect(res.scanned).toBe(0);
		});
	});
});
