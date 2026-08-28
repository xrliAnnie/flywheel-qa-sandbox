import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetModelConfigCacheForTests } from "flywheel-config";
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
					summaryRole: "producer",
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

/**
 * FLY-1650 (Codex R3): the launcher's FLY-583 companion fallback used to be a
 * hardcoded `xhigh` in the shell, which could re-add the very effort this
 * resolver had just rejected. The resolver now reports the fallback already
 * narrowed to the resolved model, and the shell only decides *when* to apply
 * one. Narrowing-only: for every model that accepts `xhigh` the value is
 * byte-identical to the old literal.
 */
describe("FLY-1650 companion fallback effort", () => {
	it("stays the literal xhigh for models that accept it", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const model of ["opus", "fable", "sonnet"]) {
			withProjects({ model }, () => {
				expect(
					resolveLeadModelLaunch("flywheel", "eng-lead").companionDefaultEffort,
				).toBe("xhigh");
			});
		}
	});

	it("is null when the resolved model accepts no xhigh", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		// Opus 4.6 has no `xhigh` (it arrived with 4.7). It carries no lead
		// surface today, so reaching it as a Lead means an operator declared it
		// in models.json — exactly the case the shell could not validate.
		const previousConfig = process.env.FLYWHEEL_MODELS_CONFIG;
		const dir = mkdtempSync(join(tmpdir(), "fly1650-lead-launch-"));
		const configPath = join(dir, "models.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-opus-4-6",
						label: "Opus 4.6",
						provider: "anthropic",
						runtimeVendor: "claude",
						aliases: [],
					},
				],
			}),
		);
		process.env.FLYWHEEL_MODELS_CONFIG = configPath;
		resetModelConfigCacheForTests();
		try {
			withProjects({ model: "claude-opus-4-6" }, () => {
				const decision = resolveLeadModelLaunch("flywheel", "eng-lead");
				expect(decision.model).toBe("claude-opus-4-6");
				expect(decision.companionDefaultEffort).toBeNull();
			});
		} finally {
			if (previousConfig === undefined) {
				delete process.env.FLYWHEEL_MODELS_CONFIG;
			} else {
				process.env.FLYWHEEL_MODELS_CONFIG = previousConfig;
			}
			resetModelConfigCacheForTests();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
