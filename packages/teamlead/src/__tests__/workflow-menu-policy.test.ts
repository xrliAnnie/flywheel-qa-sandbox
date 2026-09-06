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
			models: [
				{
					alias: "opus",
					provider: "anthropic",
					vendor: "claude",
					model: "claude-opus-5",
					allowedEfforts: ["low", "medium", "high", "max"],
					defaultEffort: "high",
				},
			],
		});
		expect(qa?.allowedSelections).toEqual([
			{ vendor: "claude", model: "claude-opus-5", effort: "low" },
			{ vendor: "claude", model: "claude-opus-5", effort: "medium" },
			{ vendor: "claude", model: "claude-opus-5", effort: "high" },
			{ vendor: "claude", model: "claude-opus-5", effort: "max" },
		]);
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
				"allowedEfforts: [low, medium, high, max]\n            defaultEffort: high",
				"allowedEfforts: [low, medium, max]\n            defaultEffort: medium",
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
			expect.objectContaining({ effort: "high" }),
		);
	});
});
