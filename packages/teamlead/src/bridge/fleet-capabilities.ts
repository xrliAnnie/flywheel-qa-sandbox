/**
 * FLY-247 inc2a (§2.4 / §2.6): server-derived capability bits for the Fleet
 * console. The UI renders these verbatim and hardcodes NO eligibility rules, so
 * when FLY-245 (write-capable Codex) or FLY-264 (managed backend switch) land,
 * the chips light up via a server-side rule change with zero UI edits.
 *
 * Canonical model facts (verified against `~/.flywheel/fleet-model-setup.md`):
 *   - Fable 5      → explicit model id  "claude-fable-5"
 *   - Opus 4.8     → account default    = JSON `null` (no model override)
 *   - Codex GPT-5  → display-only (the Codex thread carries no model; inc2a does
 *                    NOT switch Codex tiers — single read-only option)
 */

import {
	effectiveLeadBackend,
	type LeadBackendId,
} from "../lead-backends/lead-backend.js";
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

/** Claude tier options: Fable 5 (explicit) + Opus 4.8 (account default = null). */
export const CLAUDE_TIER_OPTIONS: readonly TierOption[] = [
	{ id: "claude-fable-5", label: "Fable 5" },
	{ id: null, label: "Opus 4.8" },
];

/** Codex tier options: single, read-only GPT-5 (display-only; not switchable). */
export const CODEX_TIER_OPTIONS: readonly TierOption[] = [
	{ id: null, label: "GPT-5", readonly: true },
];

export const DISABLED_BACKEND_SWITCH = "受管后端切换 = FLY-264";
export const DISABLED_WRITE_LEAD_CODEX =
	"write-capable Lead 切 Codex 需 FLY-245";

/**
 * A Lead is "write-capable" — and therefore cannot legally run the Codex
 * backend (FLY-245 fail-close) — unless it is a read-only companion:
 * `companion === true` AND `canSpawnRunners === false`. Mirrors the cross-field
 * invariant enforced in `parseAndValidateProjects`.
 */
export function isCodexEligible(lead: LeadConfig): boolean {
	return lead.companion === true && lead.canSpawnRunners === false;
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
	};
}
