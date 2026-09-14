import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import { harvestTerminalCodexDaemon } from "../codex-terminal-harvest.js";
import { reconcileCommDbRunningAgainstFsm } from "../commdb-fsm-reconcile.js";

function fixture() {
	let session = {
		execution_id: "exec",
		project_name: "project",
		adapter_type: "codex-tmux",
		status: "completed",
	} as Session;
	let owned = false;
	let hold: string | undefined;
	const close = vi.fn(async (_session: Session, beforeSignal: () => boolean) =>
		beforeSignal(),
	);
	const deps = {
		getSession: () => session,
		isOwned: () => owned,
		residentHoldState: () => hold,
		targetUnchangedAndNoTurn: () => true,
		discover: vi.fn(async () => ({ kind: "missing" as const })),
		evidence: vi.fn(async () => ({
			liveness: "alive" as const,
			ledger: "valid_group" as const,
			socketLive: true,
			spawnLock: "stale" as const,
		})),
		absence: vi.fn(async () => "dead" as const),
		close,
	};
	return {
		deps,
		setOwned: (value: boolean) => {
			owned = value;
		},
		setHold: (value: string) => {
			hold = value;
		},
		setSession: (value: Partial<Session>) => {
			session = { ...session, ...value };
		},
	};
}

describe("FLY-2555 terminal Codex daemon harvest", () => {
	it("requests graceful close for an unowned terminal daemon but retains the row this pass", async () => {
		const f = fixture();
		expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
			"keep",
		);
		expect(f.deps.close).toHaveBeenCalledOnce();
		expect(f.deps.absence).not.toHaveBeenCalled();
	});
	it.each(["running", "pending", "blocked"])(
		"does not close %s",
		async (status) => {
			const f = fixture();
			f.setSession({ status: status as Session["status"] });
			expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
				"keep",
			);
			expect(f.deps.close).not.toHaveBeenCalled();
		},
	);
	it("does not close Claude", async () => {
		const f = fixture();
		f.setSession({ adapter_type: "claude-tmux" });
		expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
			"not_applicable",
		);
		expect(f.deps.close).not.toHaveBeenCalled();
	});
	it.each(["owner", "resident", "woken"])("protects %s", async (guard) => {
		const f = fixture();
		if (guard === "owner") f.setOwned(true);
		else f.setHold(guard);
		expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
			"keep",
		);
		expect(f.deps.close).not.toHaveBeenCalled();
	});
	it("rechecks owner inside the final signal guard", async () => {
		const f = fixture();
		f.deps.close.mockImplementation(async (_session, beforeSignal) => {
			f.setOwned(true);
			expect(beforeSignal()).toBe(false);
			return false;
		});
		expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
			"keep",
		);
	});
	it("only offers absence after existing execution-wide proof succeeds", async () => {
		const f = fixture();
		f.deps.evidence.mockResolvedValue({
			liveness: "absent",
			ledger: "valid_group",
			socketLive: false,
			spawnLock: "stale",
		} as never);
		expect(
			await harvestTerminalCodexDaemon("exec", "project", f.deps),
		).toMatchObject({ kind: "absent", canFinalize: expect.any(Function) });
		expect(f.deps.close).not.toHaveBeenCalled();
		expect(f.deps.absence).toHaveBeenCalledOnce();
	});
	it("unknown daemon without a live socket cannot be reaped or pruned", async () => {
		const f = fixture();
		f.deps.evidence.mockResolvedValue({
			liveness: "unknown",
			ledger: "missing",
			socketLive: false,
			spawnLock: "absent",
		} as never);
		expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
			"keep",
		);
		expect(f.deps.close).not.toHaveBeenCalled();
		expect(f.deps.absence).not.toHaveBeenCalled();
	});
	it("preserves renamed or uncertain windows", async () => {
		const f = fixture();
		f.deps.discover.mockResolvedValue({
			kind: "found",
			tmuxWindow: "other:@1",
		} as never);
		expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
			"keep",
		);
		expect(f.deps.close).not.toHaveBeenCalled();
	});
	it.each(["found", "indeterminate", "ambiguous"] as const)(
		"retains when discovery becomes %s during daemon evidence",
		async (kind) => {
			const f = fixture();
			f.deps.evidence.mockImplementation(async () => {
				await Promise.resolve();
				f.deps.discover.mockResolvedValue({
					kind,
					tmuxWindow: "runner:@new",
				} as never);
				return {
					liveness: "alive",
					ledger: "valid_group",
					socketLive: true,
					spawnLock: "stale",
				};
			});
			expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
				"keep",
			);
			expect(f.deps.discover).toHaveBeenCalledTimes(2);
			expect(f.deps.close).not.toHaveBeenCalled();
			expect(f.deps.absence).not.toHaveBeenCalled();
		},
	);

	it("retains when initial marker discovery is unknown", async () => {
		const f = fixture();
		f.deps.discover.mockResolvedValue({ kind: "indeterminate" } as never);
		expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
			"keep",
		);
		expect(f.deps.evidence).not.toHaveBeenCalled();
		expect(f.deps.close).not.toHaveBeenCalled();
	});

	it("fails closed if an authority query throws", async () => {
		const f = fixture();
		f.deps.isOwned = () => {
			throw new Error("unavailable");
		};
		expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
			"keep",
		);
		expect(f.deps.close).not.toHaveBeenCalled();
	});
	it.each(["resident", "woken", "running", "target_changed"])(
		"final signal guard catches %s race",
		async (race) => {
			const f = fixture();
			f.deps.close.mockImplementation(async (_session, beforeSignal) => {
				if (race === "running") f.setSession({ status: "running" });
				else if (race === "target_changed")
					f.deps.targetUnchangedAndNoTurn = () => false;
				else f.setHold(race);
				expect(beforeSignal()).toBe(false);
				return false;
			});
			expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
				"keep",
			);
		},
	);
	it("unknown absence after daemon exit never prunes", async () => {
		const f = fixture();
		f.deps.evidence.mockResolvedValue({
			liveness: "absent",
			ledger: "valid_group",
			socketLive: false,
			spawnLock: "stale",
		} as never);
		f.deps.absence.mockResolvedValue("unknown" as never);
		expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
			"keep",
		);
	});
	it.each(["discover", "evidence", "close"] as const)(
		"%s failure retains the row",
		async (step) => {
			const f = fixture();
			f.deps[step].mockRejectedValue(new Error("unavailable"));
			expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
				"keep",
			);
			if (step !== "close") expect(f.deps.close).not.toHaveBeenCalled();
		},
	);
});

describe("FLY-2555 real CommDB two-pass convergence", () => {
	it("rechecks ownership after awaiting parked-generation evidence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2555-finalize-"));
		const dbPath = join(dir, "comm.db");
		const db = new CommDB(dbPath);
		const f = fixture();
		f.deps.evidence.mockResolvedValue({
			liveness: "absent",
			ledger: "valid_group",
			socketLive: false,
			spawnLock: "stale",
		} as never);
		try {
			db.registerSession("exec", "runner:@old", "project", "issue", "lead");
			db.upsertDeclaredState("exec", "parked", "done", Date.now(), null);
			const result = await reconcileCommDbRunningAgainstFsm(
				"project",
				() => "completed",
				{
					dbPath,
					harvest: { orphanMinAgeMs: 86400000, nowMs: Date.now },
					probe: async () => "dead",
					harvestCodexDaemon: async () =>
						harvestTerminalCodexDaemon("exec", "project", f.deps),
					parkedGenerationEvidence: async () => {
						f.setOwned(true);
						return "unavailable";
					},
				},
			);
			expect(result.reconciled).toBe(0);
			expect(db.getSession("exec")).toBeDefined();
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([undefined, ""])(
		"preserves legacy Claude routing with adapter=%s",
		async (adapter_type) => {
			const f = fixture();
			f.setSession({ adapter_type } as Partial<Session>);
			expect(await harvestTerminalCodexDaemon("exec", "project", f.deps)).toBe(
				"not_applicable",
			);
			expect(f.deps.close).not.toHaveBeenCalled();
		},
	);

	it.each(["target_changed", "turn_acquired"])(
		"real CommDB %s during close vetoes the final signal",
		async (race) => {
			const dir = mkdtempSync(join(tmpdir(), "fly2555-final-guard-"));
			const dbPath = join(dir, "comm.db");
			const db = new CommDB(dbPath);
			const f = fixture();
			const signals = vi.fn();
			let guardAccepted: boolean | undefined;
			try {
				db.registerSession("exec", "runner:@old", "project", "issue", "lead");
				f.deps.close.mockImplementation(async (_session, beforeSignal) => {
					await Promise.resolve();
					if (race === "target_changed")
						db.registerSession(
							"exec",
							"runner:@new",
							"project",
							"issue",
							"lead",
						);
					else db.grantTurn("issue", "exec", "implement", Date.now());
					guardAccepted = beforeSignal();
					if (guardAccepted) signals("SIGTERM");
					return guardAccepted;
				});
				const result = await reconcileCommDbRunningAgainstFsm(
					"project",
					() => "completed",
					{
						dbPath,
						harvest: { orphanMinAgeMs: 86400000, nowMs: Date.now },
						probe: async () => "dead",
						harvestCodexDaemon: async (
							executionId,
							project,
							_target,
							targetUnchangedAndNoTurn,
						) =>
							harvestTerminalCodexDaemon(executionId, project, {
								...f.deps,
								targetUnchangedAndNoTurn,
							}),
					},
				);
				expect(f.deps.close).toHaveBeenCalledOnce();
				expect(guardAccepted).toBe(false);
				expect(signals).not.toHaveBeenCalled();
				expect(result.reconciled).toBe(0);
				expect(db.getSession("exec")?.tmux_window).toBe(
					race === "target_changed" ? "runner:@new" : "runner:@old",
				);
				if (race === "turn_acquired")
					expect(db.getTurn("issue")?.holder_exec_id).toBe("exec");
			} finally {
				db.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("legacy boot retains failed Codex without invoking harvest", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2555-boot-"));
		const dbPath = join(dir, "comm.db");
		const db = new CommDB(dbPath);
		const harvestCodexDaemon = vi.fn(async () => ({
			kind: "absent" as const,
			canFinalize: () => true,
		}));
		const probe = vi.fn(async () => "dead" as const);
		try {
			db.registerSession("exec", "runner:@old", "project", "issue", "lead");
			const result = await reconcileCommDbRunningAgainstFsm(
				"project",
				() => "failed",
				{ dbPath, probe, harvestCodexDaemon },
			);
			expect(result.reconciled).toBe(0);
			expect(result.keptPreserve).toBe(1);
			expect(harvestCodexDaemon).not.toHaveBeenCalled();
			expect(probe).not.toHaveBeenCalled();
			expect(db.getSession("exec")).toBeDefined();
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each(["residual", "unverifiable", "rejection"])(
		"keeps the real row after close %s",
		async (outcome) => {
			const dir = mkdtempSync(join(tmpdir(), "fly2555-close-result-"));
			const dbPath = join(dir, "comm.db");
			const db = new CommDB(dbPath);
			const f = fixture();
			try {
				db.registerSession("exec", "runner:@old", "project", "issue", "lead");
				if (outcome === "rejection")
					f.deps.close.mockRejectedValue(new Error("close unavailable"));
				else
					f.deps.close.mockResolvedValue({
						outcome,
						socketPath: "/test/owned.sock",
					} as never);
				const result = await reconcileCommDbRunningAgainstFsm(
					"project",
					() => "completed",
					{
						dbPath,
						harvest: { orphanMinAgeMs: 86400000, nowMs: Date.now },
						probe: async () => "dead",
						harvestCodexDaemon: async (
							executionId,
							project,
							_target,
							targetUnchangedAndNoTurn,
						) =>
							harvestTerminalCodexDaemon(executionId, project, {
								...f.deps,
								targetUnchangedAndNoTurn,
							}),
					},
				);
				expect(f.deps.close).toHaveBeenCalledOnce();
				expect(f.deps.absence).not.toHaveBeenCalled();
				expect(result.reconciled).toBe(0);
				expect(db.getSession("exec")).toBeDefined();
			} finally {
				db.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("retains an unparked Codex row whose status changes while probing tmux", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2555-race-"));
		const dbPath = join(dir, "comm.db");
		const db = new CommDB(dbPath);
		const f = fixture();
		try {
			db.registerSession("exec", "runner:@old", "project", "issue", "lead");
			const result = await reconcileCommDbRunningAgainstFsm(
				"project",
				() => "completed",
				{
					dbPath,
					harvest: { orphanMinAgeMs: 86400000, nowMs: Date.now },
					probe: async () => {
						f.setSession({ status: "running" });
						return "dead";
					},
					harvestCodexDaemon: async (
						executionId,
						project,
						_target,
						targetUnchangedAndNoTurn,
					) =>
						harvestTerminalCodexDaemon(executionId, project, {
							...f.deps,
							targetUnchangedAndNoTurn,
						}),
				},
			);
			expect(result.reconciled).toBe(0);
			expect(db.getSession("exec")).toBeDefined();
			expect(f.deps.close).not.toHaveBeenCalled();
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each(["completed", "terminated", "failed"])(
		"closes %s once, then prunes only the target on a later pass",
		async (status) => {
			const dir = mkdtempSync(join(tmpdir(), "fly2555-"));
			const dbPath = join(dir, "comm.db");
			const f = fixture();
			f.setSession({ status: status as Session["status"] });
			let live = true;
			f.deps.evidence.mockImplementation(
				async () =>
					({
						liveness: live ? "alive" : "absent",
						ledger: "valid_group",
						socketLive: live,
						spawnLock: "stale",
					}) as never,
			);
			f.deps.close.mockImplementation(async (_session, beforeSignal) => {
				if (beforeSignal()) live = false;
				return !live;
			});
			const db = new CommDB(dbPath);
			try {
				db.registerSession("exec", "runner:@old", "project", "issue", "lead");
				db.upsertDeclaredState(
					"exec",
					"parked",
					"design done",
					Date.now(),
					null,
				);
				for (let i = 0; i < 8; i++)
					db.registerSession(
						`control-${i}`,
						`runner:@${i}`,
						"project",
						`issue-${i}`,
						"lead",
					);
				const options = {
					dbPath,
					harvest: { orphanMinAgeMs: 86400000, nowMs: Date.now },
					probe: async () => "dead" as const,
					executionAbsence: async () =>
						live ? ("unknown" as const) : ("dead" as const),
					harvestCodexDaemon: async (
						executionId,
						project,
						_target,
						targetUnchangedAndNoTurn,
					) =>
						harvestTerminalCodexDaemon(executionId, project, {
							...f.deps,
							targetUnchangedAndNoTurn,
						}),
				};
				const fsm = (id: string) => (id === "exec" ? status : "running");
				const first = await reconcileCommDbRunningAgainstFsm(
					"project",
					fsm,
					options,
				);
				expect(f.deps.close).toHaveBeenCalledOnce();
				expect(first.reconciled).toBe(0);
				expect(db.getSession("exec")).toBeDefined();
				const second = await reconcileCommDbRunningAgainstFsm(
					"project",
					fsm,
					options,
				);
				expect(second.reconciled).toBe(1);
				expect(db.getSession("exec")).toBeUndefined();
				expect(
					db
						.listSessions("project", ["running"])
						.map((s) => s.execution_id)
						.sort(),
				).toEqual(Array.from({ length: 8 }, (_, i) => `control-${i}`));
				expect(f.deps.close).toHaveBeenCalledOnce();
			} finally {
				db.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
