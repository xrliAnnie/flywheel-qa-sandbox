import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../../ProjectConfig.js";
import { LeadActivityService } from "../lead-activity-service.js";
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
		expect(peak).toBeLessThanOrEqual(4);
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
