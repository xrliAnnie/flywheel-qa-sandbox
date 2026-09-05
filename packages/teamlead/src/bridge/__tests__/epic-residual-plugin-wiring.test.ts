import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { RunnerAdmissionController } from "../runner-admission.js";
import type { BridgeConfig } from "../types.js";

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
		const bridge = await startBridge(config(), projects);
		closeBridge = bridge.close;

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
});
