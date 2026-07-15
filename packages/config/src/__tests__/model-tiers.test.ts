/**
 * FLY-728: per-issue model routing — model tier vocabulary tests.
 * Single source for: the dispatch `model` param whitelist (C), the tier→model
 * default mapping, and the F/O/S/H thread-title short code (D).
 * FLY-751: medium tier drops [1m]; 1M is explicit opt-in (opus-1m / fable-1m).
 */
import { describe, expect, it } from "vitest";
import {
	ACCEPTED_DISPATCH_MODELS,
	MODEL_TIERS,
	modelShortCode,
	normalizeDispatchModel,
} from "../model-tiers.js";

describe("normalizeDispatchModel", () => {
	it("accepts the 4 canonical tier ids verbatim", () => {
		expect(normalizeDispatchModel("claude-fable-5")).toBe("claude-fable-5");
		// FLY-751: medium tier no longer carries [1m] — small context by default.
		expect(normalizeDispatchModel("claude-opus-4-8")).toBe("claude-opus-4-8");
		expect(normalizeDispatchModel("claude-sonnet-5")).toBe("claude-sonnet-5");
		expect(normalizeDispatchModel("claude-haiku-4-5-20251001")).toBe(
			"claude-haiku-4-5-20251001",
		);
	});

	it("maps bare aliases to canonical ids (case-insensitive, trimmed)", () => {
		expect(normalizeDispatchModel("fable")).toBe("claude-fable-5");
		expect(normalizeDispatchModel("FABLE")).toBe("claude-fable-5");
		expect(normalizeDispatchModel("  opus  ")).toBe("claude-opus-4-8");
		expect(normalizeDispatchModel("Sonnet")).toBe("claude-sonnet-5");
		expect(normalizeDispatchModel("haiku")).toBe("claude-haiku-4-5-20251001");
	});

	it("FLY-751: 1M context is explicit opt-in via -1m aliases / [1m] ids", () => {
		expect(normalizeDispatchModel("opus-1m")).toBe("claude-opus-4-8[1m]");
		expect(normalizeDispatchModel("fable-1m")).toBe("claude-fable-5[1m]");
		expect(normalizeDispatchModel(" OPUS-1M ")).toBe("claude-opus-4-8[1m]");
		expect(normalizeDispatchModel("claude-opus-4-8[1m]")).toBe(
			"claude-opus-4-8[1m]",
		);
		expect(normalizeDispatchModel("claude-fable-5[1m]")).toBe(
			"claude-fable-5[1m]",
		);
	});

	it("returns null for unknown / empty / non-tier models (boundary reject)", () => {
		expect(normalizeDispatchModel("gpt-5.5-codex")).toBeNull();
		expect(normalizeDispatchModel("gemini-3-pro-preview")).toBeNull();
		// the simple tier is Sonnet 5 now → the older 4.6 id is not a 728 tier.
		expect(normalizeDispatchModel("claude-sonnet-4-6")).toBeNull();
		expect(normalizeDispatchModel("")).toBeNull();
		expect(normalizeDispatchModel("   ")).toBeNull();
		expect(normalizeDispatchModel("opusish")).toBeNull();
	});
});

describe("ACCEPTED_DISPATCH_MODELS (FLY-751 error-payload discoverability)", () => {
	it("every listed spelling is accepted by normalizeDispatchModel", () => {
		for (const spelling of ACCEPTED_DISPATCH_MODELS) {
			expect(normalizeDispatchModel(spelling)).not.toBeNull();
		}
	});

	it("includes tier ids, bare aliases, and the 1M opt-ins", () => {
		expect(ACCEPTED_DISPATCH_MODELS).toContain("claude-opus-4-8");
		expect(ACCEPTED_DISPATCH_MODELS).toContain("opus");
		expect(ACCEPTED_DISPATCH_MODELS).toContain("opus-1m");
		expect(ACCEPTED_DISPATCH_MODELS).toContain("fable-1m");
		expect(ACCEPTED_DISPATCH_MODELS).toContain("claude-fable-5[1m]");
	});
});

describe("modelShortCode (F/O/S/H)", () => {
	it("maps resolved model ids (and bare aliases) to a single letter", () => {
		expect(modelShortCode("claude-fable-5")).toBe("F");
		expect(modelShortCode("claude-fable-5[1m]")).toBe("F");
		expect(modelShortCode("claude-opus-4-8[1m]")).toBe("O");
		expect(modelShortCode("claude-opus-4-8")).toBe("O");
		expect(modelShortCode("claude-sonnet-5")).toBe("S");
		expect(modelShortCode("claude-sonnet-4-6")).toBe("S"); // family match (any Sonnet)
		expect(modelShortCode("claude-haiku-4-5-20251001")).toBe("H");
		// bare aliases (label path stores these verbatim)
		expect(modelShortCode("opus")).toBe("O");
		expect(modelShortCode("sonnet")).toBe("S");
		expect(modelShortCode("haiku")).toBe("H");
		expect(modelShortCode("fable")).toBe("F");
	});

	it("is undefined for account default (no override) and non-Claude models", () => {
		expect(modelShortCode(undefined)).toBeUndefined();
		expect(modelShortCode(null)).toBeUndefined();
		expect(modelShortCode("")).toBeUndefined();
		expect(modelShortCode("gpt-5.5-codex")).toBeUndefined();
		expect(modelShortCode("gemini-3-pro-preview")).toBeUndefined();
	});
});

describe("MODEL_TIERS", () => {
	it("carries the 4 tiers with canonical id + code (medium small-context, FLY-751)", () => {
		expect(MODEL_TIERS.heavy.id).toBe("claude-fable-5");
		expect(MODEL_TIERS.heavy.code).toBe("F");
		expect(MODEL_TIERS.medium.id).toBe("claude-opus-4-8");
		expect(MODEL_TIERS.medium.code).toBe("O");
		expect(MODEL_TIERS.light.id).toBe("claude-sonnet-5");
		expect(MODEL_TIERS.light.code).toBe("S");
		expect(MODEL_TIERS.trivial.id).toBe("claude-haiku-4-5-20251001");
		expect(MODEL_TIERS.trivial.code).toBe("H");
	});
});
