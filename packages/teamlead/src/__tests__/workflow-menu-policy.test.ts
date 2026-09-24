import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkflowMenuPolicyCatalog } from "../workflow-menu-policy.js";

const scratch: string[] = [];

afterEach(() => {
	while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true });
});

describe("workflow menu policy catalog", () => {
	it("publishes the approved weighted-node candidates, defaults, and efforts", () => {
		const catalog = buildWorkflowMenuPolicyCatalog();
		const code = catalog.taskCategories.find(
			(category) => category.taskCategory === "code",
		)!;
		const simpleCode = catalog.taskCategories.find(
			(category) => category.taskCategory === "simple_code",
		)!;
		const astra = {
			alias: "astra",
			provider: "openai",
			vendor: "codex",
			model: "gpt-6-astra",
			label: "GPT-6 Astra",
			allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
			defaultEffort: "xhigh",
		};
		const opus = {
			alias: "opus",
			provider: "anthropic",
			vendor: "claude",
			model: "claude-opus-5-5",
			label: "Opus 5.5",
			allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
		};
		const sol = {
			alias: "sol",
			provider: "openai",
			vendor: "codex",
			model: "gpt-6-sol",
			label: "GPT-6 Sol",
			allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
		};
		const sol56 = {
			alias: "codex",
			provider: "openai",
			vendor: "codex",
			model: "gpt-5.6-sol",
			label: "GPT-5.6",
			allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
		};

		expect(
			code.nodes.find((node) => node.nodeId === "eng_design"),
		).toMatchObject({
			defaultModel: "fable",
			models: expect.arrayContaining([
				{ ...astra, defaultEffort: "high" },
				{ ...opus, defaultEffort: "high" },
			]),
		});
		expect(
			code.nodes.find((node) => node.nodeId === "implement"),
		).toMatchObject({
			defaultModel: "opus",
			models: expect.arrayContaining([
				{ ...opus, defaultEffort: "xhigh" },
				{ ...sol, defaultEffort: "xhigh" },
			]),
		});
		expect(simpleCode.nodes.map((node) => node.nodeId)).toEqual([
			"implement",
			"qa",
		]);
		expect(
			simpleCode.nodes.find((node) => node.nodeId === "implement"),
		).toMatchObject({
			defaultModel: "opus",
			models: expect.arrayContaining([
				{ ...opus, defaultEffort: "xhigh" },
				{ ...sol, defaultEffort: "xhigh" },
			]),
		});
		expect(code.nodes.find((node) => node.nodeId === "qa")).toMatchObject({
			defaultModel: "opus",
			models: expect.arrayContaining([
				{ ...opus, defaultEffort: "high" },
				{ ...sol56, defaultEffort: "high" },
				{ ...sol, defaultEffort: "high" },
			]),
		});
		expect(simpleCode.nodes.find((node) => node.nodeId === "qa")).toMatchObject(
			{
				defaultModel: "opus",
				models: expect.arrayContaining([
					{ ...opus, defaultEffort: "high" },
					{ ...sol, defaultEffort: "high" },
				]),
			},
		);
	});

	it("projects the code QA shape allowlist as canonical runtime tuples", () => {
		const catalog = buildWorkflowMenuPolicyCatalog();
		const code = catalog.taskCategories.find(
			(category) => category.taskCategory === "code",
		);
		const qa = code?.nodes.find((node) => node.nodeId === "qa");

		expect(catalog.schemaVersion).toBe(1);
		expect(code).toMatchObject({
			templateId: "tpl_code",
			source: ".flywheel/agents/registry.yaml#graphs.code",
		});
		expect(qa).toMatchObject({
			defaultModel: "opus",
			source: ".flywheel/agents/registry.yaml#graphs.code.policies.qa",
			models: expect.arrayContaining([
				{
					alias: "opus",
					provider: "anthropic",
					vendor: "claude",
					model: "claude-opus-5-5",
					label: "Opus 5.5",
					allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
					defaultEffort: "high",
				},
				{
					alias: "sol",
					provider: "openai",
					vendor: "codex",
					model: "gpt-6-sol",
					label: "GPT-6 Sol",
					allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
					defaultEffort: "high",
				},
			]),
		});
		expect(qa?.allowedSelections).toEqual(
			expect.arrayContaining([
				{ vendor: "claude", model: "claude-opus-5-5", effort: "low" },
				{ vendor: "claude", model: "claude-opus-5-5", effort: "medium" },
				{ vendor: "claude", model: "claude-opus-5-5", effort: "high" },
				{ vendor: "claude", model: "claude-opus-5-5", effort: "max" },
				{ vendor: "codex", model: "gpt-6-sol", effort: "high" },
			]),
		);
		const serialized = JSON.stringify(catalog);
		expect(serialized).not.toContain("/Users/");
		expect(serialized).not.toMatch(/agentFile|apiToken|secret/i);
	});

	it("reflects an effort removed from the registry without a copied allowlist", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2366-policy-"));
		scratch.push(root);
		const registryPath = join(root, "registry.yaml");
		const bundledPath = new URL(
			"../../../../.flywheel/agents/registry.yaml",
			import.meta.url,
		);
		const registry = readFileSync(bundledPath, "utf8");
		writeFileSync(
			registryPath,
			registry.replace(
				"      qa:\n        defaultModel: opus\n        models:\n          - model: opus\n            allowedEfforts: [low, medium, high, xhigh, max]\n            defaultEffort: high",
				"      qa:\n        defaultModel: opus\n        models:\n          - model: opus\n            allowedEfforts: [low, medium, max]\n            defaultEffort: medium",
			),
		);

		const qa = buildWorkflowMenuPolicyCatalog({ registryPath })
			.taskCategories.find((category) => category.taskCategory === "code")
			?.nodes.find((node) => node.nodeId === "qa");

		expect(qa?.models[0]).toMatchObject({
			allowedEfforts: ["low", "medium", "max"],
			defaultEffort: "medium",
		});
		expect(qa?.allowedSelections).not.toContainEqual(
			expect.objectContaining({ model: "claude-opus-5-5", effort: "high" }),
		);
	});
});
