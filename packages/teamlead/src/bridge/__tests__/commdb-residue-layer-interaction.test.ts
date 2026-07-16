import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectiveExecutor } from "../../DirectiveExecutor.js";
import { StateStore } from "../../StateStore.js";
import { reconcileCommDbRunningAgainstFsm } from "../commdb-fsm-reconcile.js";
import { pruneDeadTerminalCommDbSessions } from "../commdb-session-prune.js";
import {
	createResidueHarvester,
	runResidueAwareBootSweep,
} from "../residue-harvest.js";
import { reconcileStateStoreGhosts } from "../statestore-ghost-reconcile.js";
import { createTerminalCommDbSync } from "../terminal-commdb-sync.js";

describe("FLY-1066 B2 Layer 1 × Layer 2 flag interactions", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1066-layer-matrix-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		db.registerSession(
			"exec-1",
			"runner-flywheel:@1",
			"flywheel",
			"FLY-1066",
			"lead-a",
		);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function converge(flags: {
		terminalSync: boolean;
		fsmReconcile: boolean;
		residueHarvest: boolean;
	}): Promise<string | undefined> {
		const sync = createTerminalCommDbSync({
			enabled: flags.terminalSync,
			getAuthoritativeStatus: () => "failed",
			resolveDbPath: () => dbPath,
			openDb: (path) => new CommDB(path, false),
		});
		await sync.warmProjects(["flywheel"]);
		sync.enqueue("exec-1", "failed", "flywheel");
		await sync.flush();

		const harvestCommDb = (projectName: string) =>
			reconcileCommDbRunningAgainstFsm(projectName, () => "failed", {
				dbPath,
				probe: async () => "dead",
				harvest: { orphanMinAgeMs: 72 * 3_600_000, nowMs: () => Date.now() },
			});
		const pruneCommDb = (includeCrashPreserve: boolean) =>
			pruneDeadTerminalCommDbSessions("flywheel", {
				dbPath,
				includeCrashPreserve,
				probe: async () => "dead",
			});
		const residueHarvester = flags.residueHarvest
			? createResidueHarvester({
					projectNames: ["flywheel"],
					commDbFsmEnabled: flags.fsmReconcile,
					harvestCommDb,
					pruneTerminalCommDb: () => pruneCommDb(true),
					harvestStateStoreGhosts: async () => {},
					resolveOrphanEscalations: () => {},
					reapStateStoreGhost: async () => false,
				})
			: undefined;

		await runResidueAwareBootSweep({
			projectNames: ["flywheel"],
			residueHarvester,
			commDbFsmEnabled: flags.fsmReconcile,
			runLegacyCommDbFsm: harvestCommDb,
			pruneCommDb: () => pruneCommDb(false),
		});
		await sync.close();
		return db.getSession("exec-1")?.status;
	}

	it.each([
		{
			name: "all on converges the Layer 1 mark through terminal prune",
			flags: { terminalSync: true, fsmReconcile: true, residueHarvest: true },
			expected: undefined,
		},
		{
			name: "all off preserves the legacy running registration",
			flags: {
				terminalSync: false,
				fsmReconcile: false,
				residueHarvest: false,
			},
			expected: "running",
		},
		{
			name: "Layer 1 only marks truthfully without Layer 2 deletion",
			flags: { terminalSync: true, fsmReconcile: false, residueHarvest: false },
			expected: "failed",
		},
		{
			name: "Layer 2 only harvests the legacy running preserve residue",
			flags: { terminalSync: false, fsmReconcile: true, residueHarvest: true },
			expected: undefined,
		},
	] as const)("$name", async ({ flags, expected }) => {
		await expect(converge(flags)).resolves.toBe(expected);
	});

	it("passes exact dead-window proof only from terminal prune to the same-pass active ghost scan", async () => {
		const store = await StateStore.create(":memory:");
		try {
			for (const [executionId, status] of [
				["active", "running"],
				["parked", "awaiting_review"],
				["historical", "running"],
			] as const) {
				store.upsertSession({
					execution_id: executionId,
					issue_id: `issue-${executionId}`,
					project_name: "flywheel",
					status,
					started_at: "2026-07-16 10:00:00",
					// Production-shaped legacy metadata is not target authority.
					tmux_session:
						executionId === "historical"
							? "runner-flywheel:@99"
							: "legacy-bare-session",
				});
			}
			for (const [executionId, tmuxWindow] of [
				["active", "runner-flywheel:@11"],
				["parked", "runner-flywheel:@12"],
			] as const) {
				db.registerSession(
					executionId,
					tmuxWindow,
					"flywheel",
					`issue-${executionId}`,
					"lead-a",
				);
				db.updateSessionStatus(executionId, "completed");
			}

			const harvester = createResidueHarvester({
				projectNames: ["flywheel"],
				commDbFsmEnabled: false,
				harvestCommDb: async () => {},
				pruneTerminalCommDb: async () =>
					(
						await pruneDeadTerminalCommDbSessions("flywheel", {
							dbPath,
							probe: async () => "dead",
						})
					).provenDeadTargets,
				harvestStateStoreGhosts: async (projectName, evidence) => {
					const exactTargets = new Map(
						evidence.map((item) => [item.executionId, item.tmuxWindow]),
					);
					await reconcileStateStoreGhosts(projectName, {
						store,
						transitionOpts: {
							store,
							fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
							executor: new DirectiveExecutor(store),
						},
						ghostMinAgeMs: 30 * 60_000,
						nowMs: () => Date.parse("2026-07-16T12:00:00Z"),
						lookupCommDbSession: (executionId) => db.getSession(executionId),
						getProvenDeadTmuxTarget: (executionId) =>
							exactTargets.get(executionId),
						probe: async () => "dead",
						finalizeCommDbSession: () => ({
							ok: true,
							outcome: "finalized",
							retiredGateCount: 0,
							deletedSessionCount: 0,
						}),
					});
				},
				resolveOrphanEscalations: () => {},
				reapStateStoreGhost: async () => false,
			});

			expect(await harvester.runFullPass()).toBe("completed");
			expect(store.getSession("active")?.status).toBe("terminated");
			expect(store.getSession("parked")?.status).toBe("awaiting_review");
			expect(store.getSession("historical")?.status).toBe("running");
			expect(db.getSession("active")).toBeUndefined();
			expect(db.getSession("parked")).toBeUndefined();
		} finally {
			store.close();
		}
	});
});
