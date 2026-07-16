import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileCommDbRunningAgainstFsm } from "../commdb-fsm-reconcile.js";
import { pruneDeadTerminalCommDbSessions } from "../commdb-session-prune.js";
import {
	createResidueHarvester,
	runResidueAwareBootSweep,
} from "../residue-harvest.js";
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
});
