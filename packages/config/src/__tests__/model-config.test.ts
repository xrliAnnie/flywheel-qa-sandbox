import {
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getModelConfigSnapshot,
	ModelPolicyError,
	resetModelConfigCacheForTests,
	resolveAllowedCanonicalModel,
	resolveLeadLaunchSelection,
	validateModelWrite,
} from "../model-config.js";
import { modelDisplayName } from "../model-tiers.js";

describe("FLY-1496 model configuration snapshots", () => {
	let root: string;
	let configPath: string;
	let previousPath: string | undefined;
	let previousHome: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly1496-model-config-"));
		configPath = join(root, "models.json");
		previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
		previousHome = process.env.HOME;
		process.env.FLYWHEEL_MODELS_CONFIG = configPath;
		resetModelConfigCacheForTests();
	});

	afterEach(() => {
		if (previousPath === undefined) {
			delete process.env.FLYWHEEL_MODELS_CONFIG;
		} else {
			process.env.FLYWHEEL_MODELS_CONFIG = previousPath;
		}
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		resetModelConfigCacheForTests();
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("warns and uses fail-safe built-ins when an explicit config file is missing", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const snapshot = getModelConfigSnapshot();

		expect(snapshot.normalizeDispatchModel("fable")).toBe("claude-fable-5-1");
		expect(snapshot.normalizeDispatchModel("fable-1m")).toBe(
			"claude-fable-5-1[1m]",
		);
		expect(snapshot.getModelRegistryEntry("fable")?.contextWindowTokens).toBe(
			1_000_000,
		);
		expect(snapshot.getModelRegistryEntry("fable")?.maxInputTokens).toBe(
			1_000_000,
		);
		expect(
			snapshot.getModelRegistryEntry("fable-1m")?.contextWindowTokens,
		).toBe(1_000_000);
		expect(snapshot.normalizeDispatchModel("opus")).toBe("claude-opus-5");
		expect(snapshot.normalizeDispatchModel("opus[1m]")).toBe(
			"claude-opus-5[1m]",
		);
		expect(snapshot.tiers).toMatchObject({
			heavy: { id: "claude-fable-5-1", code: "F" },
			medium: { id: "claude-opus-5", code: "O" },
			light: { id: "claude-opus-5", code: "O" },
			trivial: { id: "claude-opus-5", code: "O" },
		});
		// One warning per cached generation, not one per call.
		getModelConfigSnapshot();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("silently uses built-ins when the implicit optional file is absent", () => {
		delete process.env.FLYWHEEL_MODELS_CONFIG;
		process.env.HOME = root;
		resetModelConfigCacheForTests();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(getModelConfigSnapshot().normalizeDispatchModel("opus")).toBe(
			"claude-opus-5",
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("hot-reloads an atomically replaced same-size binding without code or restart", () => {
		const firstRaw = JSON.stringify({
			version: 1,
			bindings: { opus: "claude-opus-5" },
		});
		const second = JSON.stringify({
			version: 1,
			bindings: { opus: "claude-fable-5-1" },
		});
		const first = firstRaw.padEnd(Buffer.byteLength(second), " ");
		expect(Buffer.byteLength(first)).toBe(Buffer.byteLength(second));
		writeFileSync(configPath, first);

		const before = getModelConfigSnapshot();
		expect(before.normalizeDispatchModel("opus")).toBe("claude-opus-5");

		const replacement = join(root, "models.next");
		writeFileSync(replacement, second);
		renameSync(replacement, configPath);
		// Make the cache-key transition explicit even on coarse test filesystems.
		const stat = statSync(configPath);
		utimesSync(configPath, stat.atime, new Date(stat.mtimeMs + 5));

		const after = getModelConfigSnapshot();
		expect(after.revision).not.toBe(before.revision);
		expect(after.normalizeDispatchModel("opus")).toBe("claude-fable-5-1");
		// A business decision that already captured a snapshot stays one generation.
		expect(before.normalizeDispatchModel("opus")).toBe("claude-opus-5");
	});

	it("merges a configured model and tier without a code change", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-fable-6",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 6",
						aliases: ["fable-6"],
						dispatch: true,
						maxInputTokens: 1_000_000,
						contextWindowTokens: 200_000,
					},
				],
				tiers: { heavy: "fable-6" },
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.normalizeDispatchModel("fable-6")).toBe("claude-fable-6");
		expect(snapshot.tiers.heavy.id).toBe("claude-fable-6");
		expect(snapshot.getModelRegistryEntry("fable-6")?.contextWindowTokens).toBe(
			200_000,
		);
		expect(snapshot.getModelRegistryEntry("fable-6")?.maxInputTokens).toBe(
			1_000_000,
		);
	});

	it("preserves builtin family aliases and window metadata for same-id overlays", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-fable-5-1",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.1 overlay",
						aliases: ["fable-5-1"],
						dispatch: true,
					},
					{
						id: "claude-fable-5-1[1m]",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.1 1M overlay",
						aliases: ["fable-5-1-1m"],
						dispatch: true,
					},
				],
				tiers: { heavy: "claude-fable-5-1" },
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.getDispatchCanonical("fable")).toBe("claude-fable-5-1");
		expect(snapshot.getDispatchCanonical("fable-1m")).toBe(
			"claude-fable-5-1[1m]",
		);
		expect(snapshot.getModelRegistryEntry("fable")?.contextWindowTokens).toBe(
			1_000_000,
		);
		expect(
			snapshot.getModelRegistryEntry("fable-1m")?.contextWindowTokens,
		).toBe(1_000_000);
		expect(snapshot.getModelRegistryEntry("fable")?.label).toBe(
			"Fable 5.1 overlay",
		);
	});

	it("moves the complete Fable family alias binding to a future model pair", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-fable-5-2",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.2",
						aliases: ["fable-5-2"],
						dispatch: true,
						contextWindowTokens: 1_000_000,
					},
					{
						id: "claude-fable-5-2[1m]",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.2 (1M)",
						aliases: ["fable-5-2-1m"],
						dispatch: true,
						contextWindowTokens: 1_000_000,
					},
				],
				bindings: { fable: "claude-fable-5-2" },
				tiers: { heavy: "fable" },
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.bindings.fable).toBe("claude-fable-5-2");
		expect(snapshot.getDispatchCanonical("fable")).toBe("claude-fable-5-2");
		expect(snapshot.getDispatchCanonical("fable-1m")).toBe(
			"claude-fable-5-2[1m]",
		);
		expect(snapshot.getDispatchCanonical("fable[1m]")).toBe(
			"claude-fable-5-2[1m]",
		);
		expect(snapshot.tiers.heavy.id).toBe("claude-fable-5-2");
		expect(snapshot.getDispatchCanonical("claude-fable-5-1")).toBe(
			"claude-fable-5-1",
		);
	});

	it("moves the builtin heavy tier with bindings.fable when tiers are omitted", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-fable-5-2",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.2",
						aliases: ["fable-5-2"],
						dispatch: true,
					},
					{
						id: "claude-fable-5-2[1m]",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.2 (1M)",
						aliases: ["fable-5-2-1m"],
						dispatch: true,
					},
				],
				bindings: { fable: "claude-fable-5-2" },
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.getDispatchCanonical("fable")).toBe("claude-fable-5-2");
		expect(snapshot.tiers.heavy).toEqual({
			id: "claude-fable-5-2",
			aliases: ["fable"],
			code: "F",
		});
	});

	it("keeps the complete builtin Fable binding when the future 1M partner is absent", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-fable-5-2",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.2",
						aliases: ["fable-5-2"],
						dispatch: true,
						contextWindowTokens: 200_000,
					},
				],
				bindings: { fable: "claude-fable-5-2" },
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.bindings.fable).toBe("claude-fable-5-1");
		expect(snapshot.getDispatchCanonical("fable")).toBe("claude-fable-5-1");
		expect(snapshot.getDispatchCanonical("fable-1m")).toBe(
			"claude-fable-5-1[1m]",
		);
		expect(warn.mock.calls.flat().join(" ")).toMatch(/bindings\.fable/);
	});

	it("rejects a complete non-Fable pair as the Fable family binding", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-opus-6",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Opus 6",
						aliases: ["opus-6"],
						dispatch: true,
					},
					{
						id: "claude-opus-6[1m]",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Opus 6 (1M)",
						aliases: ["opus-6-1m"],
						dispatch: true,
					},
				],
				bindings: { fable: "claude-opus-6" },
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.bindings.fable).toBe("claude-fable-5-1");
		expect(snapshot.getDispatchCanonical("fable")).toBe("claude-fable-5-1");
		expect(warn.mock.calls.flat().join(" ")).toMatch(/bindings\.fable/);
	});

	it("does not mislabel an added model family as Haiku", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-nova-6",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Nova 6",
						aliases: ["nova"],
						dispatch: true,
					},
				],
				tiers: { heavy: "nova" },
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.tiers.heavy.code).toBeUndefined();
		expect(modelDisplayName("claude-nova-6", "heavy")).toBeUndefined();
	});

	it("falls back only the tier keys the registry cannot honor", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				tiers: {
					heavy: "codex",
					medium: "claude-opus-4-8",
					light: "sonnet",
				},
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.tiers.heavy.id).toBe("claude-fable-5-1");
		expect(snapshot.tiers.medium.id).toBe("claude-opus-5");
		expect(snapshot.tiers.light.id).toBe("claude-sonnet-5");
		expect(warn.mock.calls.flat().join(" ")).toMatch(/tier/i);
	});

	it("recovers across missing → valid → malformed → repaired generations", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(
			getModelConfigSnapshot().normalizeDispatchModel("future"),
		).toBeNull();

		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-future",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Future",
						aliases: ["future"],
						dispatch: true,
					},
				],
			}),
		);
		expect(getModelConfigSnapshot().normalizeDispatchModel("future")).toBe(
			"claude-future",
		);

		writeFileSync(configPath, "{bad json");
		expect(
			getModelConfigSnapshot().normalizeDispatchModel("future"),
		).toBeNull();

		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				bindings: { opus: "claude-fable-5-1" },
			}),
		);
		expect(getModelConfigSnapshot().normalizeDispatchModel("opus")).toBe(
			"claude-fable-5-1",
		);
	});

	it("discards a conflicting models overlay as one segment", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-extra-a",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Extra A",
						aliases: ["collision"],
						dispatch: true,
					},
					{
						id: "claude-extra-b",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Extra B",
						aliases: ["collision"],
						dispatch: true,
					},
				],
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.getModelRegistryEntry("claude-extra-a")).toBeNull();
		expect(snapshot.getModelRegistryEntry("claude-extra-b")).toBeNull();
		expect(snapshot.normalizeDispatchModel("fable")).toBe("claude-fable-5-1");
		expect(warn.mock.calls.flat().join(" ")).toMatch(/models/i);
	});

	it("discards a models overlay with an unsafe context window", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-unsafe-window",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Unsafe window",
						aliases: ["unsafe-window"],
						dispatch: true,
						contextWindowTokens: 0,
					},
				],
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.getModelRegistryEntry("unsafe-window")).toBeNull();
		expect(warn.mock.calls.flat().join(" ")).toMatch(/contextWindowTokens/);
	});
});

describe("FLY-1496 canonical model resolution", () => {
	let root: string;
	let previousPath: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly1496-model-policy-"));
		previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
		process.env.FLYWHEEL_MODELS_CONFIG = join(root, "missing.json");
		resetModelConfigCacheForTests();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		if (previousPath === undefined) {
			delete process.env.FLYWHEEL_MODELS_CONFIG;
		} else {
			process.env.FLYWHEEL_MODELS_CONFIG = previousPath;
		}
		resetModelConfigCacheForTests();
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("canonicalizes an alias to the id the binding currently points at", () => {
		expect(
			resolveAllowedCanonicalModel("opus", {
				surface: "runner",
				runtimeVendor: "claude",
			}),
		).toBe("claude-opus-5");
	});

	it("rejects a spelling no configured model can claim", () => {
		expect(() =>
			resolveAllowedCanonicalModel("claude-not-a-model", {
				surface: "runner",
				runtimeVendor: "claude",
			}),
		).toThrowError(ModelPolicyError);
		try {
			resolveAllowedCanonicalModel("claude-not-a-model", {
				surface: "runner",
				runtimeVendor: "claude",
			});
		} catch (error) {
			expect((error as ModelPolicyError).code).toBe("INVALID_MODEL");
		}
	});

	it("resolves a legacy identity faithfully when it is what config names", () => {
		// No blocklist second-guesses the authoritative source: an operator who
		// deliberately pins a legacy id gets exactly that id, canonicalized.
		for (const model of ["claude-opus-4-8", "claude-opus-4-8[1m]"]) {
			expect(
				resolveAllowedCanonicalModel(model, {
					surface: "lead",
					runtimeVendor: "claude",
				}),
			).toBe(model);
		}
		// It stays out of the pickers, because it is not selectable anywhere.
		expect(
			getModelConfigSnapshot().isModelSelectable({
				surface: "lead",
				model: "claude-opus-4-8",
			}),
		).toBe(false);
		// It stays dispatchable so an old pinned carrier keeps working, but no
		// tier or picker points at it, so nothing NEW is routed there.
		expect(
			getModelConfigSnapshot().getDispatchCanonical("claude-opus-4-8"),
		).toBe("claude-opus-4-8");
		expect(getModelConfigSnapshot().tiers.medium.id).toBe("claude-opus-5");
	});

	it("keeps pinned Fable 5 identities dispatchable but non-selectable", () => {
		const snapshot = getModelConfigSnapshot();
		for (const model of ["claude-fable-5", "claude-fable-5[1m]"]) {
			expect(snapshot.getDispatchCanonical(model)).toBe(model);
			expect(snapshot.isModelSelectable({ surface: "workflow", model })).toBe(
				false,
			);
		}
		expect(snapshot.getModelRegistryEntry("claude-fable-5")?.label).toBe(
			"Fable 5",
		);
		expect(snapshot.getModelRegistryEntry("claude-fable-5[1m]")?.label).toBe(
			"Fable 5 (1M)",
		);
	});

	it("writes the account-default sentinel through untouched", () => {
		expect(
			validateModelWrite(null, { surface: "lead", runtimeVendor: "claude" }),
		).toBeNull();
	});

	it("substitutes Fable at Lead boot only when the spelling cannot resolve", () => {
		expect(resolveLeadLaunchSelection("claude-not-a-model", "high")).toEqual({
			model: "claude-fable-5-1",
			effort: "high",
			substituted: true,
			reason: "model_invalid",
		});
		expect(resolveLeadLaunchSelection("claude-opus-4-8[1m]", "high")).toEqual({
			model: "claude-opus-4-8[1m]",
			effort: "high",
			substituted: false,
			reason: "configured",
		});
		expect(resolveLeadLaunchSelection(undefined, undefined)).toEqual({
			model: "claude-fable-5-1",
			effort: null,
			substituted: false,
			reason: "authoritative_absence",
		});
	});

	it("resolves Lead absence and invalid fallback from the bound Fable family", () => {
		const configPath = process.env.FLYWHEEL_MODELS_CONFIG!;
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-fable-5-2",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.2",
						aliases: ["fable-5-2"],
						dispatch: true,
					},
					{
						id: "claude-fable-5-2[1m]",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.2 (1M)",
						aliases: ["fable-5-2-1m"],
						dispatch: true,
						contextWindowTokens: 1_000_000,
					},
				],
				bindings: { fable: "claude-fable-5-2" },
				tiers: { heavy: "fable" },
			}),
		);
		const snapshot = getModelConfigSnapshot();
		expect(
			resolveLeadLaunchSelection(undefined, undefined, snapshot).model,
		).toBe("claude-fable-5-2");
		expect(
			resolveLeadLaunchSelection("claude-not-a-model", "high", snapshot),
		).toMatchObject({
			model: "claude-fable-5-2",
			effort: "high",
			substituted: true,
		});
	});
});
