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
	it("runs CommDB + StateStore per project and isolates failures", async () => {
		const calls: string[] = [];
		const harvester = createResidueHarvester({
			projectNames: ["flywheel", "joycon"],
			commDbFsmEnabled: true,
			harvestCommDb: vi.fn(async (project) => {
				calls.push(`comm:${project}`);
				if (project === "flywheel") throw new Error("comm locked");
			}),
			pruneTerminalCommDb: vi.fn(async (project) => {
				calls.push(`prune:${project}`);
				return [
					{ executionId: `exec-${project}`, tmuxWindow: `${project}:@42` },
				];
			}),
			harvestStateStoreGhosts: vi.fn(async (project, evidence) => {
				calls.push(
					`state:${project}:${evidence.map((item) => item.executionId).join(",")}`,
				);
			}),
			harvestPaneLoss: vi.fn(async (project) => {
				calls.push(`pane:${project}`);
				return "ran" as const;
			}),
			reapStateStoreGhost: vi.fn(async () => false),
			log: vi.fn(),
		});

		expect(await harvester.runFullPass()).toBe("completed");
		expect(calls).toEqual([
			"comm:flywheel",
			"prune:flywheel",
			"state:flywheel:exec-flywheel",
			"pane:flywheel",
			"comm:joycon",
			"prune:joycon",
			"state:joycon:exec-joycon",
			"pane:joycon",
		]);
	});

	it("commDbFsmEnabled=false gates only face ①/②", async () => {
		const harvestCommDb = vi.fn(async () => {});
		const pruneTerminalCommDb = vi.fn(async () => []);
		const harvestStateStoreGhosts = vi.fn(async () => {});
		const harvester = createResidueHarvester({
			projectNames: ["flywheel"],
			commDbFsmEnabled: false,
			harvestCommDb,
			pruneTerminalCommDb,
			harvestStateStoreGhosts,
			harvestPaneLoss: vi.fn(async () => "ran" as const),
			reapStateStoreGhost: vi.fn(async () => false),
		});

		await harvester.runFullPass();
		expect(harvestCommDb).not.toHaveBeenCalled();
		expect(pruneTerminalCommDb).toHaveBeenCalledExactlyOnceWith("flywheel");
		expect(harvestStateStoreGhosts).toHaveBeenCalledExactlyOnceWith(
			"flywheel",
			[],
		);
	});

	it("commDbFsmEnabled=false does not gate the targeted StateStore entry", async () => {
		const reapStateStoreGhost = vi.fn(async () => true);
		const harvester = createResidueHarvester({
			projectNames: ["flywheel"],
			commDbFsmEnabled: false,
			harvestCommDb: vi.fn(async () => {}),
			pruneTerminalCommDb: vi.fn(async () => []),
			harvestStateStoreGhosts: vi.fn(async () => {}),
			harvestPaneLoss: vi.fn(async () => "ran" as const),
			reapStateStoreGhost,
		});

		expect(await harvester.reapTarget(blocker())).toBe(true);
		expect(reapStateStoreGhost).toHaveBeenCalledOnce();
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
			pruneTerminalCommDb: vi.fn(async () => []),
			harvestStateStoreGhosts: vi.fn(async () => {}),
			harvestPaneLoss: vi.fn(async () => "ran" as const),
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

	it.each([
		["skipped project first", ["flywheel", "joycon"]],
		["skipped project last", ["joycon", "flywheel"]],
	] as const)(
		"aggregates pane-loss debt across every project: %s",
		async (_label, projectNames) => {
			const harvester = createResidueHarvester({
				projectNames,
				commDbFsmEnabled: false,
				harvestCommDb: vi.fn(async () => {}),
				pruneTerminalCommDb: vi.fn(async () => []),
				harvestStateStoreGhosts: vi.fn(async () => {}),
				harvestPaneLoss: vi.fn(async (project) =>
					project === "flywheel" ? "skipped_episode" : "ran",
				),
				reapStateStoreGhost: vi.fn(async () => false),
			});

			await harvester.runFullPass();

			expect(harvester.lastPaneLossOutcome()).toBe("skipped_episode");
		},
	);

	it("retries pane-loss debt without rerunning the other residue faces", async () => {
		const harvestCommDb = vi.fn(async () => {});
		const pruneTerminalCommDb = vi.fn(async () => []);
		const harvestStateStoreGhosts = vi.fn(async () => {});
		const harvestPaneLoss = vi.fn(async () => "skipped_server" as const);
		const harvester = createResidueHarvester({
			projectNames: ["flywheel", "joycon"],
			commDbFsmEnabled: true,
			harvestCommDb,
			pruneTerminalCommDb,
			harvestStateStoreGhosts,
			harvestPaneLoss,
			reapStateStoreGhost: vi.fn(async () => false),
		});

		await harvester.runPaneLossPass();

		expect(harvestPaneLoss).toHaveBeenCalledTimes(2);
		expect(harvestCommDb).not.toHaveBeenCalled();
		expect(pruneTerminalCommDb).not.toHaveBeenCalled();
		expect(harvestStateStoreGhosts).not.toHaveBeenCalled();
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
		expect(prune).not.toHaveBeenCalled();
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

	it("both flags OFF skips every FLY-817/residue call but preserves FLY-638", async () => {
		const legacy = vi.fn(async () => {});
		const prune = vi.fn(async () => {});

		await runResidueAwareBootSweep({
			projectNames: ["flywheel"],
			commDbFsmEnabled: false,
			runLegacyCommDbFsm: legacy,
			pruneCommDb: prune,
		});

		expect(legacy).not.toHaveBeenCalled();
		expect(prune).toHaveBeenCalledExactlyOnceWith("flywheel");
	});

	it("residue ON + FLY-817 OFF still invokes the shared M2/M3 pass", async () => {
		const runFullPass = vi.fn(async () => "completed" as const);
		const legacy = vi.fn(async () => {});
		const prune = vi.fn(async () => {});

		await runResidueAwareBootSweep({
			projectNames: ["flywheel"],
			residueHarvester: { runFullPass },
			commDbFsmEnabled: false,
			runLegacyCommDbFsm: legacy,
			pruneCommDb: prune,
		});

		expect(runFullPass).toHaveBeenCalledOnce();
		expect(legacy).not.toHaveBeenCalled();
		expect(prune).not.toHaveBeenCalled();
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
	it("wires the same harvester into all three entries", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(join(here, "..", "plugin.ts"), "utf8");
		expect(source).toContain("reconcileGhost: opts?.residueHarvester");
		expect(source).toContain("residueHarvester,");
		expect(source).toContain("runResidueAwareBootSweep({");
		expect(source).toContain("pruneTerminalCommDb: pruneResidueCommDb");
		expect(source).toContain("includeCrashPreserve: true");

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
