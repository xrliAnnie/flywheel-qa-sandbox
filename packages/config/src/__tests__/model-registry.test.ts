import { describe, expect, it } from "vitest";
import {
	assertValidModelRegistry,
	buildModelCatalog,
	getModelRegistryEntry,
	isModelSelectionSupported,
	MODEL_ALIASES,
	MODEL_REGISTRY,
	resolveCurrentModel,
} from "../model-registry.js";
import { MODEL_TIERS } from "../model-tiers.js";

describe("model registry invariants", () => {
	it("exports the stable current-Fable consumer spelling", () => {
		expect(MODEL_ALIASES.FABLE).toBe("fable");
	});

	it("has unique model ids and case-insensitive aliases", () => {
		expect(() => assertValidModelRegistry(MODEL_REGISTRY)).not.toThrow();
		const duplicate = [
			...MODEL_REGISTRY,
			{
				...MODEL_REGISTRY[0]!,
				id: "duplicate-model",
				aliases: [MODEL_REGISTRY[1]!.aliases[0]!],
			},
		];
		expect(() => assertValidModelRegistry(duplicate)).toThrow(/alias/i);
	});

	it("resolves every Claude tier, alias and explicit 1M selector", () => {
		for (const tier of Object.values(MODEL_TIERS)) {
			expect(getModelRegistryEntry(tier.id)?.id).toBe(tier.id);
			for (const alias of tier.aliases) {
				expect(getModelRegistryEntry(alias)?.id).toBe(tier.id);
			}
		}
		expect(getModelRegistryEntry("opus-1m")?.id).toBe("claude-opus-5[1m]");
		expect(getModelRegistryEntry("fable-1m")?.id).toBe("claude-fable-5-1[1m]");
	});

	it("keeps the resume gate's exact compatibility windows in registry metadata", () => {
		for (const id of [
			"claude-opus-5",
			"claude-opus-4-8",
			"claude-opus-4-6",
			"claude-sonnet-4-6",
			"claude-haiku-4-5-20251001",
		]) {
			expect(getModelRegistryEntry(id)?.contextWindowTokens, id).toBe(200_000);
		}
		for (const id of [
			"claude-opus-5[1m]",
			"claude-opus-4-8[1m]",
			"claude-opus-4-6[1m]",
			"claude-sonnet-5",
			"claude-fable-5-1",
			"claude-fable-5-1[1m]",
		]) {
			expect(getModelRegistryEntry(id)?.contextWindowTokens, id).toBe(
				1_000_000,
			);
		}
	});

	it("registers the standard Codex model once, with its menu alias and CLI efforts", () => {
		const codex = getModelRegistryEntry("codex");
		expect(codex).toMatchObject({
			id: "gpt-5.6-sol",
			provider: "openai",
			runtimeVendor: "codex",
			aliases: ["codex"],
		});
		expect(codex?.surfaces).toContain("workflow");
		expect(codex?.effortsBySurface.workflow).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(codex?.effortsBySurface.runner).toEqual(["xhigh"]);
	});

	it("covers every built-in tier", () => {
		for (const tier of Object.values(MODEL_TIERS)) {
			expect(getModelRegistryEntry(tier.id)).not.toBeNull();
		}
	});
});

describe("model registry catalog", () => {
	it("filters provider, model and effort choices by target surface", () => {
		const workflow = buildModelCatalog("workflow");
		expect(workflow.providers.map((provider) => provider.id)).toEqual([
			"anthropic",
			"openai",
		]);
		expect(
			workflow.providers
				.flatMap((provider) => provider.models)
				.find((model) => model.id === "gpt-5.6-sol")?.efforts,
		).toContain("xhigh");
		expect(
			workflow.providers.some((provider) => provider.id === "google"),
		).toBe(false);
		expect(
			workflow.providers
				.flatMap((provider) => provider.models)
				.find((model) => model.id === "claude-fable-5")?.efforts,
		).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(
			buildModelCatalog("cron").providers.flatMap((provider) =>
				provider.models.flatMap((model) => model.efforts),
			),
		).toEqual([]);
	});

	it("renders an unknown current value but never makes it selectable", () => {
		expect(resolveCurrentModel("legacy-private-model", "lead")).toEqual({
			id: "legacy-private-model",
			label: "legacy-private-model",
			provider: null,
			runtimeVendor: null,
			legacyCurrent: true,
			selectable: false,
		});
	});

	it("rejects incompatible vendor, surface and effort combinations", () => {
		expect(
			isModelSelectionSupported({
				surface: "workflow",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				runtimeVendor: "codex",
			}),
		).toBe(true);
		expect(
			isModelSelectionSupported({
				surface: "lead",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				runtimeVendor: "claude",
			}),
		).toBe(false);
		expect(
			isModelSelectionSupported({
				surface: "workflow",
				model: "claude-fable-5",
				effort: "ultra",
			}),
		).toBe(false);
		expect(
			isModelSelectionSupported({
				surface: "cron",
				model: "gpt-5.6-sol",
				effort: "xhigh",
			}),
		).toBe(false);
	});
});
