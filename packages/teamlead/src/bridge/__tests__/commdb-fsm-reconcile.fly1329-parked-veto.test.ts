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

	describe("FLY-2498 execution-absence override", () => {
		it("finalizes a dead parked execution and remains empty after reopening/replay", async () => {
			seedRunning("dead-park", true);
			const onFinalizeOutcome = vi.fn();
			const options = {
				dbPath,
				probe: probeDead,
				executionAbsence: async () => "dead" as const,
				onFinalizeOutcome,
			};
			const result = await reconcileCommDbRunningAgainstFsm(
				"flywheel",
				fsmCompleted,
				options,
			);
			expect(result).toMatchObject({
				reconciled: 1,
				parkedOverridden: 1,
				parkedVetoed: 0,
			});
			const reopened = new CommDB(dbPath);
			try {
				expect(reopened.getSession("dead-park")).toBeUndefined();
			} finally {
				reopened.close();
			}
			expect(onFinalizeOutcome).toHaveBeenCalledWith(
				"dead-park",
				"flywheel",
				expect.objectContaining({ ok: true, outcome: "finalized" }),
			);
			expect(
				await reconcileCommDbRunningAgainstFsm(
					"flywheel",
					fsmCompleted,
					options,
				),
			).toMatchObject({ scanned: 0, reconciled: 0, parkedOverridden: 0 });
		});
		it.each(["alive", "unknown", "throws"])(
			"keeps parked execution on %s",
			async (outcome) => {
				seedRunning("uncertain", true);
				const result = await reconcileCommDbRunningAgainstFsm(
					"flywheel",
					fsmCompleted,
					{
						dbPath,
						probe: probeDead,
						executionAbsence: async () => {
							if (outcome === "throws") throw new Error("probe failed");
							return outcome as "alive" | "unknown";
						},
					},
				);
				expect(result).toMatchObject({
					reconciled: 0,
					parkedOverridden: 0,
					parkedVetoed: 1,
				});
				const db = new CommDB(dbPath);
				try {
					expect(db.getSession("uncertain")).toBeDefined();
				} finally {
					db.close();
				}
			},
		);
		it.each(["target_changed", "turn_holder"])(
			"retains identity when %s races with finalization",
			async (reason) => {
				seedRunning("raced", true);
				const result = await reconcileCommDbRunningAgainstFsm(
					"flywheel",
					fsmCompleted,
					{
						dbPath,
						probe: probeDead,
						executionAbsence: async () => "dead",
						finalizePaneLossResidue: (db, exec, target) => {
							if (reason === "turn_holder")
								db.grantTurn("issue-raced", exec, "design", Date.now());
							else
								db.registerSession(
									exec,
									"runner-flywheel:@new",
									"flywheel",
									"issue-raced",
									"eng-lead",
								);
							return db.finalizePaneLossResidue(exec, target);
						},
					},
				);
				expect(result.reconciled).toBe(0);
				const db = new CommDB(dbPath);
				try {
					expect(db.getSession("raced")).toBeDefined();
				} finally {
					db.close();
				}
			},
		);
		it.each([
			"not_parked",
			"superseded",
			"turn_holder",
			"lookup_failed",
			"failed",
			"blocked",
			"missing_fsm",
		])("does not use absence override for %s", async (guard) => {
			seedRunning("guarded", guard !== "not_parked");
			if (guard === "turn_holder") {
				const db = new CommDB(dbPath);
				db.grantTurn("issue-guarded", "guarded", "design", Date.now());
				db.close();
			}
			const executionAbsence = vi.fn(async () => "dead" as const);
			const result = await reconcileCommDbRunningAgainstFsm(
				"flywheel",
				() =>
					guard === "failed" || guard === "blocked"
						? guard
						: guard === "missing_fsm"
							? undefined
							: "completed",
				{
					dbPath,
					probe: probeDead,
					executionAbsence,
					harvest: { orphanMinAgeMs: 0, nowMs: () => Date.now() + 3600000 },
					...(guard === "superseded"
						? { parkedGenerationEvidence: async () => "superseded" as const }
						: {}),
					...(guard === "lookup_failed"
						? {
								isParked: () => {
									throw new Error("lookup failed");
								},
							}
						: {}),
				},
			);
			expect(executionAbsence).not.toHaveBeenCalled();
			expect(result.reconciled).toBe(
				guard === "not_parked" || guard === "superseded" ? 1 : 0,
			);
		});
	});

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
