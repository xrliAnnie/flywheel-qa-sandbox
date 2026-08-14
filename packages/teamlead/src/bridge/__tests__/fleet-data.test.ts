/**
 * FLY-247 WI-4: fleet evidence collection, decision table, config provider,
 * poller, and Lead alert membership.
 */
import { describe, expect, it } from "vitest";
import { deriveLeadSocketPath } from "../../lead-address.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { buildDashboardPayload } from "../dashboard-data.js";
import {
	ConfigSnapshotProvider,
	classifyLeadPlistCarrier,
	collectFleetSnapshot,
	deriveDecision,
	type FleetManagement,
	FleetPoller,
	type FleetProbeDeps,
	type FleetRuntime,
} from "../fleet-data.js";

// ── deriveDecision: the TOTAL table is pinned (R8#4) ──────────────────────

describe("deriveDecision — total presentation/alert table", () => {
	const M: FleetManagement[] = [
		"standard-confirmed",
		"external-confirmed",
		"indeterminate",
	];
	const R: FleetRuntime[] = [
		"claude-confirmed",
		"no-claude-confirmed",
		"indeterminate",
	];

	it("claude desire: standard×claude=ONLINE, standard×no-claude=DOWN, standard×ind=PARTIAL — all watched", () => {
		expect(
			deriveDecision("claude-code", "standard-confirmed", "claude-confirmed"),
		).toEqual({ presentation: "ONLINE", paneWatch: true });
		expect(
			deriveDecision(
				"claude-code",
				"standard-confirmed",
				"no-claude-confirmed",
			),
		).toEqual({ presentation: "DOWN", paneWatch: true });
		expect(
			deriveDecision("claude-code", "standard-confirmed", "indeterminate"),
		).toEqual({ presentation: "PARTIAL", paneWatch: true });
	});

	it("claude desire: non-standard management → DEGRADED, still watched (漏报>误报)", () => {
		for (const m of ["external-confirmed", "indeterminate"] as const) {
			for (const r of R) {
				expect(deriveDecision("claude-code", m, r)).toEqual({
					presentation: "DEGRADED",
					paneWatch: true,
				});
			}
		}
	});

	it("codex desire: live Claude (incl. manual/nohup) → CONFLICT, KEPT WATCHING (R5#1)", () => {
		for (const m of M) {
			expect(deriveDecision("codex-app-server", m, "claude-confirmed")).toEqual(
				{ presentation: "CONFLICT", paneWatch: true },
			);
		}
	});

	it("codex desire: any indeterminate axis → DEGRADED, kept watching (R4#1)", () => {
		expect(
			deriveDecision(
				"codex-app-server",
				"indeterminate",
				"no-claude-confirmed",
			),
		).toEqual({ presentation: "DEGRADED", paneWatch: true });
		expect(
			deriveDecision("codex-app-server", "external-confirmed", "indeterminate"),
		).toEqual({ presentation: "DEGRADED", paneWatch: true });
		expect(
			deriveDecision("codex-app-server", "standard-confirmed", "indeterminate"),
		).toEqual({ presentation: "DEGRADED", paneWatch: true });
	});

	it("codex desire: standard carrier + confirmed no claude → CONFLICT-CARRIER, excluded (R8#4)", () => {
		expect(
			deriveDecision(
				"codex-app-server",
				"standard-confirmed",
				"no-claude-confirmed",
			),
		).toEqual({ presentation: "CONFLICT-CARRIER", paneWatch: false });
	});

	it("codex desire: external × no-claude → EXTERNAL, excluded (the only quiet exclusion)", () => {
		expect(
			deriveDecision(
				"codex-app-server",
				"external-confirmed",
				"no-claude-confirmed",
			),
		).toEqual({ presentation: "EXTERNAL", paneWatch: false });
	});
});

// ── collectFleetSnapshot ──────────────────────────────────────────────────

const HOME = "/home/test";
const KEY = "geo-product-lead";
const M_PATH = `${HOME}/.flywheel/manifests/${KEY}.json`;
const P_PATH = `${HOME}/Library/LaunchAgents/com.flywheel.lead.${KEY}.plist`;
const WRAPPER_V2 = `${HOME}/.flywheel/bin/flywheel-lead-wrapper-v2.sh`;
const SOCKET_PATH = deriveLeadSocketPath(
	"geo/product-lead",
	`${HOME}/.flywheel`,
);

function goodPlist(model?: string): string {
	const env = model
		? `<key>EnvironmentVariables</key><dict><key>FLYWHEEL_LEAD_MODEL</key><string>${model}</string></dict>`
		: "";
	return `<plist><dict><string>com.flywheel.lead.${KEY}</string><string>${WRAPPER_V2}</string><string>${M_PATH}</string>${env}</dict></plist>`;
}

function project(lead: Partial<ProjectEntry["leads"][0]> = {}): ProjectEntry {
	return {
		projectName: "geo",
		projectRoot: "/proj/geo",
		leads: [
			{
				agentId: "product-lead",
				chatChannel: "1",
				match: { labels: ["P"] },
				...lead,
			},
		],
	};
}

interface DepsOverride {
	files?: Record<string, string>;
	pidAlive?: (pid: number) => boolean;
	launchd?: { loaded: boolean; pid: number } | null;
	panes?: Array<{
		windowName: string;
		command: string;
		panePid?: number;
		dead?: boolean;
	}> | null;
	tmuxCalls?: { count: number };
	privatePanes?: DepsOverride["panes"];
	privateTmuxCalls?: { sockets: string[] };
	processCommands?: Record<number, string[] | null>;
	stateDir?: string;
}

function makeDeps(o: DepsOverride = {}): FleetProbeDeps {
	const files = o.files ?? {};
	return {
		readFile: (p) => {
			const c = files[p];
			if (c === undefined) throw new Error(`ENOENT ${p}`);
			return c;
		},
		fileExists: (p) => files[p] !== undefined,
		pidAlive: o.pidAlive ?? (() => true),
		launchdPrint: async () =>
			o.launchd === undefined ? { loaded: true, pid: 42 } : o.launchd,
		listPanes: async () => {
			if (o.tmuxCalls) o.tmuxCalls.count += 1;
			if (o.panes === undefined) return [];
			if (o.panes === null) return null;
			return o.panes.map((p) => ({
				windowName: p.windowName,
				command: p.command,
				panePid: p.panePid ?? 0,
				dead: p.dead ?? false,
			}));
		},
		listPanesAtSocket: async (socketPath) => {
			o.privateTmuxCalls?.sockets.push(socketPath);
			if (o.privatePanes === undefined) return [];
			if (o.privatePanes === null) return null;
			return o.privatePanes.map((p) => ({
				windowName: p.windowName,
				command: p.command,
				panePid: p.panePid ?? 0,
				dead: p.dead ?? false,
			}));
		},
		processCommandsOf: async (pid) =>
			o.processCommands?.[pid] === undefined ? [] : o.processCommands[pid],
		homeDir: () => HOME,
		stateDir: () => o.stateDir ?? `${HOME}/.flywheel`,
		now: () => new Date("2026-06-11T00:00:00Z"),
	};
}

describe("collectFleetSnapshot — two-axis evidence", () => {
	it("healthy standard claude lead → ONLINE, drift computed against both carriers", async () => {
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 42,
					model: "fab",
					leadBackend: { backendId: "claude-code" },
					projectName: "geo",
					leadId: "product-lead",
					socketPath: deriveLeadSocketPath(
						"geo/product-lead",
						`${HOME}/.flywheel`,
					),
				}),
				[P_PATH]: goodPlist("fab"),
			},
			launchd: { loaded: true, pid: 42 },
			privatePanes: [{ windowName: "main", command: "claude" }],
		});
		const snap = await collectFleetSnapshot(
			[project({ model: "fab" })],
			() => undefined,
			deps,
		);
		const l = snap.leads[0]!;
		expect(l.observed.management).toBe("standard-confirmed");
		expect(l.observed.runtime).toBe("claude-confirmed");
		expect(l.presentation).toBe("ONLINE");
		expect(l.drift).toEqual({
			model: false,
			backend: false,
			effort: false,
			carrier: false,
		});
	});

	it("v2 plist is standard-managed and carrier-aligned", async () => {
		const socketPath = deriveLeadSocketPath(
			"geo/product-lead",
			`${HOME}/.flywheel`,
		);
		const privateTmuxCalls = { sockets: [] as string[] };
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 42,
					projectName: "geo",
					leadId: "product-lead",
					socketPath,
				}),
				[P_PATH]: goodPlist(),
			},
			panes: [],
			privatePanes: [{ windowName: "main", command: "claude" }],
			privateTmuxCalls,
		});
		const snap = await collectFleetSnapshot(
			[project({ carrier: "v2" })],
			() => undefined,
			deps,
		);
		expect(snap.leads[0]!.observed.management).toBe("standard-confirmed");
		expect(snap.leads[0]!.carrier.plistCarrier).toBe("v2");
		expect(snap.leads[0]!.drift?.carrier).toBe(false);
		expect(snap.leads[0]!.observed.runtime).toBe("claude-confirmed");
		expect(privateTmuxCalls.sockets).toEqual([socketPath]);
	});

	it("a plist mentioning both v2 and a bespoke Codex wrapper is unknown", () => {
		const ambiguous = goodPlist().replace(
			"</dict>",
			"<key>LEGACY_NOTE</key><string>/opt/flywheel-codex-lead-wrapper-mufasa.sh</string></dict>",
		);
		expect(classifyLeadPlistCarrier(ambiguous, HOME)).toBe("unknown");
	});

	it("honors an injected state directory for v2 manifest and socket authority", async () => {
		const stateDir = "/custom/flywheel-state";
		const manifestPath = `${stateDir}/manifests/${KEY}.json`;
		const socketPath = deriveLeadSocketPath("geo/product-lead", stateDir);
		const deps = makeDeps({
			stateDir,
			files: {
				[manifestPath]: JSON.stringify({
					pid: 42,
					projectName: "geo",
					leadId: "product-lead",
					socketPath,
				}),
				[P_PATH]: goodPlist()
					.replace(M_PATH, manifestPath)
					.replace(WRAPPER_V2, `${stateDir}/bin/flywheel-lead-wrapper-v2.sh`),
			},
			privatePanes: [{ windowName: "main", command: "claude" }],
		});
		const snap = await collectFleetSnapshot(
			[project({ carrier: "v2" })],
			() => undefined,
			deps,
		);
		expect(snap.leads[0]!.observed.management).toBe("standard-confirmed");
		expect(snap.leads[0]!.observed.runtime).toBe("claude-confirmed");
	});

	it("v2 fails closed when the manifest publishes a noncanonical socket", async () => {
		const privateTmuxCalls = { sockets: [] as string[] };
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 42,
					projectName: "geo",
					leadId: "product-lead",
					socketPath: "/tmp/attacker.sock",
				}),
				[P_PATH]: goodPlist(),
			},
			privatePanes: [{ windowName: "main", command: "claude" }],
			privateTmuxCalls,
		});
		const snap = await collectFleetSnapshot(
			[project({ carrier: "v2" })],
			() => undefined,
			deps,
		);
		expect(snap.leads[0]!.observed.management).toBe("external-confirmed");
		expect(privateTmuxCalls.sockets).toEqual([]);
	});

	it("unknown wrapper remains external and carrier drift is loud", async () => {
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 42,
					projectName: "geo",
					leadId: "product-lead",
					socketPath: SOCKET_PATH,
				}),
				[P_PATH]: `<plist><string>/bespoke/wrapper</string><string>${M_PATH}</string><string>com.flywheel.lead.${KEY}</string></plist>`,
			},
			panes: [],
		});
		const snap = await collectFleetSnapshot([project()], () => undefined, deps);
		expect(snap.leads[0]!.observed.management).toBe("external-confirmed");
		expect(snap.leads[0]!.carrier.plistCarrier).toBe("unknown");
		expect(snap.leads[0]!.drift?.carrier).toBe(true);
	});

	it("model drift visible (config differs from manifest/plist)", async () => {
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 42,
					projectName: "geo",
					leadId: "product-lead",
					socketPath: SOCKET_PATH,
				}),
				[P_PATH]: goodPlist(),
			},
			panes: [{ windowName: KEY, command: "claude" }],
		});
		const snap = await collectFleetSnapshot(
			[project({ model: "new-model" })],
			() => undefined,
			deps,
		);
		expect(snap.leads[0]!.drift?.model).toBe(true);
	});

	it("launchd PID ≠ manifest.pid → external (residual/PID-reuse, R7#1)", async () => {
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 999,
					projectName: "geo",
					leadId: "product-lead",
				}),
				[P_PATH]: goodPlist(),
			},
			launchd: { loaded: true, pid: 42 },
			panes: [],
		});
		const snap = await collectFleetSnapshot([project()], () => undefined, deps);
		expect(snap.leads[0]!.observed.management).toBe("external-confirmed");
	});

	it("launchd probe failure → indeterminate, NOT external (R4#1)", async () => {
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 42,
					projectName: "geo",
					leadId: "product-lead",
					socketPath: SOCKET_PATH,
				}),
				[P_PATH]: goodPlist(),
			},
			launchd: null,
			panes: [],
		});
		const snap = await collectFleetSnapshot([project()], () => undefined, deps);
		expect(snap.leads[0]!.observed.management).toBe("indeterminate");
		expect(snap.leads[0]!.observed.degradationReasons).toContain(
			"launchd-probe-failed",
		);
	});

	it("tmux probe failure → runtime indeterminate", async () => {
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 42,
					projectName: "geo",
					leadId: "product-lead",
					socketPath: SOCKET_PATH,
				}),
				[P_PATH]: goodPlist(),
			},
			privatePanes: null,
		});
		const snap = await collectFleetSnapshot([project()], () => undefined, deps);
		expect(snap.leads[0]!.observed.runtime).toBe("indeterminate");
	});

	it("same-name Codex observer window does NOT fake claude runtime (R8#3)", async () => {
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 42,
					projectName: "geo",
					leadId: "product-lead",
				}),
				[P_PATH]: goodPlist(),
			},
			panes: [{ windowName: KEY, command: "codex" }],
		});
		const snap = await collectFleetSnapshot([project()], () => undefined, deps);
		expect(snap.leads[0]!.observed.runtime).toBe("no-claude-confirmed");
	});

	it("codex external lead → EXTERNAL presentation, drift = null (n/a, R3#5)", async () => {
		const deps = makeDeps({ files: {}, panes: [] });
		const snap = await collectFleetSnapshot(
			[
				project({
					backend: "codex-app-server",
					companion: true,
					canSpawnRunners: false,
					model: "o3",
				}),
			],
			() => undefined,
			deps,
		);
		const l = snap.leads[0]!;
		expect(l.presentation).toBe("EXTERNAL");
		expect(l.paneWatch).toBe(false);
		expect(l.drift).toBeNull();
		expect(l.configured.model).toBe("o3");
	});

	it("ONE batched tmux call per refresh regardless of lead count (F9)", async () => {
		const tmuxCalls = { count: 0 };
		const deps = makeDeps({ files: {}, panes: [], tmuxCalls });
		const many: ProjectEntry = {
			projectName: "geo",
			projectRoot: "/proj/geo",
			leads: ["a", "b", "c", "d"].map((id) => ({
				agentId: id,
				chatChannel: "1",
				match: { labels: ["P"] },
			})),
		};
		await collectFleetSnapshot([many], () => undefined, deps);
		expect(tmuxCalls.count).toBe(1);
	});

	it("legacy config.yaml backend → source labeled legacy", async () => {
		const deps = makeDeps({ files: {}, panes: [] });
		const snap = await collectFleetSnapshot(
			[project()],
			() => "codex-app-server",
			deps,
		);
		expect(snap.leads[0]!.configured.backend).toBe("codex-app-server");
		expect(snap.leads[0]!.configured.source).toBe("legacy");
	});

	it("QA F-2: a DEAD claude pane is not runtime evidence", async () => {
		const deps = makeDeps({
			files: {},
			launchd: { loaded: false, pid: 0 },
			panes: [{ windowName: KEY, command: "claude", dead: true }],
		});
		const snap = await collectFleetSnapshot([project()], () => undefined, deps);
		expect(snap.leads[0]!.observed.runtime).toBe("no-claude-confirmed");
	});

	it("QA F-3: version-number pane command + claude process tree → claude-confirmed", async () => {
		const deps = makeDeps({
			files: {},
			launchd: { loaded: false, pid: 0 },
			panes: [{ windowName: KEY, command: "2.1.170", panePid: 777 }],
			processCommands: { 777: ["node /x/claude-lead.sh foo"] },
		});
		const snap = await collectFleetSnapshot([project()], () => undefined, deps);
		expect(snap.leads[0]!.observed.runtime).toBe("claude-confirmed");
	});

	it("QA F-3: launchd pid process tree alone confirms claude (axis parity with bash)", async () => {
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 42,
					projectName: "geo",
					leadId: "product-lead",
				}),
				[P_PATH]: goodPlist(),
			},
			launchd: { loaded: true, pid: 42 },
			panes: [{ windowName: KEY, command: "2.1.170", panePid: 0 }],
			processCommands: { 42: ["bash claude-lead.sh"] },
		});
		const snap = await collectFleetSnapshot([project()], () => undefined, deps);
		expect(snap.leads[0]!.observed.runtime).toBe("claude-confirmed");
	});

	it("QA F-1: multi-line hand-edited plist model is read (cross-line regex)", async () => {
		const multiline = `<plist><dict>
    <string>com.flywheel.lead.${KEY}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>FLYWHEEL_LEAD_MODEL</key>
        <string>claude-fable-5</string>
    </dict>
		<string>${WRAPPER_V2}</string>
    <string>${M_PATH}</string>
</dict></plist>`;
		const deps = makeDeps({
			files: {
				[M_PATH]: JSON.stringify({
					pid: 42,
					projectName: "geo",
					leadId: "product-lead",
					socketPath: deriveLeadSocketPath(
						"geo/product-lead",
						`${HOME}/.flywheel`,
					),
				}),
				[P_PATH]: multiline,
			},
			panes: [],
		});
		const snap = await collectFleetSnapshot([project()], () => undefined, deps);
		expect(snap.leads[0]!.carrier.plistModel).toBe("claude-fable-5");
	});
});

// ── ConfigSnapshotProvider (R2#4 + R3#4) ─────────────────────────────────

describe("ConfigSnapshotProvider", () => {
	const boot = [project()];

	it("fleet-field overlay: model/backend hot-update onto boot topology", () => {
		let fresh = [project({ model: "fab-2" })];
		const prov = new ConfigSnapshotProvider(boot, {
			loadProjects: () => fresh,
			envPinned: false,
		});
		expect(prov.hasExplicitFleetConfig()).toBe(false);
		prov.refresh();
		expect(prov.snapshot().state).toBe("live");
		expect(prov.snapshot().projects[0]!.leads[0]!.model).toBe("fab-2");
		expect(prov.hasExplicitFleetConfig()).toBe(true);
		// removal also flows (absent → deleted, not stale)
		fresh = [project()];
		prov.refresh();
		expect(prov.snapshot().projects[0]!.leads[0]!.model).toBeUndefined();
		expect(prov.hasExplicitFleetConfig()).toBe(false);
	});

	it('adding the equivalent carrier:"v2" key is a structural no-op', () => {
		const prov = new ConfigSnapshotProvider(boot, {
			loadProjects: () => [project({ carrier: "v2" })],
			envPinned: false,
		});
		prov.refresh();
		expect(prov.snapshot().state).toBe("live");
		expect(prov.snapshot().projects[0]!.leads[0]!.carrier).toBeUndefined();
		expect(prov.hasExplicitFleetConfig()).toBe(false);
	});

	it("FLY-671: effort is a HOT field — add/remove overlays without restart-required", () => {
		let fresh = [project({ effort: "high" })];
		const prov = new ConfigSnapshotProvider(boot, {
			loadProjects: () => fresh,
			envPinned: false,
		});
		expect(prov.hasExplicitFleetConfig()).toBe(false);
		prov.refresh();
		// hot-add effort → live (NOT restart-required), value overlaid.
		expect(prov.snapshot().state).toBe("live");
		expect(prov.snapshot().projects[0]!.leads[0]!.effort).toBe("high");
		expect(prov.hasExplicitFleetConfig()).toBe(true);
		// model + effort together stays live.
		fresh = [project({ model: "fab-2", effort: "medium" })];
		prov.refresh();
		expect(prov.snapshot().state).toBe("live");
		expect(prov.snapshot().projects[0]!.leads[0]!.effort).toBe("medium");
		// hot-remove effort → absent (deleted, not stale).
		fresh = [project()];
		prov.refresh();
		expect(prov.snapshot().state).toBe("live");
		expect(prov.snapshot().projects[0]!.leads[0]!.effort).toBeUndefined();
	});

	it("structural change (new lead) → restart-required + last-known-good (R3#4)", () => {
		const structural: ProjectEntry = {
			...project({ model: "x" }),
			leads: [
				...project().leads,
				{ agentId: "ops-lead", chatChannel: "2", match: { labels: ["O"] } },
			],
		};
		const prov = new ConfigSnapshotProvider(boot, {
			loadProjects: () => [structural],
			envPinned: false,
		});
		prov.refresh();
		expect(prov.snapshot().state).toBe("restart-required");
		expect(prov.snapshot().projects[0]!.leads).toHaveLength(1);
		expect(prov.snapshot().projects[0]!.leads[0]!.model).toBeUndefined();
	});

	it("parse failure → degraded + last-known-good", () => {
		let fail = false;
		const prov = new ConfigSnapshotProvider(boot, {
			loadProjects: () => {
				if (fail) throw new Error("bad json");
				return [project({ model: "ok" })];
			},
			envPinned: false,
		});
		prov.refresh();
		expect(prov.snapshot().projects[0]!.leads[0]!.model).toBe("ok");
		fail = true;
		prov.refresh();
		expect(prov.snapshot().state).toBe("degraded");
		expect(prov.snapshot().projects[0]!.leads[0]!.model).toBe("ok");
	});

	it("FLYWHEEL_PROJECTS env mode → env-pinned, no hot reload", () => {
		const prov = new ConfigSnapshotProvider(boot, {
			loadProjects: () => [project({ model: "should-not-land" })],
			envPinned: true,
		});
		prov.refresh();
		expect(prov.snapshot().state).toBe("env-pinned");
		expect(prov.snapshot().projects[0]!.leads[0]!.model).toBeUndefined();
	});
});

// ── FleetPoller staleness + overlap ──────────────────────────────────────

describe("FleetPoller", () => {
	it("stale snapshot resolves to null (consumers degrade to indeterminate, R6#5)", async () => {
		let nowMs = 0;
		const deps = makeDeps({ files: {}, panes: [] });
		deps.now = () => new Date(nowMs);
		const prov = new ConfigSnapshotProvider([project()], {
			loadProjects: () => [project()],
			envPinned: false,
		});
		const poller = new FleetPoller({
			provider: prov,
			legacyBackendOf: () => undefined,
			deps,
			intervalMs: 1000,
			stalenessMs: 5000,
		});
		await poller.collectOnce();
		expect(poller.snapshot()).not.toBeNull();
		nowMs = 10_000;
		expect(poller.snapshot()).toBeNull();
	});
});

// ── Dashboard payload gate (R1#6) ────────────────────────────────────────

describe("DashboardPayload fleet gate", () => {
	it("no fleet argument → payload has NO fleet key (byte-compat)", () => {
		const fakeStore = {
			getActiveSessions: () => [],
			getTerminalSessionsSince: () => [],
			getRecentOutcomeSessions: () => [],
			getStuckSessions: () => [],
			getDeliveryStats: () => ({
				pending_count: 0,
				total_delivered: 0,
				total_failed: 0,
				last_failure_error: null,
				last_failure_at: null,
			}),
			// biome-ignore lint/suspicious/noExplicitAny: minimal store stub
		} as any;
		const payload = buildDashboardPayload(fakeStore, 30);
		expect(Object.keys(payload)).not.toContain("fleet");
		const withFleet = buildDashboardPayload(fakeStore, 30, {
			collectedAt: "t",
			configState: "live",
			leads: [],
		});
		expect(withFleet.fleet).toBeDefined();
	});
});
