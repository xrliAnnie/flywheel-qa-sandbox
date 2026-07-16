/**
 * FLY-1066 M4: shared residue-harvest orchestration and entry scheduling.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import {
	createResidueHarvester,
	residueMaintenanceEveryNTicks,
	runResidueAwareBootSweep,
} from "../residue-harvest.js";

function blocker(executionId = "exec-target"): Session {
	return {
		execution_id: executionId,
		issue_id: "FLY-1066",
		project_name: "flywheel",
		status: "running",
	} as Session;
}

describe("createResidueHarvester", () => {
	it("runs CommDB + StateStore per project, isolates failures, then resolves global orphans once", async () => {
		const calls: string[] = [];
		const harvester = createResidueHarvester({
			projectNames: ["flywheel", "joycon"],
			commDbFsmEnabled: true,
			harvestCommDb: vi.fn(async (project) => {
				calls.push(`comm:${project}`);
				if (project === "flywheel") throw new Error("comm locked");
			}),
			harvestStateStoreGhosts: vi.fn(async (project) => {
				calls.push(`state:${project}`);
			}),
			resolveOrphanEscalations: vi.fn(() => calls.push("global")),
			reapStateStoreGhost: vi.fn(async () => false),
			log: vi.fn(),
		});

		expect(await harvester.runFullPass()).toBe("completed");
		expect(calls).toEqual([
			"comm:flywheel",
			"state:flywheel",
			"comm:joycon",
			"state:joycon",
			"global",
		]);
	});

	it("FLYWHEEL_COMMDB_FSM_RECONCILE=0 gates only face ①/②", async () => {
		const harvestCommDb = vi.fn(async () => {});
		const harvestStateStoreGhosts = vi.fn(async () => {});
		const resolveOrphanEscalations = vi.fn(() => undefined);
		const harvester = createResidueHarvester({
			projectNames: ["flywheel"],
			commDbFsmEnabled: false,
			harvestCommDb,
			harvestStateStoreGhosts,
			resolveOrphanEscalations,
			reapStateStoreGhost: vi.fn(async () => false),
		});

		await harvester.runFullPass();
		expect(harvestCommDb).not.toHaveBeenCalled();
		expect(harvestStateStoreGhosts).toHaveBeenCalledOnce();
		expect(resolveOrphanEscalations).toHaveBeenCalledOnce();
	});

	it("shares one single-flight guard across full and targeted entry points", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reapStateStoreGhost = vi.fn(async () => true);
		const harvester = createResidueHarvester({
			projectNames: ["flywheel"],
			commDbFsmEnabled: true,
			harvestCommDb: vi.fn(async () => held),
			harvestStateStoreGhosts: vi.fn(async () => {}),
			resolveOrphanEscalations: vi.fn(),
			reapStateStoreGhost,
		});

		const first = harvester.runFullPass();
		expect(await harvester.runFullPass()).toBe("skipped_in_flight");
		expect(await harvester.reapTarget(blocker())).toBe(false);
		expect(reapStateStoreGhost).not.toHaveBeenCalled();
		release();
		expect(await first).toBe("completed");
		expect(await harvester.reapTarget(blocker())).toBe(true);
		expect(reapStateStoreGhost).toHaveBeenCalledOnce();
	});
});

describe("runResidueAwareBootSweep", () => {
	it("flag ON uses the shared harvester and never calls legacy FLY-817 directly", async () => {
		const runFullPass = vi.fn(async () => "completed" as const);
		const legacy = vi.fn(async () => {});
		const prune = vi.fn(async () => {});

		await runResidueAwareBootSweep({
			projectNames: ["flywheel", "flywheel", "joycon"],
			residueHarvester: { runFullPass },
			commDbFsmEnabled: true,
			runLegacyCommDbFsm: legacy,
			pruneCommDb: prune,
		});

		expect(runFullPass).toHaveBeenCalledOnce();
		expect(legacy).not.toHaveBeenCalled();
		expect(prune.mock.calls.map(([project]) => project)).toEqual([
			"flywheel",
			"joycon",
		]);
	});

	it("flag OFF preserves the legacy FLY-817 + FLY-638 per-project order and makes zero new calls", async () => {
		const calls: string[] = [];
		const legacy = vi.fn(async (project: string) =>
			calls.push(`legacy:${project}`),
		);
		const prune = vi.fn(async (project: string) =>
			calls.push(`prune:${project}`),
		);

		await runResidueAwareBootSweep({
			projectNames: ["flywheel", "joycon"],
			commDbFsmEnabled: true,
			runLegacyCommDbFsm: legacy,
			pruneCommDb: prune,
		});

		expect(calls).toEqual([
			"legacy:flywheel",
			"prune:flywheel",
			"legacy:joycon",
			"prune:joycon",
		]);
	});
});

describe("residueMaintenanceEveryNTicks", () => {
	it("derives an approximately hourly cadence from the real heartbeat interval", () => {
		const n = residueMaintenanceEveryNTicks(5 * 60_000);
		expect(n).toBe(12);
		expect((n - 1) % n).not.toBe(0);
		expect(n % n).toBe(0);
	});
});

describe("plugin production wiring", () => {
	it("captures the residue flag once and wires the same harvester into all three entries", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(join(here, "..", "plugin.ts"), "utf8");
		expect(source).toContain(
			'process.env.FLYWHEEL_COMMDB_RESIDUE_HARVEST !== "0"',
		);
		expect(source).toContain("reconcileGhost: opts?.residueHarvester");
		expect(source).toContain("residueHarvester,");
		expect(source).toContain("runResidueAwareBootSweep({");

		const maintenanceStart = source.indexOf("async (tick) => {");
		const residueTick = source.indexOf(
			"residueMaintenanceEveryNTicks",
			maintenanceStart,
		);
		const autocleanReturn = source.indexOf(
			"if (!worktreeAutocleanEnabled()) return;",
			maintenanceStart,
		);
		expect(residueTick).toBeGreaterThan(maintenanceStart);
		expect(residueTick).toBeLessThan(autocleanReturn);
	});

	it("production ghost reaping archives through the terminated-status allowance", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(join(here, "..", "plugin.ts"), "utf8");
		const depsStart = source.indexOf("const residueGhostDeps");
		expect(depsStart).toBeGreaterThan(-1);
		const depsEnd = source.indexOf("const residueHarvester", depsStart);
		const wiring = source.slice(depsStart, depsEnd);
		expect(wiring).toContain("archiveIssueThreadIfNoOtherActive(");
		expect(wiring).toContain('allowStatuses: ["terminated"]');
	});
});
