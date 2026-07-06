import { describe, expect, it } from "vitest";
import { computeAllGates, resolveOneGate } from "../core-room-gate-cli.js";

// Fleet fixture with mixed backends (geoforge3d all-Claude; growth has a codex CoS
// + Claude non-CoS; joycon core-no-CoS; personal-assistant no core).
const projects = [
	{
		projectName: "geoforge3d",
		leads: [
			{ agentId: "cos-lead", chatChannel: "core-geo" },
			{ agentId: "product-lead", chatChannel: "chat-peter" },
			{ agentId: "ops-lead", chatChannel: "chat-oliver" },
		],
		generalChannel: "core-geo",
	},
	{
		projectName: "growth",
		leads: [
			{
				agentId: "mufasa-lead",
				chatChannel: "core-growth",
				backend: "codex-app-server",
			},
			{
				agentId: "codex-sib",
				chatChannel: "chat-codex-sib",
				backend: "codex-app-server",
			},
			{ agentId: "reflection-lead", chatChannel: "chat-reflection" },
		],
		generalChannel: "core-growth",
	},
	{
		projectName: "joycon",
		leads: [{ agentId: "joycon-lead", chatChannel: "chat-joycon" }],
		generalChannel: "core-joycon",
	},
	{
		projectName: "personal-assistant",
		leads: [{ agentId: "belle", chatChannel: "chat-belle" }],
	},
];

describe("core-room-gate-cli helpers (FLY-898)", () => {
	it("computeAllGates: only gated non-CoS leads, backend labeled", () => {
		const all = computeAllGates(projects);
		// geoforge3d Peter + Oliver (claude), growth reflection (claude) + codex-sib (codex).
		// CoS (Simba, Mufasa), joycon single lead, belle (no core) all excluded.
		expect(all).toEqual([
			{
				projectName: "geoforge3d",
				leadId: "product-lead",
				coreChannelId: "core-geo",
				backend: "claude-code",
			},
			{
				projectName: "geoforge3d",
				leadId: "ops-lead",
				coreChannelId: "core-geo",
				backend: "claude-code",
			},
			{
				projectName: "growth",
				leadId: "codex-sib",
				coreChannelId: "core-growth",
				backend: "codex-app-server",
			},
			{
				projectName: "growth",
				leadId: "reflection-lead",
				coreChannelId: "core-growth",
				backend: "claude-code",
			},
		]);
	});

	it("computeAllGates: joycon (core-no-CoS) contributes nothing", () => {
		const all = computeAllGates(projects);
		expect(all.some((e) => e.projectName === "joycon")).toBe(false);
	});

	it("resolveOneGate: found non-CoS → gateNonCoS true", () => {
		const g = resolveOneGate(projects, "geoforge3d", "product-lead");
		expect(g?.gateNonCoS).toBe(true);
		expect(g?.coreChannelId).toBe("core-geo");
	});

	it("resolveOneGate: CoS → gateNonCoS false", () => {
		expect(resolveOneGate(projects, "geoforge3d", "cos-lead")?.gateNonCoS).toBe(
			false,
		);
	});

	it("resolveOneGate: unknown project → undefined", () => {
		expect(resolveOneGate(projects, "nope", "x")).toBeUndefined();
	});

	it("resolveOneGate: unknown lead in known project → undefined", () => {
		expect(resolveOneGate(projects, "geoforge3d", "nope")).toBeUndefined();
	});
});
