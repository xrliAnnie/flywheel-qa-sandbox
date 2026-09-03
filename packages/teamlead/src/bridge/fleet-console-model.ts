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

import { type FlagView, getModelConfigSnapshot } from "flywheel-config";
import type { LeadBackendId } from "../lead-backends/lead-backend.js";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import {
	type BackendOption,
	computeLeadCapabilities,
	type TierOption,
} from "./fleet-capabilities.js";
import type { ManagementSnapshot } from "./management-console-contract.js";

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
	/** Resolved display label for the active tier (e.g. "Fable 5", "Opus 5"). */
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

/**
 * FLY-728 seam (read-only): a per-issue model override, sourced from FLY-728's
 * mechanism when it lands. FLY-709 only DISPLAYS this; it does not build the
 * mechanism. Absent provider → the console omits the section entirely (no empty
 * placeholder implying the feature exists).
 */
export interface PerIssueModelView {
	issueId: string;
	identifier: string;
	model: string;
	source: string;
}

/** A provider FLY-728 wires in later; FLY-709 renders read-only if present. */
export interface PerIssueModelProvider {
	list(): PerIssueModelView[];
}

/**
 * FLY-709 ② (b): a project's DEFAULT runner model/effort/backend, read-only, from
 * `roles.runner` in `<projectRoot>/.flywheel/config.yaml` (FLY-671). This is the
 * per-project Runner default — distinct from the per-Lead model chips (FLY-247,
 * which stay editable and unchanged). 709 only DISPLAYS it; changing the default
 * runner model is a follow-up (config.yaml writer, P3) / the FLY-728 label path.
 */
export interface ProjectRunnerDefaultView {
	projectName: string;
	/** roles.runner.model, or null = account default (no override). */
	model: string | null;
	/** roles.runner.effort, or null = default (no --effort). */
	effort: string | null;
	/** roles.runner.backend, or null = default (claude-tmux). */
	backend: string | null;
	/** Config load error surfaced as data (never silently defaulted). */
	error?: string;
}

/**
 * FLY-709 P4.4 — cron (recurring xiaohongshu trigger issue) model rows: one
 * per enabled collection, with the configured `collections[].model` (null =
 * default). The console renders a copy-command targeting
 * `flywheel-comm runner-config apply --cron`.
 */
export interface CronModelView {
	projectName: string;
	collectionId: string;
	label: string;
	leadId: string;
	model: string | null;
}

/**
 * FLY-709 P4.3 — static option lists for the per-project runner-default
 * dropdowns (the RUNNER executor layer, where the full 4-backend set lives —
 * distinct from the 2-option Lead backend).
 */
export interface RunnerCapabilities {
	backends: readonly string[];
	models: readonly string[];
	efforts: readonly string[];
}

export interface ConsoleSnapshot {
	leads: ConsoleLeadView[];
	/** FLY-709: every registered feature flag's current state (read-only view). */
	featureFlags?: FlagView[];
	/** FLY-728 seam: present only when a provider is wired. */
	perIssueModels?: PerIssueModelView[];
	/** FLY-709 ② (b): per-project runner default model (read-only). */
	projectRunnerDefaults?: ProjectRunnerDefaultView[];
	/** FLY-709 P4.4: cron recurring-issue model rows. */
	cronModels?: CronModelView[];
	/** FLY-709 P4.3: dropdown options for the runner-default rows. */
	runnerCapabilities?: RunnerCapabilities;
	/**
	 * FLY-709 P4.2 (Codex R1 #4): the Bridge-runtime engine/CLI paths the
	 * copy-command builders quote — never a hardcoded checkout. Local machine
	 * paths only (not secrets); the pages that receive them are the loopback
	 * console and the unguessable-token hosted ops page.
	 */
	fleetScriptPath?: string;
	commCliPath?: string;
}

/** Versioned replacement used while the old flat DTO remains route-compatible. */
export type VersionedConsoleSnapshot = ManagementSnapshot;

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
 * aligned with the fleet CLI).
 */
export function buildConsoleLeadView(
	projectName: string,
	lead: LeadConfig,
	legacyBackend?: string | null,
): ConsoleLeadView {
	const cap = computeLeadCapabilities(lead, legacyBackend);
	// inc1 keeps `model` absent (not normalized); absent = account default = null.
	const currentModelId = typeof lead.model === "string" ? lead.model : null;
	const effectiveModelForDisplay =
		currentModelId ??
		(cap.currentBackend === "claude-code"
			? getModelConfigSnapshot().bindings.fable
			: null);
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
		currentModelLabel: modelLabelFor(cap.tierOptions, effectiveModelForDisplay),
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
export interface ConsoleSnapshotExtras {
	/** FLY-709: resolved feature-flag views (from flywheel-config resolveAllFlags). */
	featureFlags?: FlagView[];
	/** FLY-728 seam: per-issue model rows (omitted when no provider). */
	perIssueModels?: PerIssueModelView[];
	/** FLY-709 ② (b): per-project runner default model rows (read-only). */
	projectRunnerDefaults?: ProjectRunnerDefaultView[];
	/** FLY-709 P4.4: cron recurring-issue model rows. */
	cronModels?: CronModelView[];
	/** FLY-709 P4.3: dropdown options for the runner-default rows. */
	runnerCapabilities?: RunnerCapabilities;
	/** FLY-709 P4.2: Bridge-runtime engine/CLI paths for the copy commands. */
	fleetScriptPath?: string;
	commCliPath?: string;
}

export function buildConsoleSnapshot(
	projects: ProjectEntry[],
	legacyBackendOf?: (
		projectName: string,
		lead: LeadConfig,
	) => string | null | undefined,
	extras?: ConsoleSnapshotExtras,
): ConsoleSnapshot {
	const leads: ConsoleLeadView[] = [];
	for (const project of projects) {
		for (const lead of project.leads) {
			const legacy = legacyBackendOf?.(project.projectName, lead) ?? undefined;
			leads.push(buildConsoleLeadView(project.projectName, lead, legacy));
		}
	}
	const snapshot: ConsoleSnapshot = { leads };
	if (extras?.featureFlags) {
		snapshot.featureFlags = extras.featureFlags;
	}
	// FLY-728 seam: only attach when a provider actually supplied rows.
	if (extras?.perIssueModels && extras.perIssueModels.length > 0) {
		snapshot.perIssueModels = extras.perIssueModels;
	}
	// FLY-709 ② (b): attach when a provider is wired (omitted → no section).
	if (
		extras?.projectRunnerDefaults &&
		extras.projectRunnerDefaults.length > 0
	) {
		snapshot.projectRunnerDefaults = extras.projectRunnerDefaults;
	}
	// FLY-709 P4.4: cron rows — same omitted-when-empty contract.
	if (extras?.cronModels && extras.cronModels.length > 0) {
		snapshot.cronModels = extras.cronModels;
	}
	if (extras?.runnerCapabilities) {
		snapshot.runnerCapabilities = extras.runnerCapabilities;
	}
	if (extras?.fleetScriptPath)
		snapshot.fleetScriptPath = extras.fleetScriptPath;
	if (extras?.commCliPath) snapshot.commCliPath = extras.commCliPath;
	return snapshot;
}

/** Keys that must NEVER appear in the secret-free console DTO. */
export const FORBIDDEN_DTO_KEYS = ["botToken", "botTokenEnv", "match"] as const;
