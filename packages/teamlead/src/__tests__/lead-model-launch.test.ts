import { describe, expect, it, vi } from "vitest";
import { resolveLeadModelLaunch } from "../lead-model-launch.js";

function withProjects(lead: Record<string, unknown>, run: () => void): void {
	const previous = process.env.FLYWHEEL_PROJECTS;
	process.env.FLYWHEEL_PROJECTS = JSON.stringify([
		{
			projectName: "flywheel",
			projectRoot: "/tmp/flywheel",
			leads: [
				{
					agentId: "eng-lead",
					chatChannel: "1",
					match: { labels: ["eng"] },
					...lead,
				},
			],
		},
	]);
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env.FLYWHEEL_PROJECTS;
		else process.env.FLYWHEEL_PROJECTS = previous;
	}
}

describe("resolveLeadModelLaunch", () => {
	it("derives configured aliases and effort from projects.json", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		withProjects({ model: "opus", effort: "high" }, () => {
			expect(resolveLeadModelLaunch("flywheel", "eng-lead")).toMatchObject({
				rawModel: "opus",
				rawEffort: "high",
				model: "claude-opus-5",
				effort: "high",
				substituted: false,
			});
		});
	});

	it("authoritative absence resets model and effort instead of using stale carriers", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		withProjects({}, () => {
			expect(resolveLeadModelLaunch("flywheel", "eng-lead")).toMatchObject({
				rawModel: null,
				rawEffort: null,
				model: "claude-fable-5",
				effort: null,
				reason: "authoritative_absence",
			});
		});
	});

	it("substitutes Fable for an unresolvable project value", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		withProjects({ model: "claude-not-a-model" }, () => {
			expect(resolveLeadModelLaunch("flywheel", "eng-lead")).toMatchObject({
				rawModel: "claude-not-a-model",
				model: "claude-fable-5",
				substituted: true,
				reason: "model_invalid",
			});
		});
	});

	it("launches exactly the legacy id the authoritative source pins", () => {
		withProjects({ model: "claude-opus-4-8[1m]" }, () => {
			expect(resolveLeadModelLaunch("flywheel", "eng-lead")).toMatchObject({
				rawModel: "claude-opus-4-8[1m]",
				model: "claude-opus-4-8[1m]",
				substituted: false,
				reason: "configured",
			});
		});
	});

	it("fails closed when launch identity cannot be proven", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		withProjects({}, () => {
			expect(() => resolveLeadModelLaunch("other", "eng-lead")).toThrow(
				/identity failure/,
			);
		});
	});
});
