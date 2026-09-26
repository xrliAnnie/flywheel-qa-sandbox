/**
 * FLY-247 inc2a (§2.4 / §2.6): server-derived capability bits for the Fleet
 * console. The UI renders these verbatim and hardcodes NO eligibility rules, so
 * when FLY-245 (write-capable Codex) or FLY-264 (managed backend switch) land,
 * the chips light up via a server-side rule change with zero UI edits.
 *
 * Canonical model facts (verified against `~/.flywheel/fleet-model-setup.md`):
 *   - Fable 5         → explicit model id  "claude-fable-5"
 *   - Opus 4.8 (1M)   → explicit model id  "claude-opus-4-8[1m]" (FLY-360). The
 *                       `[1m]` suffix is the Claude Code CLI selector for the
 *                       1M-context window; `claude-opus-4-8` is natively a 1M
 *                       model at standard pricing, so this is a window selector,
 *                       NOT a separate/pricier API model.
 *   - Opus 4.8        → account default    = JSON `null` (no model override). In
 *                       Claude Code this defaults the effective window to ~200K.
 *   - Codex GPT-5     → display-only (the Codex thread carries no model; inc2a
 *                       does NOT switch Codex tiers — single read-only option)
 */

import {
	effectiveLeadBackend,
	type LeadBackendId,
} from "../lead-backends/lead-backend.js";
import { EFFORT_LEVELS } from "../lead-effort.js";
import type { LeadConfig } from "../ProjectConfig.js";

/** A selectable level. `id: null` is the account-default tier (no override). */
export interface TierOption {
	/** Exact server-authorized model id, or `null` for account default. */
	id: string | null;
	label: string;
	/** True for a display-only option the user cannot switch away from (Codex). */
	readonly?: boolean;
}

export interface BackendOption {
	backend: LeadBackendId;
	/** Whether the user may switch the Lead TO this backend in inc2a. */
	switchable: boolean;
	/** Present when `switchable` is false — why the option is disabled. */
	disabledReason?: string;
}

/**
 * Claude tier options: Fable 5 (explicit) + Opus 4.8 (1M) (explicit window
 * selector, FLY-360) + Opus 4.8 (account default = null, ~200K window in Claude
 * Code) + Sonnet 4.6 + Haiku 4.5 (FLY-671 cheaper tiers for cost-sensitive
 * Leads — Sonnet is materially cheaper than Opus).
 *
 * FLY-671 canonical model facts:
 *   - Sonnet 4.6 → explicit model id "claude-sonnet-4-6"
 *   - Haiku 4.5  → explicit model id "claude-haiku-4-5-20251001"
 * FLY-728: Sonnet 5 (`claude-sonnet-5`) is the current fleet Sonnet (founder
 * confirmed); it is the FLY-728 simple-tier model. Kept 4.6 (don't remove a
 * FLY-671 tier) and APPENDED Sonnet 5 so all existing ordinals stay
 * byte-compatible; this only EXPANDS `computeAllowedModelTargets`.
 */
export const CLAUDE_TIER_OPTIONS: readonly TierOption[] = [
	{ id: "claude-fable-5", label: "Fable 5" },
	{ id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)" },
	{ id: null, label: "Opus 4.8" },
	{ id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
	{ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
	{ id: "claude-sonnet-5", label: "Sonnet 5" },
];

/** Codex tier options: single, read-only GPT-5 (display-only; not switchable). */
export const CODEX_TIER_OPTIONS: readonly TierOption[] = [
	{ id: null, label: "GPT-5", readonly: true },
];

/**
 * FLY-671: effort chip options. `id: null` = 默认 (no override) — companions
 * still get their FLY-583 `xhigh`; other Leads get the account default. The five
 * explicit levels mirror the Claude CLI `--effort` enum (low → max).
 */
export const EFFORT_OPTIONS: readonly TierOption[] = [
	{ id: null, label: "默认" },
	...EFFORT_LEVELS.map((e) => ({ id: e as string, label: e })),
];

/**
 * Codex effort is display-only (`[null]`), mirroring CODEX_TIER_OPTIONS: a Codex
 * Lead has no `--effort` runtime path (FLY-671 out-of-scope), so the chip is
 * readonly and the only legal target is `null`.
 */
export const CODEX_EFFORT_OPTIONS: readonly TierOption[] = [
	{ id: null, label: "默认", readonly: true },
];

/** Effort chip options for the Lead's effective backend. */
export function computeEffortOptions(
	backend: LeadBackendId,
): readonly TierOption[] {
	return backend === "codex-app-server" ? CODEX_EFFORT_OPTIONS : EFFORT_OPTIONS;
}

/**
 * Legal `to.effort` targets for a managed effort switch, backend-aware (mirrors
 * `computeAllowedModelTargets`): Claude = the five levels ∪ `{null}` (null =
 * delete/back-to-default is a legal target); Codex = `[null]` only (display-only,
 * no switch).
 */
export function computeAllowedEffortTargets(
	backend: LeadBackendId,
): Array<string | null> {
	return backend === "codex-app-server" ? [null] : [null, ...EFFORT_LEVELS];
}

export const DISABLED_BACKEND_SWITCH = "受管后端切换 = FLY-264";
export const DISABLED_WRITE_LEAD_CODEX =
	"write-capable Lead 切 Codex 需 FLY-245";

/**
 * Whether a Lead can legally run the Codex backend. Post-FLY-245/FLY-350 a Codex
 * Lead is no longer "companion-only": a read-only companion (`companion === true`),
 * OR a Lead that declares an EXPLICIT `codexProfile` (companion / write-capable /
 * full-access), is eligible — provided it does NOT
 * spawn Runners (`canSpawnRunners === false`; Codex runner-spawn awaits FLY-251).
 * Mirrors the cross-field invariant enforced in `parseAndValidateProjects`.
 */
export function isCodexEligible(lead: LeadConfig): boolean {
	if (lead.canSpawnRunners !== false) return false;
	return lead.companion === true || lead.codexProfile !== undefined;
}

/** Tier options for the Lead's effective backend. */
export function computeTierOptions(
	backend: LeadBackendId,
): readonly TierOption[] {
	return backend === "codex-app-server"
		? CODEX_TIER_OPTIONS
		: CLAUDE_TIER_OPTIONS;
}

/**
 * The set of legal `to.model` values for a managed level switch on this Lead's
 * effective backend = tier ids ∪ `{null}` (R6 #5: account-default is a legal
 * target so an explicit model can be switched back, consistent with the
 * null-write = delete-field semantics). Codex Leads are model-display-only, so
 * their only legal target is `null` (no switch).
 */
export function computeAllowedModelTargets(
	backend: LeadBackendId,
): Array<string | null> {
	const ids = computeTierOptions(backend).map((t) => t.id);
	return ids.includes(null) ? ids : [...ids, null];
}

/**
 * Backend chip options for a Lead. In inc2a EVERY non-current backend is
 * disabled (managed switch deferred to FLY-264); a write-capable Lead's Codex
 * option carries the more fundamental FLY-245 reason instead.
 */
export function computeBackendOptions(
	lead: LeadConfig,
	currentBackend: LeadBackendId,
): BackendOption[] {
	const all: LeadBackendId[] = ["claude-code", "codex-app-server"];
	return all.map((backend) => {
		if (backend === currentBackend) {
			// The current backend is what the Lead already runs; not a "switch".
			return { backend, switchable: false };
		}
		// Non-current backend: switching is FLY-264 work and not in inc2a.
		// For Codex specifically, a write-capable Lead is additionally blocked by
		// the FLY-245 schema fail-close — surface that as the reason.
		if (backend === "codex-app-server" && !isCodexEligible(lead)) {
			return {
				backend,
				switchable: false,
				disabledReason: DISABLED_WRITE_LEAD_CODEX,
			};
		}
		return {
			backend,
			switchable: false,
			disabledReason: DISABLED_BACKEND_SWITCH,
		};
	});
}

/** Per-Lead capability bundle for the console read model (secret-free). */
export interface LeadCapabilities {
	currentBackend: LeadBackendId;
	backendSource: "explicit" | "legacy" | "default";
	backendOptions: BackendOption[];
	tierOptions: readonly TierOption[];
	allowedModelTargets: Array<string | null>;
	/** FLY-671: effort chip options + allowlist (backend-aware). */
	effortOptions: readonly TierOption[];
	allowedEffortTargets: Array<string | null>;
}

/**
 * Compute the full capability bundle for a Lead. `legacyBackend` is the
 * FLY-224 legacy resolution (config.yaml roles.lead.backend / env) used only
 * when `lead.backend` is unset, so the effective backend matches the watchdog
 * partition and the fleet CLI.
 */
export function computeLeadCapabilities(
	lead: LeadConfig,
	legacyBackend?: string | null,
): LeadCapabilities {
	const { backend, source } = effectiveLeadBackend(lead.backend, legacyBackend);
	return {
		currentBackend: backend,
		backendSource: source,
		backendOptions: computeBackendOptions(lead, backend),
		tierOptions: computeTierOptions(backend),
		allowedModelTargets: computeAllowedModelTargets(backend),
		effortOptions: computeEffortOptions(backend),
		allowedEffortTargets: computeAllowedEffortTargets(backend),
	};
}
