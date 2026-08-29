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
	it("Claude tiers = Fable 5 + Opus 4.8 (1M) + Opus 4.8 (null) + Sonnet 4.6 + Haiku 4.5 + Sonnet 5 (FLY-728 appended)", () => {
		expect(CLAUDE_TIER_OPTIONS).toEqual([
			{ id: "claude-fable-5", label: "Fable 5" },
			// FLY-360: explicit 1M-context selector (Claude Code CLI `[1m]` suffix).
			{ id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)" },
			{ id: null, label: "Opus 4.8" },
			// FLY-671: cheaper tiers appended (high→low) so cost-sensitive Leads can
			// be downgraded from the console. Appended (not reordered) so the existing
			// three entries keep their positions (reverse-compat for any ordinal use).
			{ id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
			{ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
			// FLY-728: Sonnet 5 = current fleet Sonnet (the simple-tier model);
			// appended so all existing ordinals stay byte-compatible.
			{ id: "claude-sonnet-5", label: "Sonnet 5" },
		]);
	});

	it("Codex tier = single read-only GPT-5 (display-only)", () => {
		expect(CODEX_TIER_OPTIONS).toEqual([
			{ id: null, label: "GPT-5", readonly: true },
		]);
	});

	it("computeTierOptions picks by effective backend", () => {
		expect(computeTierOptions("claude-code")).toBe(CLAUDE_TIER_OPTIONS);
		expect(computeTierOptions("codex-app-server")).toBe(CODEX_TIER_OPTIONS);
	});
});

describe("fleet-capabilities — allowedModelTargets (R6 #5)", () => {
	it("Claude targets = tier ids ∪ {null} (account-default is a legal target)", () => {
		const targets = computeAllowedModelTargets("claude-code");
		expect(targets).toContain("claude-fable-5");
		expect(targets).toContain("claude-opus-4-8[1m]"); // FLY-360: 1M selector authorized
		expect(targets).toContain("claude-sonnet-4-6"); // FLY-671: cheaper tier authorized
		expect(targets).toContain("claude-haiku-4-5-20251001"); // FLY-671: cheaper tier authorized
		expect(targets).toContain("claude-sonnet-5"); // FLY-728: current fleet Sonnet
		expect(targets).toContain(null); // explicit → account default is legal
	});

	it("does not duplicate null when a tier already exposes it", () => {
		const targets = computeAllowedModelTargets("claude-code");
		expect(targets.filter((t) => t === null)).toHaveLength(1);
	});

	it("Codex Lead targets = only null (no managed model switch)", () => {
		expect(computeAllowedModelTargets("codex-app-server")).toEqual([null]);
	});
});

describe("fleet-capabilities — effort options/targets (FLY-671, backend-aware)", () => {
	it("EFFORT_OPTIONS = 默认(null) + the five CLI levels", () => {
		expect(EFFORT_OPTIONS.map((o) => o.id)).toEqual([
			null,
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
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

	it("Codex Lead effort is display-only: only null target, readonly chip", () => {
		expect(computeAllowedEffortTargets("codex-app-server")).toEqual([null]);
		const opts = computeEffortOptions("codex-app-server");
		expect(opts).toHaveLength(1);
		expect(opts[0]?.readonly).toBe(true);
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
		expect(cap.tierOptions).toBe(CLAUDE_TIER_OPTIONS);
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
