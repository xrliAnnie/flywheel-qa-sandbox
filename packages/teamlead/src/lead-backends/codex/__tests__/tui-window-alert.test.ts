/**
 * FLY-871 §12 W2 — silent-no-pane alert guard tests.
 *
 * Two layers:
 *   - TuiWindowAlertGuard: the state machine with injected episode + runAlert
 *     deps (deterministic, no fs/exec).
 *   - createTuiWindowAlertGuard: env gating (default OFF), path resolution
 *     (FLYWHEEL_ROOT / override), fail-soft, and a real-fs episode round-trip
 *     incl. the cross-"restart" latch.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../../ProjectConfig.js";
import {
	createTuiWindowAlertGuard,
	DEFAULT_TUI_WINDOW_ALERT_THRESHOLD,
	TUI_WINDOW_ALERT_KIND,
	TUI_WINDOW_EPISODE_FILE,
	TuiWindowAlertGuard,
} from "../tui-window-alert.js";

const RESIDENT_PROJECTS = [
	{
		projectName: "flywheel",
		projectRoot: "/flywheel",
		leads: [
			{
				agentId: "codex-infra-bot-lead",
				summaryRole: "exempt",
				chatChannel: "1",
				match: { labels: [] },
				backend: "codex-app-server",
				codexProfile: "full-access",
				canSpawnRunners: false,
				codexResidencyPatrol: true,
			},
		],
	},
	{
		projectName: "raya",
		projectRoot: "/raya",
		leads: [
			{
				agentId: "raya",
				summaryRole: "recipient",
				chatChannel: "2",
				match: { labels: [] },
				backend: "codex-app-server",
				codexProfile: "full-access",
				canSpawnRunners: false,
				codexResidencyPatrol: true,
			},
		],
	},
	{
		projectName: "growth",
		projectRoot: "/growth",
		leads: [
			{
				agentId: "mufasa-lead",
				summaryRole: "producer",
				chatChannel: "3",
				match: { labels: [] },
				backend: "codex-app-server",
				companion: true,
				canSpawnRunners: false,
				codexResidencyPatrol: true,
			},
		],
	},
] satisfies ProjectEntry[];

const CONFIG = {
	projectName: "flywheel",
	leadId: "codex-infra-bot-lead",
	alertScriptPath: "/x/scripts/lead-alert.sh",
};

/** In-memory episode store + alert-call recorder for the state-machine tests. */
function harness(over: { threshold?: number; now?: () => number } = {}) {
	let episode: number | undefined;
	const calls: string[][] = [];
	const guard = new TuiWindowAlertGuard(CONFIG, {
		threshold: over.threshold,
		now: over.now,
		readEpisode: () => episode,
		writeEpisode: (s) => {
			episode = s;
		},
		deleteEpisode: () => {
			episode = undefined;
		},
		runAlert: (args) => calls.push(args),
	});
	return { guard, calls, episodeRef: () => episode };
}

function feed(guard: TuiWindowAlertGuard, healthy: boolean, n: number): void {
	for (let i = 0; i < n; i++) guard.record(healthy);
}

describe("TuiWindowAlertGuard — episode-latched consecutive-failure state machine", () => {
	it("fires exactly once after K consecutive failures", () => {
		const { guard, calls } = harness({ threshold: 9 });
		feed(guard, false, 8);
		expect(calls).toHaveLength(0); // K-1 → no alert
		guard.record(false); // 9th
		expect(calls).toHaveLength(1);
		feed(guard, false, 20); // keep failing → still ONE (latched)
		expect(calls).toHaveLength(1);
	});

	it("K-1 failures then a healthy tick → 0 alerts, counter resets", () => {
		const { guard, calls } = harness({ threshold: 9 });
		feed(guard, false, 8);
		guard.record(true); // recovery before threshold
		feed(guard, false, 8); // 8 again — still below threshold
		expect(calls).toHaveLength(0);
	});

	it("recovery then a new failure run → a SECOND alert with a NEW signature", () => {
		let clock = 1000;
		const { guard, calls } = harness({ threshold: 3, now: () => clock });
		feed(guard, false, 3);
		expect(calls).toHaveLength(1);
		const sig1 = calls[0][calls[0].indexOf("--signature") + 1];

		guard.record(true); // recovery → clears episode + latch
		clock = 2000; // a later episode starts at a different time
		feed(guard, false, 3);
		expect(calls).toHaveLength(2);
		const sig2 = calls[1][calls[1].indexOf("--signature") + 1];

		expect(sig1).toBe(`${TUI_WINDOW_ALERT_KIND}:1000`);
		expect(sig2).toBe(`${TUI_WINDOW_ALERT_KIND}:2000`);
		expect(sig1).not.toBe(sig2); // distinct → claims.db won't swallow episode 2
	});

	it("a persisted episode (KeepAlive restart mid-episode) does NOT re-fire", () => {
		// Simulate a second process incarnation: episode file already present.
		let episode: number | undefined = 12345;
		const calls: string[][] = [];
		const guard = new TuiWindowAlertGuard(CONFIG, {
			threshold: 3,
			readEpisode: () => episode,
			writeEpisode: (s) => {
				episode = s;
			},
			deleteEpisode: () => {
				episode = undefined;
			},
			runAlert: (args) => calls.push(args),
		});
		feed(guard, false, 10); // window still down after restart
		expect(calls).toHaveLength(0); // already alerted for this episode → silent
		guard.record(true); // recovery clears the persisted episode
		expect(episode).toBeUndefined();
	});

	it("fires with the correct kind/severity/signature contract", () => {
		const clock = 777;
		const { guard, calls } = harness({ threshold: 2, now: () => clock });
		void clock;
		feed(guard, false, 2);
		const args = calls[0];
		expect(args).toContain("--kind");
		expect(args[args.indexOf("--kind") + 1]).toBe(TUI_WINDOW_ALERT_KIND);
		expect(args[args.indexOf("--severity") + 1]).toBe("warning");
		expect(args[args.indexOf("--lead") + 1]).toBe(CONFIG.leadId);
		expect(args[args.indexOf("--project") + 1]).toBe(CONFIG.projectName);
		expect(args[args.indexOf("--signature") + 1]).toBe(
			`${TUI_WINDOW_ALERT_KIND}:777`,
		);
	});

	it("derives the founder-facing title from project and lead", () => {
		const infraCalls: string[][] = [];
		const rayaCalls: string[][] = [];
		new TuiWindowAlertGuard(CONFIG, {
			threshold: 1,
			runAlert: (args) => infraCalls.push(args),
		}).record(false);
		new TuiWindowAlertGuard(
			{
				projectName: "raya",
				leadId: "raya",
				alertScriptPath: "/x/scripts/lead-alert.sh",
			},
			{
				threshold: 1,
				runAlert: (args) => rayaCalls.push(args),
			},
		).record(false);
		const title = (args: string[]) => args[args.indexOf("--title") + 1];
		expect(title(infraCalls[0])).toBe(
			"Codex Lead flywheel/codex-infra-bot-lead TUI window not visible",
		);
		expect(title(rayaCalls[0])).toBe(
			"Codex Lead raya/raya TUI window not visible",
		);
	});

	it("a throwing runAlert never propagates (runtime liveness must not break)", () => {
		let episode: number | undefined;
		const guard = new TuiWindowAlertGuard(CONFIG, {
			threshold: 1,
			readEpisode: () => episode,
			writeEpisode: (s) => {
				episode = s;
			},
			deleteEpisode: () => {
				episode = undefined;
			},
			runAlert: () => {
				throw new Error("boom");
			},
		});
		expect(() => guard.record(false)).not.toThrow();
	});

	it("a throwing writeEpisode still fires AND latches in-proc (no per-tick re-spam)", () => {
		const calls: string[][] = [];
		const guard = new TuiWindowAlertGuard(CONFIG, {
			threshold: 1,
			readEpisode: () => undefined, // file write keeps failing → always 'absent'
			writeEpisode: () => {
				throw new Error("disk full");
			},
			deleteEpisode: () => {},
			runAlert: (args) => calls.push(args),
		});
		guard.record(false); // threshold=1 → fire
		feed(guard, false, 5); // keep failing
		expect(calls).toHaveLength(1); // in-proc latch prevents re-spam
	});

	it("default threshold is 9 (~3 min at the 20s cadence)", () => {
		expect(DEFAULT_TUI_WINDOW_ALERT_THRESHOLD).toBe(9);
		const { guard, calls } = harness(); // no threshold override → default
		feed(guard, false, 8);
		expect(calls).toHaveLength(0);
		guard.record(false);
		expect(calls).toHaveLength(1);
	});
});

describe("createTuiWindowAlertGuard — env gating + path resolution + fail-soft", () => {
	const tmpDirs: string[] = [];
	afterEach(() => {
		for (const d of tmpDirs.splice(0))
			rmSync(d, { recursive: true, force: true });
	});
	function stateDir(): string {
		const d = mkdtempSync(join(tmpdir(), "fly871-tui-alert-"));
		tmpDirs.push(d);
		return d;
	}
	type FactoryOptions = Parameters<typeof createTuiWindowAlertGuard>[0] & {
		leadKey: string;
		projects: ReadonlyArray<ProjectEntry>;
	};
	function opts(over: Partial<FactoryOptions> = {}): FactoryOptions {
		return {
			stateDir: stateDir(),
			leadId: "codex-infra-bot-lead",
			projectName: "flywheel",
			leadKey: "flywheel-codex-infra-bot-lead",
			projects: RESIDENT_PROJECTS,
			env: { FLYWHEEL_ROOT: "/x" },
			exists: () => true,
			...over,
		};
	}

	it("enables an opted-in full-access roster target", () => {
		const guard = createTuiWindowAlertGuard(opts());
		expect(guard).not.toBeNull();
	});

	it("enables an opted-in companion roster target", () => {
		const guard = createTuiWindowAlertGuard(
			opts({
				leadId: "mufasa-lead",
				projectName: "growth",
				leadKey: "growth-mufasa-lead",
			}),
		);
		expect(guard).not.toBeNull();
	});

	it("enables only the exact roster project/lead tuple", () => {
		const exact = createTuiWindowAlertGuard(
			opts({
				leadId: "raya",
				projectName: "raya",
				leadKey: "raya-raya",
			}),
		);
		const wrongProject = createTuiWindowAlertGuard(
			opts({
				leadId: "raya",
				projectName: "flywheel",
				leadKey: "flywheel-raya",
			}),
		);
		const nearbyLead = createTuiWindowAlertGuard(
			opts({
				leadId: "raya-raya",
				projectName: "raya",
				leadKey: "raya-raya-raya",
			}),
		);
		expect(exact).not.toBeNull();
		expect(wrongProject).toBeNull();
		expect(nearbyLead).toBeNull();
	});

	it("rejects a runtime identity that is only a strict prefix of the roster target", () => {
		const guard = createTuiWindowAlertGuard(
			opts({
				projectName: "flywheel",
				leadId: "codex-infra-bot",
				leadKey: "flywheel-codex-infra-bot",
			}),
		);
		expect(guard).toBeNull();
	});

	it("rejects a mismatched lead key even when project and lead match", () => {
		const guard = createTuiWindowAlertGuard(
			opts({
				leadId: "raya",
				projectName: "raya",
				leadKey: "raya-other",
			}),
		);
		expect(guard).toBeNull();
	});

	it.each([
		[
			"full-access",
			"codex-infra-bot-lead",
			"flywheel",
			"flywheel-codex-infra-bot-lead",
		],
		["companion", "mufasa-lead", "growth", "growth-mufasa-lead"],
	])(
		"does not enable a %s Lead absent from the opted-in roster",
		(_tier, leadId, projectName, leadKey) => {
			const guard = createTuiWindowAlertGuard(
				opts({
					leadId,
					projectName,
					leadKey,
					projects: [],
				}),
			);
			expect(guard).toBeNull();
		},
	);

	it("does not enable an opted-in non-Codex backend", () => {
		const projects = structuredClone(RESIDENT_PROJECTS);
		projects[0].leads[0].backend = "claude-code";
		const guard = createTuiWindowAlertGuard(opts({ projects }));
		expect(guard).toBeNull();
	});

	it("returns null without logging when the roster is unavailable", () => {
		const logs: string[] = [];
		const guard = createTuiWindowAlertGuard(
			opts({
				projects: [],
				log: (message) => logs.push(message),
			}),
		);
		expect(guard).toBeNull();
		expect(logs).toEqual([]);
	});

	it("logs positive evidence when the roster guard is armed", () => {
		const logs: string[] = [];
		const guard = createTuiWindowAlertGuard(
			opts({
				leadId: "raya",
				projectName: "raya",
				leadKey: "raya-raya",
				log: (message) => logs.push(message),
			}),
		);
		expect(guard).not.toBeNull();
		expect(logs).toEqual([
			"tui-window-alert: silent-no-pane guard ARMED for raya/raya (roster opt-in, threshold=9)",
		]);
	});

	it("does not enable a Lead absent from the roster even with the retired env", () => {
		const guard = createTuiWindowAlertGuard(
			opts({
				leadId: "other-lead",
				projectName: "p",
				env: { FLYWHEEL_TUI_WINDOW_ALERT: "1", FLYWHEEL_ROOT: "/x" },
				leadKey: "p-other-lead",
			}),
		);
		expect(guard).toBeNull();
	});

	it("resolves the alert script from FLYWHEEL_ROOT (contract: <root>/scripts/lead-alert.sh)", () => {
		let resolved = "";
		const guard = createTuiWindowAlertGuard(
			opts({
				env: {
					FLYWHEEL_TUI_WINDOW_ALERT: "1",
					FLYWHEEL_ROOT: "/Users/x/Dev/flywheel",
				},
				exists: (p) => {
					resolved = p;
					return true;
				},
			}),
		);
		expect(guard).not.toBeNull();
		expect(resolved).toBe("/Users/x/Dev/flywheel/scripts/lead-alert.sh");
	});

	it("FLYWHEEL_LEAD_ALERT_SH overrides FLYWHEEL_ROOT", () => {
		let resolved = "";
		createTuiWindowAlertGuard(
			opts({
				env: {
					FLYWHEEL_TUI_WINDOW_ALERT: "1",
					FLYWHEEL_ROOT: "/x",
					FLYWHEEL_LEAD_ALERT_SH: "/custom/lead-alert.sh",
				},
				exists: (p) => {
					resolved = p;
					return true;
				},
			}),
		);
		expect(resolved).toBe("/custom/lead-alert.sh");
	});

	it("disabled (null) when neither FLYWHEEL_ROOT nor override is set", () => {
		const guard = createTuiWindowAlertGuard(
			opts({
				env: { FLYWHEEL_TUI_WINDOW_ALERT: "1" },
			}),
		);
		expect(guard).toBeNull();
	});

	it("disabled (null, fail-soft) when the resolved script does not exist", () => {
		const guard = createTuiWindowAlertGuard(
			opts({
				env: { FLYWHEEL_TUI_WINDOW_ALERT: "1", FLYWHEEL_ROOT: "/x" },
				exists: () => false,
			}),
		);
		expect(guard).toBeNull();
	});

	it("real-fs episode round-trip: writes the latch file on fire, deletes on recovery", () => {
		const dir = stateDir();
		const calls: string[][] = [];
		const guard = createTuiWindowAlertGuard(
			opts({
				stateDir: dir,
				env: { FLYWHEEL_TUI_WINDOW_ALERT: "1", FLYWHEEL_ROOT: "/x" },
				threshold: 2,
				now: () => 42,
				runAlert: (args) => calls.push(args),
			}),
		);
		expect(guard).not.toBeNull();
		const episodeFile = join(dir, TUI_WINDOW_EPISODE_FILE);

		guard?.record(false);
		guard?.record(false); // threshold=2 → fire
		expect(calls).toHaveLength(1);
		expect(existsSync(episodeFile)).toBe(true);
		expect(JSON.parse(readFileSync(episodeFile, "utf8"))).toEqual({
			startedAt: 42,
		});

		guard?.record(true); // recovery → delete
		expect(existsSync(episodeFile)).toBe(false);
	});

	it("cross-restart latch: a second guard on the same state dir does not re-fire the persisted episode", () => {
		const dir = stateDir();
		const env = { FLYWHEEL_TUI_WINDOW_ALERT: "1", FLYWHEEL_ROOT: "/x" };
		const calls1: string[][] = [];
		const g1 = createTuiWindowAlertGuard(
			opts({
				stateDir: dir,
				env,
				threshold: 2,
				now: () => 100,
				runAlert: (args) => calls1.push(args),
			}),
		);
		g1?.record(false);
		g1?.record(false);
		expect(calls1).toHaveLength(1); // first incarnation alerted + persisted

		// New process incarnation (KeepAlive restart), same state dir, window still down.
		const calls2: string[][] = [];
		const g2 = createTuiWindowAlertGuard(
			opts({
				stateDir: dir,
				env,
				threshold: 2,
				now: () => 200,
				runAlert: (args) => calls2.push(args),
			}),
		);
		g2?.record(false);
		g2?.record(false);
		expect(calls2).toHaveLength(0); // same unresolved episode → no double-report
	});
});
