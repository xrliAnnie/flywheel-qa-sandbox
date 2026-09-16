import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterializeEpicPageDeps } from "../../epic-page/materialize.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { RunnerAdmissionController } from "../runner-admission.js";
import type { BridgeConfig } from "../types.js";

const pageWiringMocks = vi.hoisted(() => ({
	materialize: vi.fn(async () => ({ page: {}, snapshot: null, receipt: {} })),
	readAttention: vi.fn(async () => ({})),
}));
vi.mock("../../epic-page/materialize.js", async (load) => ({
	...(await load<typeof import("../../epic-page/materialize.js")>()),
	materializeEpicPage: pageWiringMocks.materialize,
}));
vi.mock("../../epic-page/attention-sources.js", async (load) => ({
	...(await load<typeof import("../../epic-page/attention-sources.js")>()),
	readAttentionSources: pageWiringMocks.readAttention,
}));
vi.mock("../epic-page-refresher.js", async (load) => ({
	...(await load<typeof import("../epic-page-refresher.js")>()),
	runEpicPageAttempt: async (
		deps: { materialize: (input: unknown) => unknown },
		input: unknown,
	) => deps.materialize(input),
}));

const epicResidualMocks = vi.hoisted(() => ({
	createEpicResidualScan: vi.fn(() => ({
		materializeForScan: vi.fn(),
		summarizeForLead: vi.fn(),
	})),
	epicResidualBootWarnings: vi.fn(() => [
		"[patrol_tick] epic residual wiring sentinel",
	]),
}));
const patrolTickMocks = vi.hoisted(() => ({
	createLeadPatrolTickPass: vi.fn(() => vi.fn(async () => {})),
}));

vi.mock("../epic-residual-scan.js", () => epicResidualMocks);
vi.mock("../patrol-tick.js", () => ({
	createLeadPatrolTickPass: patrolTickMocks.createLeadPatrolTickPass,
	patrolSessionKey: vi.fn(
		(projectName: string, leadId: string) => `${projectName}:${leadId}`,
	),
}));
vi.mock("../terminal-tab-reaper.js", () => ({
	reapTerminalTabs: vi.fn(async () => ({
		scanned: 0,
		closed: 0,
		preserved: 0,
		errors: [],
	})),
}));
vi.mock("../viewer-session-reaper.js", () => ({
	deriveOwnedBaseSessions: vi.fn(() => new Set<string>()),
	reapViewerSessions: vi.fn(async () => ({
		scanned: 0,
		killed: 0,
		skippedAttached: 0,
		skippedActive: 0,
		skippedForeign: 0,
		errors: [],
	})),
}));

import { startBridge } from "../plugin.js";

function config(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "default-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		linearApiKey: "linear-test-key",
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
	};
}

const projects: ProjectEntry[] = [
	{
		projectName: "test-project",
		projectRoot: "/tmp/test-project",
		linear: { team: "TEST", project: "Test Project" },
		leads: [
			{
				agentId: "default-lead",
				summaryRole: "producer",
				chatChannel: "test-channel",
				match: { labels: ["Default"] },
			},
			{
				agentId: "backend-lead",
				summaryRole: "producer",
				chatChannel: "test-channel",
				match: { labels: ["Backend"] },
				canSpawnRunners: false,
			},
		],
	},
];

describe("FLY-2141 production plugin wiring", () => {
	let closeBridge: (() => Promise<void>) | undefined;

	beforeEach(() => {
		vi.stubEnv("TEAMLEAD_DEFAULT_LEAD_AGENT", "default-lead");
		vi.stubEnv("DISCORD_OWNER_USER_ID", "test-founder");
		pageWiringMocks.materialize.mockClear();
		pageWiringMocks.readAttention.mockClear();
		epicResidualMocks.createEpicResidualScan.mockClear();
		epicResidualMocks.epicResidualBootWarnings.mockClear();
		patrolTickMocks.createLeadPatrolTickPass.mockClear();
	});

	afterEach(async () => {
		try {
			await closeBridge?.();
			closeBridge = undefined;
		} finally {
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
		}
	});

	it("creates one scan, emits boot warnings once, and injects the production owner resolver", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const bridge = await startBridge(
			{ ...config(), discordGuildId: "123456789" },
			projects,
		);
		closeBridge = bridge.close;
		expect(bridge.store.readDiscordConfig()).toMatchObject({
			guild_id: "123456789",
			state: "configured",
			source: "DISCORD_GUILD_ID",
		});

		expect(epicResidualMocks.createEpicResidualScan).toHaveBeenCalledOnce();
		expect(epicResidualMocks.epicResidualBootWarnings).toHaveBeenCalledOnce();
		expect(epicResidualMocks.epicResidualBootWarnings).toHaveBeenCalledWith(
			projects,
			true,
		);
		expect(warn).toHaveBeenCalledWith(
			"[patrol_tick] epic residual wiring sentinel",
		);

		const deps = epicResidualMocks.createEpicResidualScan.mock.calls[0]?.[0];
		expect(deps).toMatchObject({
			store: bridge.store,
			projects,
			linearApiKey: "linear-test-key",
			resolveOwner: expect.any(Function),
			runAttempt: expect.any(Function),
			log: expect.any(Function),
		});
		expect(deps?.resolveOwner("test-project", ["Backend"])).toEqual({
			agentId: "backend-lead",
			matchMethod: "label",
			canSpawn: false,
		});
		expect(deps?.resolveOwner("test-project", ["Unrelated"])).toEqual({
			agentId: "default-lead",
			matchMethod: "general",
			canSpawn: true,
		});
		expect(patrolTickMocks.createLeadPatrolTickPass).toHaveBeenCalledOnce();
		expect(patrolTickMocks.createLeadPatrolTickPass).toHaveBeenCalledWith(
			expect.objectContaining({
				epicResidual:
					epicResidualMocks.createEpicResidualScan.mock.results[0]?.value,
			}),
		);
	});

	it("background refresh resolves child links and shares the active scope with attention", async () => {
		const scopedProjects = projects.map((project) => ({
			...project,
			leads: project.leads.map((lead) => ({
				...lead,
				chatChannel: "1516209714097291335",
			})),
		}));
		const bridge = await startBridge(
			{ ...config(), discordGuildId: "1485787271192907816" },
			scopedProjects,
		);
		closeBridge = bridge.close;
		bridge.store.upsertChatThread(
			"1549550796725690459",
			"1516209714097291335",
			"TEST-1",
			"default-lead",
		);
		const scan = epicResidualMocks.createEpicResidualScan.mock.calls[0]?.[0];
		const input = {
			projectName: "test-project",
			binding: { team: "TEST", project: "Test Project" },
			apiKey: "fixture",
			trigger: "manual",
			version: 1,
			reasons: [],
		};
		await scan.runAttempt(input);
		const deps = pageWiringMocks.materialize.mock.calls.at(
			-1,
		)?.[0] as MaterializeEpicPageDeps;
		const now = new Date("2026-09-16T05:00:00Z");
		const items = [
			{ id: "12345678-1234-4123-8123-123456789abc", identifier: "TEST-1" },
		];
		expect(
			deps
				.readChildThreads?.("test-project", items as never, now)
				.get(items[0]!.id)?.value,
		).toBe(
			"https://discord.com/channels/1485787271192907816/1549550796725690459",
		);
		const snapshot = Promise.resolve(null);
		await deps.readAttention(input as never, now, snapshot);
		expect(pageWiringMocks.readAttention).toHaveBeenLastCalledWith(
			{ stateStore: bridge.store },
			expect.objectContaining({
				scopeSnapshot: snapshot,
				channelIds: ["1516209714097291335", "1516209714097291335"],
			}),
		);
	});

	it("FLY-2143 assembles one shared Epic refresh and report serialization graph", () => {
		const source = readFileSync(
			new URL("../plugin.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain(
			"const reportCriticalSection = createReportCriticalSection();",
		);
		expect(source).toContain(
			"const epicPageSerializer = createEpicPageSerializer();",
		);
		expect(source).toContain(
			"const epicPagePublisher = createEpicPagePublisher({",
		);
		expect(source).toContain(
			"const epicPageRefresher = createEpicPageRefresher({",
		);
		expect(source).toContain("criticalSection: reportCriticalSection");
		expect(source).toContain("serializer: epicPageSerializer");
		expect(source).toContain("publisher: epicPagePublisher");
		expect(source).toContain("epicPageRefresher");
	});
});
