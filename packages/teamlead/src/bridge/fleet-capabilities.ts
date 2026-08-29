/**
 * FLY-247 inc2a (§2.4 / §2.6): server-derived capability bits for the Fleet
 * console. The UI renders these verbatim and hardcodes NO eligibility rules, so
 * when FLY-245 (write-capable Codex) or FLY-264 (managed backend switch) land,
 * the chips light up via a server-side rule change with zero UI edits.
 *
 * FLY-1496: options are derived from the hot model-policy snapshot. Legacy
 * historical values remain visible as readonly current-state evidence but are
 * never offered as new write targets; account-default inheritance stays a legal
 * target. Codex remains a display-only backend option here.
 */

import { getModelConfigSnapshot, ROLE_EFFORT_LEVELS } from "flywheel-config";
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

/**
 * Claude options are the current snapshot's Lead catalog. Only what this list
 * actually projects moves with config: adding a LEAD-surface model, or changing
 * a projected field (label, Lead membership, selectability). Everything else is
 * invisible here — a runner-only model, a `dispatch` flip, or repointing a
 * binding all leave this list byte-identical (the catalog carries ids/labels,
 * not aliases). There is no blocklist: what config names is what appears here.
 */
function claudeTierOptions(): readonly TierOption[] {
	const snapshot = getModelConfigSnapshot();
	const models = snapshot
		.buildModelCatalog("lead")
		.providers.find((provider) => provider.id === "anthropic")?.models;
	if (!models) {
		throw new Error("canonical model registry has no Anthropic Lead models");
	}
	return [
		...models.map((model) => ({
			id: model.id,
			label: model.label,
			...(model.selectable ? {} : { readonly: true as const }),
		})),
		{ id: null, label: "账号默认" } as const,
	];
}

/** Import-time compatibility view; runtime consumers call computeTierOptions(). */
export const CLAUDE_TIER_OPTIONS: readonly TierOption[] = [
	...claudeTierOptions(),
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
	...ROLE_EFFORT_LEVELS.map((e) => ({ id: e as string, label: e })),
];

/** FLY-2131: Codex maps the same five levels into model_reasoning_effort. */
export const CODEX_EFFORT_OPTIONS: readonly TierOption[] = EFFORT_OPTIONS;

/** Effort chip options for the Lead's effective backend. */
export function computeEffortOptions(
	backend: LeadBackendId,
): readonly TierOption[] {
	return backend === "codex-app-server" ? CODEX_EFFORT_OPTIONS : EFFORT_OPTIONS;
}

/**
 * Legal `to.effort` targets for a managed effort switch, backend-aware (mirrors
 * `computeAllowedModelTargets`): both backends accept the five levels ∪
 * `{null}` (null = delete/back-to-default is a legal target).
 */
export function computeAllowedEffortTargets(
	_backend: LeadBackendId,
): Array<string | null> {
	return [null, ...ROLE_EFFORT_LEVELS];
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
		: claudeTierOptions();
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
	if (backend === "codex-app-server") return [null];
	return computeTierOptions(backend)
		.filter((option) => option.readonly !== true)
		.map((option) => option.id);
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
 * when `lead.backend` is unset, so the effective backend matches the alert
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
