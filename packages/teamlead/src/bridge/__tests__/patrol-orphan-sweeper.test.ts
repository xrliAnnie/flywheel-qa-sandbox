import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type { PatrolOrphanWatch } from "../../StateStore.js";
import {
	activePatrolTargets,
	createPatrolOrphanSweeperPass,
	listPatrolPanes,
	type PatrolOrphanSweepStore,
	parsePatrolPaneList,
} from "../patrol-orphan-sweeper.js";

const PROJECTS = [
	{ projectName: "flywheel", projectRoot: "/repo/flywheel", leads: [] },
	{ projectName: "tidal-echo", projectRoot: "/repo/tidal", leads: [] },
] as ProjectEntry[];
const execFile = promisify(execFileCallback);

function memoryStore(seed: PatrolOrphanWatch[] = []): PatrolOrphanSweepStore {
	const rows = new Map(seed.map((row) => [row.target, { ...row }]));
	return {
		getPatrolOrphanWatch: (target) => rows.get(target) ?? null,
		listPatrolOrphanWatches: () =>
			[...rows.values()].sort((a, b) => a.target.localeCompare(b.target)),
		upsertPatrolOrphanWatch: (row) => rows.set(row.target, { ...row }),
		deletePatrolOrphanWatch: (target) => {
			rows.delete(target);
		},
	};
}

function pane(
	projectName = "flywheel",
	target = "runner-flywheel:@7",
	paneId = "%7",
	panePid = "46971",
	sessionCreated = "1724860000",
) {
	return { projectName, target, paneId, panePid, sessionCreated };
}

describe("FLY-2118 patrol orphan sweeper", () => {
	it("skips pending registrations but rejects a blank owner on a bound target", () => {
		expect(
			activePatrolTargets([
				{ tmux_window: "runner-flywheel:@1", lead_id: "flywheel-eng-lead" },
				{ tmux_window: "runner-flywheel:pending", lead_id: null },
			]),
		).toEqual(["runner-flywheel:@1"]);
		expect(() =>
			activePatrolTargets([
				{ tmux_window: "runner-flywheel:@2", lead_id: null },
			]),
		).toThrow("active owner index contains an incomplete session registration");
	});

	it("bounds tmux enumeration with a hard kill and output cap", async () => {
		const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
		await listPatrolPanes(run);
		expect(run).toHaveBeenCalledWith(
			"tmux",
			expect.arrayContaining(["list-panes", "-a"]),
			expect.objectContaining({
				timeout: 5_000,
				maxBuffer: 1024 * 1024,
				killSignal: "SIGKILL",
			}),
		);
	});

	it("releases the single-flight latch on an independent wall-clock deadline", async () => {
		vi.useFakeTimers();
		try {
			let releaseFirst: (() => void) | undefined;
			let invocation = 0;
			const listPanes = vi.fn(() => {
				invocation += 1;
				if (invocation > 1) return Promise.resolve([]);
				return new Promise<ReturnType<typeof pane>[]>((resolve) => {
					releaseFirst = () => resolve([pane()]);
				});
			});
			const alertFailure = vi.fn(async () => undefined);
			const log = vi.fn();
			const store = memoryStore();
			const pass = createPatrolOrphanSweeperPass({
				projects: PROJECTS,
				store,
				listPanes,
				readActiveTargets: async () => [],
				getGlobalConfig: () => ({ interval_minutes: 10 }),
				getProjectConfig: () => ({}),
				alertFailure,
				log,
				deadlineMs: 100,
			});

			const first = pass();
			expect(pass()).toBe(first);
			await vi.advanceTimersByTimeAsync(100);
			const second = pass();
			expect(second).not.toBe(first);
			await vi.advanceTimersByTimeAsync(0);
			expect(listPanes).toHaveBeenCalledTimes(2);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("deadline released single-flight latch"),
			);
			expect(alertFailure).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "orphan_pane",
					condition: "owner_index_incomplete",
				}),
			);

			await second;
			releaseFirst?.();
			await first;
			expect(store.getPatrolOrphanWatch("runner-flywheel:@7")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("parses only canonical runner panes and keeps identity fields", () => {
		expect(
			parsePatrolPaneList(
				[
					"%7\t46971\t1724860000\trunner-flywheel\t@7\tFLY-2118",
					"%8\t46972\t1724860001\tcmux-FLY-2118\t@8\tFLY-2118",
					"%9\t46973\t1724860002\trunner-flywheel\t@9\tshell",
				].join("\n"),
			),
		).toEqual([
			{
				projectName: "flywheel",
				target: "runner-flywheel:@7",
				paneId: "%7",
				panePid: "46971",
				sessionCreated: "1724860000",
			},
		]);
	});

	it("fails loudly when a non-empty tmux row lacks a required identity field", () => {
		expect(() =>
			parsePatrolPaneList("%7\t\t1787965200\trunner-flywheel\t@7\tFLY-2118"),
		).toThrow("tmux pane row is missing required identity fields");
	});

	it("ignores unrelated empty and tab-named windows without masking canonical panes", () => {
		expect(
			parsePatrolPaneList(
				[
					"%8\t46972\t1724860001\tmy-scratch\t@8\t",
					"%9\t46973\t1724860002\tmy-scratch\t@9\tSCRATCH\tTAB",
					"%7\t46971\t1724860000\trunner-flywheel\t@7\tFLY-2118",
				].join("\n"),
			),
		).toEqual([
			{
				projectName: "flywheel",
				target: "runner-flywheel:@7",
				paneId: "%7",
				panePid: "46971",
				sessionCreated: "1724860000",
			},
		]);
	});

	it("enumerates a canonical pane beside odd windows on a real tmux server", async () => {
		const socketName = `fly2118-${process.pid}-${Date.now()}`;
		await execFile("tmux", [
			"-L",
			socketName,
			"new-session",
			"-d",
			"-s",
			"runner-flywheel",
			"-n",
			"FLY-2118",
			"sleep 30",
		]);
		try {
			await execFile("tmux", [
				"-L",
				socketName,
				"new-session",
				"-d",
				"-s",
				"my-scratch",
				"-n",
				"scratch",
				"sleep 30",
			]);
			await execFile("tmux", [
				"-L",
				socketName,
				"rename-window",
				"-t",
				"my-scratch:0",
				"",
			]);
			await execFile("tmux", [
				"-L",
				socketName,
				"new-window",
				"-d",
				"-t",
				"my-scratch",
				"-n",
				"SCRATCH\tTAB",
				"sleep 30",
			]);
			const panes = await listPatrolPanes(async (file, args, options) => {
				const result = await execFile(
					file,
					["-L", socketName, ...args],
					options,
				);
				return { stdout: result.stdout };
			});
			expect(panes).toHaveLength(1);
			expect(panes[0]).toMatchObject({
				projectName: "flywheel",
				target: expect.stringMatching(/^runner-flywheel:@\d+$/),
				paneId: expect.stringMatching(/^%\d+$/),
				panePid: expect.stringMatching(/^\d+$/),
				sessionCreated: expect.stringMatching(/^\d+$/),
			});
		} finally {
			await execFile("tmux", ["-L", socketName, "kill-server"]);
		}
	});

	it("alerts exactly once after two consecutive slots and is idempotent in-slot", async () => {
		let nowMs = 1_724_860_000_000;
		const store = memoryStore();
		const alertFailure = vi.fn(async () => undefined);
		const log = vi.fn();
		const pass = createPatrolOrphanSweeperPass({
			projects: PROJECTS,
			store,
			listPanes: async () => [pane()],
			readActiveTargets: async () => [],
			getGlobalConfig: () => ({ interval_minutes: 10 }),
			getProjectConfig: () => ({}),
			now: () => nowMs,
			alertFailure,
			log,
		});

		await pass();
		await pass();
		expect(alertFailure).not.toHaveBeenCalled();
		nowMs += 10 * 60_000;
		await pass();
		await pass();
		expect(alertFailure).toHaveBeenCalledTimes(1);
		expect(alertFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "orphan_pane",
				condition: "unclaimed",
				projectName: "flywheel",
				target: "runner-flywheel:@7",
			}),
		);
		expect(store.getPatrolOrphanWatch("runner-flywheel:@7")?.streak).toBe(2);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("[patrol_orphan] success"),
		);
	});

	it("ignores foreign registry panes and clears an episode after claim or disappearance", async () => {
		let panes = [pane(), pane("test-slot", "runner-test-slot:@1", "%1")];
		let claimed: string[] = [];
		const store = memoryStore();
		const pass = createPatrolOrphanSweeperPass({
			projects: PROJECTS,
			store,
			listPanes: async () => panes,
			readActiveTargets: async () => claimed,
			getGlobalConfig: () => ({ interval_minutes: 10 }),
			getProjectConfig: () => ({}),
			now: () => 1_724_860_000_000,
			alertFailure: vi.fn(async () => undefined),
		});

		await pass();
		expect(store.listPatrolOrphanWatches().map((row) => row.target)).toEqual([
			"runner-flywheel:@7",
		]);
		claimed = ["runner-flywheel:@7"];
		await pass();
		expect(store.listPatrolOrphanWatches()).toEqual([]);
		claimed = [];
		panes = [];
		await pass();
		expect(store.listPatrolOrphanWatches()).toEqual([]);
	});

	it("resets continuity for pane replacement, skipped slots, and interval changes", async () => {
		let nowMs = 1_724_860_000_000;
		let currentPane = pane();
		let intervalMinutes = 10;
		const store = memoryStore();
		const pass = createPatrolOrphanSweeperPass({
			projects: PROJECTS,
			store,
			listPanes: async () => [currentPane],
			readActiveTargets: async () => [],
			getGlobalConfig: () => ({ interval_minutes: intervalMinutes }),
			getProjectConfig: () => ({}),
			now: () => nowMs,
			alertFailure: vi.fn(async () => undefined),
		});

		await pass();
		nowMs += 10 * 60_000;
		currentPane = pane("flywheel", "runner-flywheel:@7", "%8", "1724860600");
		await pass();
		expect(store.getPatrolOrphanWatch("runner-flywheel:@7")?.streak).toBe(1);

		nowMs += 20 * 60_000;
		await pass();
		expect(store.getPatrolOrphanWatch("runner-flywheel:@7")?.streak).toBe(1);

		nowMs += 10 * 60_000;
		intervalMinutes = 20;
		await pass();
		expect(store.getPatrolOrphanWatch("runner-flywheel:@7")).toMatchObject({
			streak: 1,
			intervalMs: 20 * 60_000,
		});
	});

	it("uses each target project interval independently", async () => {
		let nowMs = 1_724_860_000_000;
		const store = memoryStore();
		const alertFailure = vi.fn(async () => undefined);
		const pass = createPatrolOrphanSweeperPass({
			projects: PROJECTS,
			store,
			listPanes: async () => [
				pane(),
				pane("tidal-echo", "runner-tidal-echo:@8", "%8"),
			],
			readActiveTargets: async () => [],
			getGlobalConfig: () => ({ interval_minutes: 60 }),
			getProjectConfig: (root) => ({
				interval_minutes: root.includes("tidal") ? 20 : 10,
			}),
			now: () => nowMs,
			alertFailure,
		});

		await pass();
		nowMs += 10 * 60_000;
		await pass();
		expect(alertFailure).toHaveBeenCalledTimes(1);
		expect(alertFailure.mock.calls[0]?.[0].target).toBe("runner-flywheel:@7");
		nowMs += 10 * 60_000;
		await pass();
		expect(alertFailure).toHaveBeenCalledTimes(2);
		expect(alertFailure.mock.calls[1]?.[0].target).toBe("runner-tidal-echo:@8");
	});

	it("does not advance or clean episodes when any owner index read fails", async () => {
		let nowMs = 1_724_860_000_000;
		let failRead = false;
		const store = memoryStore();
		const alertFailure = vi.fn(async () => undefined);
		const pass = createPatrolOrphanSweeperPass({
			projects: PROJECTS,
			store,
			listPanes: async () => [pane()],
			readActiveTargets: async (projectName) => {
				if (failRead && projectName === "tidal-echo") {
					throw new Error("sqlite busy");
				}
				return [];
			},
			getGlobalConfig: () => ({ interval_minutes: 10 }),
			getProjectConfig: () => ({}),
			now: () => nowMs,
			alertFailure,
		});

		await pass();
		failRead = true;
		nowMs += 10 * 60_000;
		await pass();
		expect(store.getPatrolOrphanWatch("runner-flywheel:@7")?.streak).toBe(1);
		expect(alertFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "orphan_pane",
				condition: "owner_index_incomplete",
			}),
		);

		failRead = false;
		nowMs += 10 * 60_000;
		await pass();
		expect(store.getPatrolOrphanWatch("runner-flywheel:@7")?.streak).toBe(1);
	});

	it("re-alerts a persistent orphan only after the 30 minute cooldown", async () => {
		let nowMs = 1_724_860_000_000;
		const alertFailure = vi.fn(async () => undefined);
		const pass = createPatrolOrphanSweeperPass({
			projects: PROJECTS,
			store: memoryStore(),
			listPanes: async () => [pane()],
			readActiveTargets: async () => [],
			getGlobalConfig: () => ({ interval_minutes: 10 }),
			getProjectConfig: () => ({}),
			now: () => nowMs,
			alertFailure,
		});

		await pass();
		for (let slot = 1; slot <= 4; slot += 1) {
			nowMs += 10 * 60_000;
			await pass();
		}
		expect(alertFailure).toHaveBeenCalledTimes(2);
	});
});
