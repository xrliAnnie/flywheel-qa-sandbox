import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileCommDbRunningAgainstFsm } from "../commdb-fsm-reconcile.js";

/**
 * FLY-1329 (A4, Codex R1 HIGH-2): the CommDB row prune had a SECOND delete site
 * the parked-veto missed.
 *
 * `pruneDeadTerminalCommDbSessions` (terminal-face) got the veto in the first
 * pass. But `reconcileCommDbRunningAgainstFsm` (running-face) runs FIRST on boot
 * (plugin.ts) and deletes a CommDB `running` row whenever its FSM status is a
 * deletable terminal AND its tmux target probes `dead`. That probe's `dead` is
 * `isTmuxAbsenceMessage` — the same stale-window-name reading A1 refuses to
 * destroy on. So a parked runner (marker present) whose FSM went terminal and
 * whose window name went stale had its CommDB row deleted here, before the
 * terminal-face sweep the veto guarded ever ran.
 *
 * An unexpired park declaration vetoes this delete too. Real CommDB — the row
 * must genuinely survive.
 */
describe("FLY-1329 A4: reconcileCommDbRunningAgainstFsm respects a park declaration", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1329-fsm-"));
		dbPath = join(dir, "comm.db");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A CommDB `running` row whose window name no longer resolves. */
	function seedRunning(execId: string, parked: boolean): void {
		const db = new CommDB(dbPath);
		try {
			db.registerSession(
				execId,
				`runner-flywheel:${execId}`,
				"flywheel",
				`issue-${execId}`,
				"eng-lead",
			);
			if (parked) {
				db.upsertDeclaredState(
					execId,
					"parked",
					"DAG workflow implement parked awaiting QA",
					Date.now(),
					null, // no expiry
				);
			}
		} finally {
			db.close();
		}
	}

	/** FSM says completed (deletable); tmux says the window is gone. */
	const fsmCompleted = () => "completed";
	const probeDead = vi.fn(async () => "dead" as const);

	it("KEEPS a parked runner's row even when FSM=completed and tmux probes dead", async () => {
		seedRunning("parked-alive", true);

		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmCompleted,
			{ dbPath, probe: probeDead },
		);

		expect(result.scanned).toBe(1);
		expect(result.reconciled).toBe(0);
		expect(result.parkedVetoed).toBe(1);

		const db = new CommDB(dbPath);
		try {
			expect(db.getSession("parked-alive")).toBeTruthy();
		} finally {
			db.close();
		}
	});

	it("still deletes a genuine zombie (no park declaration)", async () => {
		seedRunning("real-zombie", false);

		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmCompleted,
			{ dbPath, probe: probeDead },
		);

		expect(result.parkedVetoed).toBe(0);
		expect(result.reconciled).toBe(1);

		const db = new CommDB(dbPath);
		try {
			expect(db.getSession("real-zombie")).toBeFalsy();
		} finally {
			db.close();
		}
	});

	it("releases the parked veto only with superseded generation evidence", async () => {
		seedRunning("superseded-park", true);

		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmCompleted,
			{
				dbPath,
				probe: probeDead,
				parkedGenerationEvidence: async () => "superseded",
			},
		);

		expect(result.reconciled).toBe(1);
		expect(result.parkedVetoed).toBe(0);
		const db = new CommDB(dbPath);
		try {
			expect(db.getSession("superseded-park")).toBeFalsy();
		} finally {
			db.close();
		}
	});

	it("keeps the parked row when the exact target changes at finalize", async () => {
		seedRunning("retargeted-park", true);
		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmCompleted,
			{
				dbPath,
				probe: probeDead,
				parkedGenerationEvidence: async () => "superseded",
				finalizePaneLossResidue: (db, executionId) => {
					db.registerSession(
						executionId,
						"runner-flywheel:@99",
						"flywheel",
						`issue-${executionId}`,
						"eng-lead",
					);
					return db.finalizePaneLossResidue(
						executionId,
						`runner-flywheel:${executionId}`,
					);
				},
			},
		);

		expect(result.reconciled).toBe(0);
		expect(result.parkedVetoed).toBe(1);
		const db = new CommDB(dbPath);
		try {
			expect(db.getSession("retargeted-park")?.tmux_window).toBe(
				"runner-flywheel:@99",
			);
		} finally {
			db.close();
		}
	});

	it("fail-closed: an isParked lookup that throws keeps the row", async () => {
		seedRunning("unknowable", true);

		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			fsmCompleted,
			{
				dbPath,
				probe: probeDead,
				isParked: () => {
					throw new Error("CommDB locked");
				},
			},
		);

		expect(result.reconciled).toBe(0);
		expect(result.parkedVetoed).toBe(1);
		const db = new CommDB(dbPath);
		try {
			expect(db.getSession("unknowable")).toBeTruthy();
		} finally {
			db.close();
		}
	});
});
