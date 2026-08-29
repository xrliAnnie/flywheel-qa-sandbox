import { buildModelCatalog, ROLE_EFFORT_LEVELS } from "flywheel-config";
import { describe, expect, it } from "vitest";
import {
	CLAUDE_TIER_OPTIONS,
	CODEX_TIER_OPTIONS,
	computeAllowedEffortTargets,
	computeAllowedModelTargets,
	computeBackendOptions,
	computeEffortOptions,
	computeLeadCapabilities,
	computeTierOptions,
	DISABLED_BACKEND_SWITCH,
	DISABLED_WRITE_LEAD_CODEX,
	EFFORT_OPTIONS,
	isCodexEligible,
} from "../bridge/fleet-capabilities.js";
import type { LeadConfig } from "../ProjectConfig.js";

function lead(overrides: Partial<LeadConfig> = {}): LeadConfig {
	return {
		agentId: "x-lead",
		chatChannel: "1",
		match: { labels: ["X"] },
		canSpawnRunners: true,
		...overrides,
	};
}

describe("fleet-capabilities — tier options (FLY-247 inc2a §2.4/§2.6)", () => {
	it("projects Claude tier choices from the canonical Lead model catalog", () => {
		const catalogModels = buildModelCatalog("lead").providers.find(
			(provider) => provider.id === "anthropic",
		)!.models;
		expect(CLAUDE_TIER_OPTIONS.filter((option) => option.id !== null)).toEqual(
			catalogModels.map((model) => ({
				id: model.id,
				label: model.label,
				...(model.selectable ? {} : { readonly: true }),
			})),
		);
	});

	it("lists every model plus account-default, legacy ids readonly", () => {
		expect(CLAUDE_TIER_OPTIONS).toEqual([
			{ id: "claude-fable-5", label: "Fable 5" },
			{ id: "claude-fable-5[1m]", label: "Fable 5 (1M)" },
			{ id: "claude-opus-5", label: "Opus 5" },
			{ id: "claude-opus-5[1m]", label: "Opus 5 (1M)" },
			{ id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
			{ id: "claude-sonnet-5", label: "Sonnet 5" },
			{ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
			// FLY-1467: legacy Opus identities stay listed (label + legal target)
			// but are readonly — visible, never offered as a new choice.
			{ id: "claude-opus-4-8", label: "Opus 4.8", readonly: true },
			{ id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)", readonly: true },
			{ id: null, label: "账号默认" },
		]);
	});

	it("Codex tier = single read-only GPT-5 (display-only)", () => {
		expect(CODEX_TIER_OPTIONS).toEqual([
			{ id: null, label: "GPT-5", readonly: true },
		]);
	});

	it("computeTierOptions picks by effective backend", () => {
		expect(computeTierOptions("claude-code")).toEqual(CLAUDE_TIER_OPTIONS);
		expect(computeTierOptions("codex-app-server")).toBe(CODEX_TIER_OPTIONS);
	});
});

describe("fleet-capabilities — allowedModelTargets (R6 #5)", () => {
	it("Claude targets contain the selectable ids plus account-default", () => {
		const targets = computeAllowedModelTargets("claude-code");
		expect(targets).toContain("claude-fable-5");
		expect(targets).not.toContain("claude-opus-4-8[1m]");
		expect(targets).toContain("claude-sonnet-4-6"); // FLY-671: cheaper tier authorized
		expect(targets).toContain("claude-haiku-4-5-20251001"); // FLY-671: cheaper tier authorized
		expect(targets).toContain("claude-sonnet-5"); // FLY-728: current fleet Sonnet
	});

	it("offers account inheritance as a legal target", () => {
		// Readonly legacy ids stay out; null (back-to-account-default) is legal.
		const targets = computeAllowedModelTargets("claude-code");
		expect(targets).toContain(null);
		expect(targets).not.toContain("claude-opus-4-8[1m]");
	});

	it("Codex Lead targets = only null (no managed model switch)", () => {
		expect(computeAllowedModelTargets("codex-app-server")).toEqual([null]);
	});
});

describe("fleet-capabilities — effort options/targets (FLY-671, backend-aware)", () => {
	it("EFFORT_OPTIONS = 默认(null) + the five CLI levels", () => {
		expect(EFFORT_OPTIONS.map((o) => o.id)).toEqual([
			null,
			...ROLE_EFFORT_LEVELS,
		]);
	});

	it("Claude allowed effort targets = null + five levels", () => {
		expect(computeAllowedEffortTargets("claude-code")).toEqual([
			null,
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(computeEffortOptions("claude-code")).toBe(EFFORT_OPTIONS);
	});

	it("Codex Lead effort uses the same active five-level runtime path", () => {
		expect(computeAllowedEffortTargets("codex-app-server")).toEqual([
			null,
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		const opts = computeEffortOptions("codex-app-server");
		expect(opts).toBe(EFFORT_OPTIONS);
	});

	it("computeLeadCapabilities carries effortOptions + allowedEffortTargets", () => {
		const cap = computeLeadCapabilities(lead({ backend: "claude-code" }));
		expect(cap.allowedEffortTargets).toContain("high");
		expect(cap.allowedEffortTargets).toContain(null);
		expect(cap.effortOptions).toBe(EFFORT_OPTIONS);
	});
});

describe("fleet-capabilities — isCodexEligible (FLY-245 mirror)", () => {
	it("companion + non-spawning Lead is Codex-eligible", () => {
		expect(
			isCodexEligible(lead({ companion: true, canSpawnRunners: false })),
		).toBe(true);
	});

	it("write-capable Lead is NOT Codex-eligible", () => {
		expect(isCodexEligible(lead({ canSpawnRunners: true }))).toBe(false);
		expect(
			isCodexEligible(lead({ companion: false, canSpawnRunners: false })),
		).toBe(false);
		expect(
			isCodexEligible(lead({ companion: true, canSpawnRunners: true })),
		).toBe(false);
	});

	// FLY-350: a Codex Lead that declares an EXPLICIT codexProfile (incl. full-access)
	// is a legitimate Codex backend — no longer "companion-only". Still gated by
	// canSpawnRunners:false (FLY-251 owns Codex runner-spawn).
	it("FLY-350: a full-access Codex Lead (explicit profile, non-spawning) is Codex-eligible", () => {
		expect(
			isCodexEligible(
				lead({ codexProfile: "full-access", canSpawnRunners: false }),
			),
		).toBe(true);
	});

	it("FLY-350: a write-capable Codex Lead is also eligible (explicit tier)", () => {
		expect(
			isCodexEligible(
				lead({ codexProfile: "write-capable", canSpawnRunners: false }),
			),
		).toBe(true);
	});

	it("FLY-350: an explicit-profile Codex Lead that spawns runners is still NOT eligible (FLY-251)", () => {
		expect(
			isCodexEligible(
				lead({ codexProfile: "full-access", canSpawnRunners: true }),
			),
		).toBe(false);
	});
});

describe("fleet-capabilities — backendOptions (inc2a: all switches disabled)", () => {
	it("non-current backend is disabled with the FLY-264 reason", () => {
		const opts = computeBackendOptions(
			lead({ companion: true, canSpawnRunners: false }),
			"claude-code",
		);
		const codex = opts.find((o) => o.backend === "codex-app-server")!;
		// companion Lead → codex is FLY-264-gated, not FLY-245-gated
		expect(codex.switchable).toBe(false);
		expect(codex.disabledReason).toBe(DISABLED_BACKEND_SWITCH);
	});

	it("write-capable Lead's Codex option carries the FLY-245 reason", () => {
		const opts = computeBackendOptions(
			lead({ canSpawnRunners: true }),
			"claude-code",
		);
		const codex = opts.find((o) => o.backend === "codex-app-server")!;
		expect(codex.switchable).toBe(false);
		expect(codex.disabledReason).toBe(DISABLED_WRITE_LEAD_CODEX);
	});

	it("the current backend is not itself a switch target", () => {
		const opts = computeBackendOptions(lead(), "claude-code");
		const current = opts.find((o) => o.backend === "claude-code")!;
		expect(current.switchable).toBe(false);
		expect(current.disabledReason).toBeUndefined();
	});

	it("NEVER marks any backend switchable in inc2a", () => {
		const opts = computeBackendOptions(lead(), "claude-code");
		expect(opts.every((o) => o.switchable === false)).toBe(true);
	});
});

describe("fleet-capabilities — computeLeadCapabilities bundle", () => {
	it("Claude Lead (explicit backend) → claude tiers + targets", () => {
		const cap = computeLeadCapabilities(
			lead({ backend: "claude-code", model: "claude-fable-5" }),
		);
		expect(cap.currentBackend).toBe("claude-code");
		expect(cap.backendSource).toBe("explicit");
		expect(cap.tierOptions).toEqual(CLAUDE_TIER_OPTIONS);
		expect(cap.allowedModelTargets).toContain("claude-fable-5");
	});

	it("Lead with no backend field → default claude (byte-compat)", () => {
		const cap = computeLeadCapabilities(lead());
		expect(cap.currentBackend).toBe("claude-code");
		expect(cap.backendSource).toBe("default");
	});

	it("legacy backend resolves when explicit is unset (source=legacy)", () => {
		const cap = computeLeadCapabilities(lead(), "codex-app-server");
		expect(cap.currentBackend).toBe("codex-app-server");
		expect(cap.backendSource).toBe("legacy");
		expect(cap.tierOptions).toBe(CODEX_TIER_OPTIONS);
	});

	it("companion Codex Lead → codex tiers, model targets only null", () => {
		const cap = computeLeadCapabilities(
			lead({
				backend: "codex-app-server",
				companion: true,
				canSpawnRunners: false,
			}),
		);
		expect(cap.currentBackend).toBe("codex-app-server");
		expect(cap.allowedModelTargets).toEqual([null]);
	});
});
