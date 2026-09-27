import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileCommDbRunningAgainstFsm } from "../commdb-fsm-reconcile.js";

/** Parked is workflow state, never body liveness. TURN and target identity stay hard guards. */
describe("FLY-2919: CommDB running reconcile uses body truth", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly2919-fsm-"));
		dbPath = join(dir, "comm.db");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function seedRunning(
		executionId: string,
		options: { parked?: boolean; tmuxWindow?: string } = {},
	): void {
		const db = new CommDB(dbPath);
		try {
			db.registerSession(
				executionId,
				options.tmuxWindow ?? `runner-flywheel:${executionId}`,
				"flywheel",
				`issue-${executionId}`,
				"eng-lead",
			);
			if (options.parked) {
				db.upsertDeclaredState(
					executionId,
					"parked",
					"awaiting review",
					Date.now(),
					null,
				);
			}
		} finally {
			db.close();
		}
	}

	it("finalizes a dead parked execution and replay is idempotent", async () => {
		seedRunning("dead-park", { parked: true });
		const windowProbe = vi.fn(async () => "alive" as const);
		const options = {
			dbPath,
			probe: windowProbe,
			executionAbsence: async () => "dead" as const,
		};
		expect(
			await reconcileCommDbRunningAgainstFsm(
				"flywheel",
				() => "completed",
				options,
			),
		).toMatchObject({ reconciled: 1, parkedOverridden: 1, parkedVetoed: 0 });
		expect(windowProbe).not.toHaveBeenCalled();
		expect(
			await reconcileCommDbRunningAgainstFsm(
				"flywheel",
				() => "completed",
				options,
			),
		).toMatchObject({ scanned: 0, reconciled: 0 });
	});

	it.each(["alive", "unknown"] as const)(
		"keeps a parked %s body without consulting its missing window",
		async (body) => {
			seedRunning(`parked-${body}`, { parked: true });
			const windowProbe = vi.fn(async () => "dead" as const);
			const result = await reconcileCommDbRunningAgainstFsm(
				"flywheel",
				() => "completed",
				{ dbPath, probe: windowProbe, executionAbsence: async () => body },
			);
			expect(result).toMatchObject({
				reconciled: 0,
				keptAliveTarget: 1,
				parkedVetoed: 0,
			});
			expect(windowProbe).not.toHaveBeenCalled();
			const db = new CommDB(dbPath);
			try {
				expect(db.getSession(`parked-${body}`)).toBeDefined();
			} finally {
				db.close();
			}
		},
	);

	it("treats a throwing body reader as unknown", async () => {
		seedRunning("body-error", { parked: true });
		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			() => "completed",
			{
				dbPath,
				executionAbsence: async () => {
					throw new Error("body store locked");
				},
			},
		);
		expect(result).toMatchObject({ reconciled: 0, keptAliveTarget: 1 });
	});

	it("does not read body liveness for the current TURN holder", async () => {
		seedRunning("turn-holder", { parked: true });
		const db = new CommDB(dbPath);
		try {
			db.grantTurn("FLY-2919", "turn-holder", "implement", 1_000, {
				project: "flywheel",
				sourceEventId: "turn:holder",
			});
		} finally {
			db.close();
		}
		const executionAbsence = vi.fn(async () => "dead" as const);
		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			() => "completed",
			{ dbPath, executionAbsence },
		);
		expect(result).toMatchObject({ reconciled: 0, parkedVetoed: 1 });
		expect(executionAbsence).not.toHaveBeenCalled();
	});

	it("rechecks TURN inside finalization after body sampling", async () => {
		seedRunning("turn-race");
		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			() => "completed",
			{
				dbPath,
				executionAbsence: async () => {
					const db = new CommDB(dbPath);
					try {
						db.grantTurn("FLY-2919", "turn-race", "implement", 1_000, {
							project: "flywheel",
							sourceEventId: "turn:race",
						});
					} finally {
						db.close();
					}
					return "dead";
				},
			},
		);
		expect(result).toMatchObject({ reconciled: 0, parkedVetoed: 1 });
	});

	it("retains a replacement CommDB target installed during body sampling", async () => {
		seedRunning("target-race", { tmuxWindow: "runner-flywheel:@old" });
		const result = await reconcileCommDbRunningAgainstFsm(
			"flywheel",
			() => "completed",
			{
				dbPath,
				executionAbsence: async () => {
					const db = new CommDB(dbPath);
					try {
						db.registerSession(
							"target-race",
							"runner-flywheel:@new",
							"flywheel",
							"issue-target-race",
							"eng-lead",
						);
					} finally {
						db.close();
					}
					return "dead";
				},
			},
		);
		expect(result).toMatchObject({ reconciled: 0, parkedVetoed: 1 });
		const db = new CommDB(dbPath);
		try {
			expect(db.getSession("target-race")?.tmux_window).toBe(
				"runner-flywheel:@new",
			);
		} finally {
			db.close();
		}
	});

	it("declared-state read failure cannot veto a proven dead body", async () => {
		seedRunning("park-read-error", { parked: true });
		const declared = vi
			.spyOn(CommDB.prototype, "getEffectiveDeclaredState")
			.mockImplementation(() => {
				throw new Error("declared state locked");
			});
		try {
			const result = await reconcileCommDbRunningAgainstFsm(
				"flywheel",
				() => "completed",
				{ dbPath, executionAbsence: async () => "dead" },
			);
			expect(result.reconciled).toBe(1);
			expect(result.parkedVetoed).toBe(0);
		} finally {
			declared.mockRestore();
		}
	});
});
