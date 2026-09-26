import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../../ProjectConfig.js";
import {
	claudeLeadLocatorOptions,
	LeadActivityService,
} from "../lead-activity-service.js";
import { isValidLeadActivity, isValidLeadActivityFleet } from "../types.js";

const NOW = Date.parse("2026-09-25T20:00:00.000Z");

function roster(): ProjectEntry[] {
	return [
		{
			projectName: "flywheel",
			projectRoot: "/tmp/flywheel",
			leads: [
				{
					agentId: "flywheel-eng-lead",
					forumChannel: "1",
					chatChannel: "2",
					match: {},
				},
				{
					agentId: "codex-infra-bot-lead",
					forumChannel: "1",
					chatChannel: "2",
					match: {},
					backend: "codex-app-server",
				},
			],
		},
		{
			projectName: "raya",
			projectRoot: "/tmp/raya",
			leads: [
				{
					agentId: "raya",
					forumChannel: "1",
					chatChannel: "2",
					match: {},
					backend: "codex-app-server",
				},
				{
					agentId: "weird-lead",
					forumChannel: "1",
					chatChannel: "2",
					match: {},
					backend: "gemini-cli" as never,
				},
			],
		},
	] as unknown as ProjectEntry[];
}

function service(
	over: {
		readClaude?: LeadActivityService["deps"]["readClaude"];
		readCodex?: LeadActivityService["deps"]["readCodex"];
	} = {},
) {
	const deps = {
		projects: roster,
		readClaude: vi.fn(
			over.readClaude ??
				(async () => ({
					reading: { state: "idle" as const },
					observedAtMs: NOW,
				})),
		),
		readCodex: vi.fn(
			over.readCodex ??
				(async () => ({
					reading: {
						state: "unknown" as const,
						reason: "sidecar_lacks_turn_state" as const,
					},
					observedAtMs: NOW,
				})),
		),
		now: () => NOW,
		log: vi.fn(),
	};
	return { deps, svc: new LeadActivityService(deps) };
}

describe("LeadActivityService.read", () => {
	it("returns undefined for a Lead outside the roster", async () => {
		const { svc, deps } = service();
		expect(await svc.read("flywheel", "nobody")).toBeUndefined();
		expect(await svc.read("nowhere", "flywheel-eng-lead")).toBeUndefined();
		expect(deps.readClaude).not.toHaveBeenCalled();
	});

	it("dispatches the default carrier to the Claude reader", async () => {
		const { svc, deps } = service();
		const dto = await svc.read("flywheel", "flywheel-eng-lead");
		expect(dto).toEqual({
			schema: "lead-activity.v1",
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			carrier: "claude-code",
			observedAt: new Date(NOW).toISOString(),
			source: "claude_pane",
			state: "idle",
		});
		expect(isValidLeadActivity(dto)).toBe(true);
		expect(deps.readClaude).toHaveBeenCalledWith(
			"flywheel",
			"flywheel-eng-lead",
		);
		expect(deps.readCodex).not.toHaveBeenCalled();
	});

	it("dispatches codex-app-server Leads to the Codex reader", async () => {
		const { svc, deps } = service();
		const dto = await svc.read("raya", "raya");
		expect(dto).toMatchObject({
			carrier: "codex-app-server",
			source: "codex_sidecar",
			state: "unknown",
			unknown: { reason: "sidecar_lacks_turn_state" },
		});
		expect(isValidLeadActivity(dto)).toBe(true);
		expect(deps.readCodex).toHaveBeenCalledWith("raya", "raya");
	});

	it("answers carrier_unsupported for an unknown backend without reading anything", async () => {
		const { svc, deps } = service();
		const dto = await svc.read("raya", "weird-lead");
		expect(dto).toMatchObject({
			state: "unknown",
			unknown: { reason: "carrier_unsupported" },
		});
		expect(isValidLeadActivity(dto)).toBe(true);
		expect(deps.readClaude).not.toHaveBeenCalled();
		expect(deps.readCodex).not.toHaveBeenCalled();
	});

	it("turns a reader crash into unknown read_failed (never idle) and logs only the reason", async () => {
		const { svc, deps } = service({
			readClaude: async () => {
				throw new Error("SENTINEL secret path /Users/x");
			},
		});
		const dto = await svc.read("flywheel", "flywheel-eng-lead");
		expect(dto).toMatchObject({
			state: "unknown",
			unknown: { reason: "read_failed" },
		});
		expect(JSON.stringify(deps.log.mock.calls)).not.toContain("SENTINEL");
	});
});

describe("LeadActivityService.readFleet", () => {
	it("covers every roster Lead in order with at most four reads in flight", async () => {
		let inFlight = 0;
		let peak = 0;
		const slow = async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			return { reading: { state: "idle" as const }, observedAtMs: NOW };
		};
		const projects = () => {
			const base = roster();
			base[0]!.leads = Array.from({ length: 9 }, (_, i) => ({
				agentId: `lead-${i}`,
				forumChannel: "1",
				chatChannel: "2",
				match: {},
			})) as never;
			return base;
		};
		const svc = new LeadActivityService({
			projects,
			readClaude: slow,
			readCodex: slow,
			now: () => NOW,
		});
		const fleet = await svc.readFleet();
		expect(isValidLeadActivityFleet(fleet)).toBe(true);
		expect(fleet.leads.map((l) => `${l.projectName}/${l.leadId}`)).toEqual([
			...Array.from({ length: 9 }, (_, i) => `flywheel/lead-${i}`),
			"raya/raya",
			"raya/weird-lead",
		]);
		expect(peak).toBeLessThanOrEqual(6);
		expect(peak).toBeGreaterThan(1);
	});

	it("isolates one Lead's failure to that entry", async () => {
		const { svc } = service({
			readCodex: async (_p, leadId) => {
				if (leadId === "raya") throw new Error("boom");
				return { reading: { state: "idle" }, observedAtMs: NOW };
			},
		});
		const fleet = await svc.readFleet();
		expect(fleet.leads.map((l) => [l.leadId, l.state])).toEqual([
			["flywheel-eng-lead", "idle"],
			["codex-infra-bot-lead", "idle"],
			["raya", "unknown"],
			["weird-lead", "unknown"],
		]);
		expect(fleet).toMatchObject({ schema: "lead-activity-fleet.v1" });
	});
});

describe("LeadActivityService — carrier resolution and deadline", () => {
	afterEach(() => vi.useRealTimers());

	it("honours the Bridge-wide legacy backend override like the delivery adapter", async () => {
		const readClaude = vi.fn();
		const readCodex = vi.fn(async () => ({
			reading: { state: "idle" as const },
			observedAtMs: NOW,
		}));
		const svc = new LeadActivityService({
			projects: roster,
			readClaude,
			readCodex,
			now: () => NOW,
			legacyBackend: () => "codex-app-server",
		});
		const dto = await svc.read("flywheel", "flywheel-eng-lead");
		expect(dto).toMatchObject({ carrier: "codex-app-server", state: "idle" });
		expect(readCodex).toHaveBeenCalledWith("flywheel", "flywheel-eng-lead");
		expect(readClaude).not.toHaveBeenCalled();
	});

	it("an explicit backend still wins over the legacy override", async () => {
		const readClaude = vi.fn(async () => ({
			reading: { state: "idle" as const },
			observedAtMs: NOW,
		}));
		const svc = new LeadActivityService({
			projects: () => {
				const base = roster();
				base[0]!.leads[0]!.backend = "claude-code";
				return base;
			},
			readClaude,
			readCodex: vi.fn(),
			now: () => NOW,
			legacyBackend: () => "codex-app-server",
		});
		expect(await svc.read("flywheel", "flywheel-eng-lead")).toMatchObject({
			carrier: "claude-code",
		});
	});

	it("answers read_timed_out when one Lead's read exceeds the deadline", async () => {
		vi.useFakeTimers();
		const svc = new LeadActivityService({
			projects: roster,
			readClaude: () => new Promise(() => {}),
			readCodex: async () => ({
				reading: { state: "idle" },
				observedAtMs: NOW,
			}),
			now: () => Date.now(),
			deadlineMs: 8_000,
		});
		const pending = svc.readFleet();
		await vi.advanceTimersByTimeAsync(8_000);
		const fleet = await pending;
		expect(fleet.leads.map((l) => [l.leadId, l.state])).toEqual([
			["flywheel-eng-lead", "unknown"],
			["codex-infra-bot-lead", "idle"],
			["raya", "idle"],
			["weird-lead", "unknown"],
		]);
		expect(fleet.leads[0]).toMatchObject({
			unknown: { reason: "read_timed_out" },
		});
		expect(isValidLeadActivityFleet(fleet)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("claudeLeadLocatorOptions", () => {
	it("reads production LaunchAgents when the Bridge config names no registry", () => {
		for (const env of [{}, { FLYWHEEL_LEAD_LAUNCHD_REGISTRY: "  " }]) {
			const options = claudeLeadLocatorOptions(env, "/state");
			expect(options.stateDir).toBe("/state");
			expect("launchdRegistryPath" in options).toBe(false);
		}
	});

	it("hands the locator this Bridge's own launchd registry when configured", () => {
		expect(
			claudeLeadLocatorOptions(
				{
					FLYWHEEL_LEAD_LAUNCHD_REGISTRY:
						" /tmp/flywheel-test-slot-2/launchd-leads.json ",
				},
				"/tmp/flywheel-test-slot-2",
			).launchdRegistryPath,
		).toBe("/tmp/flywheel-test-slot-2/launchd-leads.json");
	});
});
