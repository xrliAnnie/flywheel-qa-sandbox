/**
 * FLY-247 inc2a (§2.4, R5 #1): the console READ MODEL.
 *
 * inc1's fleet SSE payload is default-off gated (`hasExplicitFleetConfig()`) —
 * it is omitted entirely when no Lead has an explicit model/backend, and all
 * seven production Leads currently lack those fields. Reusing that payload would
 * render an EMPTY console. So the console gets its own read model that ALWAYS
 * returns every configured Lead with defaults + capabilities, coexisting with
 * the unchanged legacy SSE.
 *
 * The DTO is strictly secret-free (allowlist) — it NEVER embeds `LeadConfig`,
 * which hydrates `botToken` in memory (`ProjectConfig.ts`). Only the fields
 * listed in `ConsoleLeadView` are exposed.
 */

import type { LeadBackendId } from "../lead-backends/lead-backend.js";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import {
	type BackendOption,
	computeLeadCapabilities,
	type TierOption,
} from "./fleet-capabilities.js";

/** Online presentation for the card dot (derived from the fleet evidence). */
export type ConsoleLeadOnline = "online" | "offline" | "degraded" | "unknown";

/** A single Lead card's data — allowlisted, secret-free. */
export interface ConsoleLeadView {
	/** Stable identity: the Lead's agentId. */
	leadId: string;
	/** Exact launchd/manifest/txn key: `${projectName}-${agentId}` (engine key). */
	key: string;
	projectName: string;
	/** Display name (defaults to agentId; UI may enrich with persona name). */
	displayName: string;
	currentBackend: LeadBackendId;
	backendSource: "explicit" | "legacy" | "default";
	/** Active model id, or `null` for the account-default tier. */
	currentModelId: string | null;
	/** Resolved display label for the active tier (e.g. "Fable 5", "Opus 4.8"). */
	currentModelLabel: string;
	backendOptions: BackendOption[];
	tierOptions: readonly TierOption[];
	allowedModelTargets: Array<string | null>;
	/** FLY-671: active effort level, or `null` for the default (no override). */
	currentEffort: string | null;
	/** Resolved display label for the active effort (e.g. "high", "默认"). */
	currentEffortLabel: string;
	/** FLY-671: effort chip options + allowlist (backend-aware). */
	effortOptions: readonly TierOption[];
	allowedEffortTargets: Array<string | null>;
	/**
	 * Online dot state (§2.4 whitelist). Optional: the pure builder leaves it
	 * undefined; `FleetConsole` enriches it from the live fleet evidence. The UI
	 * treats undefined as "unknown".
	 */
	online?: ConsoleLeadOnline;
}

export interface ConsoleSnapshot {
	leads: ConsoleLeadView[];
}

/** Resolve the display label for a Lead's active model under its backend. */
function modelLabelFor(
	tiers: readonly TierOption[],
	modelId: string | null,
): string {
	const match = tiers.find((t) => t.id === modelId);
	if (match) return match.label;
	// An explicit model not in the authorized tier set (e.g. a hand-set legacy
	// value) is shown verbatim rather than mislabeled.
	return modelId ?? tiers.find((t) => t.id === null)?.label ?? "Account 默认";
}

/**
 * Build one Lead's console view. `legacyBackend` is the FLY-224 legacy backend
 * resolution used only when `lead.backend` is unset (keeps the effective backend
 * aligned with the watchdog partition and the fleet CLI).
 */
export function buildConsoleLeadView(
	projectName: string,
	lead: LeadConfig,
	legacyBackend?: string | null,
): ConsoleLeadView {
	const cap = computeLeadCapabilities(lead, legacyBackend);
	// inc1 keeps `model` absent (not normalized); absent = account default = null.
	const currentModelId = typeof lead.model === "string" ? lead.model : null;
	// FLY-671: effort likewise absent = null = 默认 (companion → xhigh at launch).
	const currentEffort = typeof lead.effort === "string" ? lead.effort : null;
	return {
		leadId: lead.agentId,
		key: `${projectName}-${lead.agentId}`,
		projectName,
		displayName: lead.agentId,
		currentBackend: cap.currentBackend,
		backendSource: cap.backendSource,
		currentModelId,
		currentModelLabel: modelLabelFor(cap.tierOptions, currentModelId),
		backendOptions: cap.backendOptions,
		tierOptions: cap.tierOptions,
		allowedModelTargets: cap.allowedModelTargets,
		currentEffort,
		currentEffortLabel: modelLabelFor(cap.effortOptions, currentEffort),
		effortOptions: cap.effortOptions,
		allowedEffortTargets: cap.allowedEffortTargets,
	};
}

/**
 * Build the full console snapshot — EVERY configured Lead across all projects,
 * regardless of whether any has an explicit model/backend (fixes the default-off
 * gate, R5 #1). `legacyBackendOf` optionally supplies the FLY-224 legacy backend
 * per (projectName, agentId).
 */
export function buildConsoleSnapshot(
	projects: ProjectEntry[],
	legacyBackendOf?: (
		projectName: string,
		lead: LeadConfig,
	) => string | null | undefined,
): ConsoleSnapshot {
	const leads: ConsoleLeadView[] = [];
	for (const project of projects) {
		for (const lead of project.leads) {
			const legacy = legacyBackendOf?.(project.projectName, lead) ?? undefined;
			leads.push(buildConsoleLeadView(project.projectName, lead, legacy));
		}
	}
	return { leads };
}

/** Keys that must NEVER appear in the secret-free console DTO. */
export const FORBIDDEN_DTO_KEYS = ["botToken", "botTokenEnv", "match"] as const;
