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

		expect(snapshot.normalizeDispatchModel("opus")).toBe("claude-opus-5");
		expect(snapshot.normalizeDispatchModel("opus[1m]")).toBe(
			"claude-opus-5[1m]",
		);
		expect(snapshot.tiers).toMatchObject({
			heavy: { id: "claude-fable-5", code: "F" },
			medium: { id: "claude-opus-5", code: "O" },
			light: { id: "claude-opus-5", code: "O" },
			trivial: { id: "claude-opus-5", code: "O" },
		});
		expect(snapshot.phases).toEqual({
			design: { vendor: "claude", model: "claude-fable-5" },
			implement: { vendor: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
			qa: { vendor: "claude", model: "claude-opus-5" },
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
		const first = `${JSON.stringify({
			version: 1,
			bindings: { opus: "claude-opus-5" },
		})} `;
		const second = JSON.stringify({
			version: 1,
			bindings: { opus: "claude-fable-5" },
		});
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
		expect(after.normalizeDispatchModel("opus")).toBe("claude-fable-5");
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
					},
				],
				tiers: { heavy: "fable-6" },
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.normalizeDispatchModel("fable-6")).toBe("claude-fable-6");
		expect(snapshot.tiers.heavy.id).toBe("claude-fable-6");
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

	it("falls back only the tier/phase keys the registry cannot honor", () => {
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
				phases: {
					design: {
						vendor: "claude",
						model: "claude-opus-4-8",
					},
					qa: { vendor: "claude", model: "gpt-5.6-sol" },
				},
			}),
		);

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.tiers.heavy.id).toBe("claude-fable-5");
		expect(snapshot.tiers.medium.id).toBe("claude-opus-5");
		expect(snapshot.tiers.light.id).toBe("claude-sonnet-5");
		// A legacy identity is not dispatch-capable, so a difficulty tier cannot
		// select it — but it IS a runner-surface Claude model, so a phase row
		// that names it explicitly is honored. Configuration is the authority;
		// there is no separate blocklist second-guessing it.
		expect(snapshot.phases.design).toEqual({
			vendor: "claude",
			model: "claude-opus-4-8",
		});
		expect(snapshot.phases.qa).toEqual({
			vendor: "claude",
			model: "claude-opus-5",
		});
		expect(warn.mock.calls.flat().join(" ")).toMatch(/tier.*phase/i);
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
				bindings: { opus: "claude-fable-5" },
			}),
		);
		expect(getModelConfigSnapshot().normalizeDispatchModel("opus")).toBe(
			"claude-fable-5",
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
		expect(snapshot.normalizeDispatchModel("fable")).toBe("claude-fable-5");
		expect(warn.mock.calls.flat().join(" ")).toMatch(/models/i);
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

	it("writes the account-default sentinel through untouched", () => {
		expect(
			validateModelWrite(null, { surface: "lead", runtimeVendor: "claude" }),
		).toBeNull();
	});

	it("substitutes Fable at Lead boot only when the spelling cannot resolve", () => {
		expect(resolveLeadLaunchSelection("claude-not-a-model", "high")).toEqual({
			model: "claude-fable-5",
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
			model: "claude-fable-5",
			effort: null,
			substituted: false,
			reason: "authoritative_absence",
		});
	});
});
