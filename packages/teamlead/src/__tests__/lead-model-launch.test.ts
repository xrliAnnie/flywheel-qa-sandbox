import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetModelConfigCacheForTests } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import {
	resolveLeadAutoCompactWindow,
	resolveLeadModelLaunch,
} from "../lead-model-launch.js";

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

const compactBaseline = {
	inputFloorTokens: 180000,
	inputFloorOffTokens: 190000,
	claudeVersion: "2.test",
	model: "claude-fable-5-1",
	rulesBodySha: "a".repeat(64),
	toolsConfigSha: "b".repeat(64),
	bootstrapPolicyVersion: "bounded-v1",
};

it("freezes the optional compaction baseline with the same model decision", () => {
	withProjects(
		{
			model: "fable",
			autoCompactWindowTokens: 400000,
			autoCompactBaseline: compactBaseline,
		},
		() => {
			const decision = resolveLeadModelLaunch("flywheel", "eng-lead");
			expect(decision.autoCompactWindowTokens).toBe(400000);
			expect(decision.autoCompactBaseline).toEqual(compactBaseline);
			expect(resolveLeadAutoCompactWindow(decision, compactBaseline)).toEqual({
				windowTokens: 400000,
				reason: "eligible",
			});
			for (const key of [
				"claudeVersion",
				"model",
				"rulesBodySha",
				"toolsConfigSha",
				"bootstrapPolicyVersion",
			] as const) {
				expect(
					resolveLeadAutoCompactWindow(decision, {
						...compactBaseline,
						[key]: "changed",
					}).windowTokens,
				).toBeNull();
			}
			expect(
				resolveLeadAutoCompactWindow(
					{ ...decision, autoCompactWindowTokens: 200000 },
					compactBaseline,
				).windowTokens,
			).toBeNull();
			expect(
				resolveLeadAutoCompactWindow(
					{ ...decision, autoCompactBaseline: undefined },
					compactBaseline,
				).windowTokens,
			).toBeNull();
		},
	);
});
it("requires enough working room at higher measured floors", () => {
	withProjects(
		{
			model: "fable",
			autoCompactWindowTokens: 450000,
			autoCompactBaseline: { ...compactBaseline, inputFloorTokens: 250000 },
		},
		() => {
			const decision = resolveLeadModelLaunch("flywheel", "eng-lead");
			expect(
				resolveLeadAutoCompactWindow(decision, compactBaseline).windowTokens,
			).toBeNull();
			expect(
				resolveLeadAutoCompactWindow(
					{ ...decision, autoCompactWindowTokens: 500000 },
					compactBaseline,
				).windowTokens,
			).toBe(500000);
		},
	);
});

it("does not project a Claude compaction setting for a Codex Lead", () => {
	withProjects(
		{
			backend: "codex-app-server",
			codexProfile: "companion",
			canSpawnRunners: false,
			autoCompactWindowTokens: 400000,
			autoCompactBaseline: compactBaseline,
		},
		() => {
			const decision = resolveLeadModelLaunch("flywheel", "eng-lead");
			expect(decision).not.toHaveProperty("autoCompactWindowTokens");
			expect(decision).not.toHaveProperty("autoCompactBaseline");
		},
	);
});

it("invalid optimization settings do not prevent model resolution", () => {
	for (const window of [0, 200000, 1000001, 400000.5, "400000"]) {
		withProjects(
			{
				model: "fable",
				autoCompactWindowTokens: window,
				autoCompactBaseline: compactBaseline,
			},
			() => {
				const decision = resolveLeadModelLaunch("flywheel", "eng-lead");
				expect(decision.model).toBe("claude-fable-5-1");
				expect(
					resolveLeadAutoCompactWindow(decision, compactBaseline).windowTokens,
				).toBeNull();
			},
		);
	}
	withProjects({ model: "fable" }, () => {
		const decision = resolveLeadModelLaunch("flywheel", "eng-lead");
		expect(decision).not.toHaveProperty("autoCompactWindowTokens");
		expect(decision).not.toHaveProperty("autoCompactBaseline");
	});
});

describe("resolveLeadModelLaunch", () => {
	it("derives configured aliases and effort from projects.json", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		withProjects({ model: "opus", effort: "high" }, () => {
			expect(resolveLeadModelLaunch("flywheel", "eng-lead")).toMatchObject({
				rawModel: "opus",
				rawEffort: "high",
				model: "claude-opus-5-5",
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
				model: "claude-fable-5-1",
				effort: null,
				contextWindowTokens: 1_000_000,
				reason: "authoritative_absence",
			});
		});
	});

	it("substitutes Fable for an unresolvable project value", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		withProjects({ model: "claude-not-a-model" }, () => {
			expect(resolveLeadModelLaunch("flywheel", "eng-lead")).toMatchObject({
				rawModel: "claude-not-a-model",
				model: "claude-fable-5-1",
				contextWindowTokens: 1_000_000,
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

	it("carries only registry-trusted context metadata into the frozen launch decision", () => {
		withProjects({ model: "fable" }, () => {
			expect(resolveLeadModelLaunch("flywheel", "eng-lead")).toMatchObject({
				model: "claude-fable-5-1",
				contextWindowTokens: 1_000_000,
			});
		});
		withProjects({ model: "claude-opus-4-8[1m]" }, () => {
			expect(resolveLeadModelLaunch("flywheel", "eng-lead")).toMatchObject({
				model: "claude-opus-4-8[1m]",
				contextWindowTokens: 1_000_000,
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

it("requires measured OFF recovery headroom before enabling the native window", () => {
	for (const floor of [undefined, 0, 250000, 300000]) {
		withProjects(
			{
				model: "fable",
				autoCompactWindowTokens: 400000,
				autoCompactBaseline: { ...compactBaseline, inputFloorOffTokens: floor },
			},
			() => {
				const decision = resolveLeadModelLaunch("flywheel", "eng-lead");
				expect(
					resolveLeadAutoCompactWindow(decision, compactBaseline).windowTokens,
				).toBeNull();
			},
		);
	}
});
