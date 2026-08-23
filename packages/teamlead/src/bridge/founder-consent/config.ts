/**
 * FLY-175 Track 2 — Founder Consent Hard Gate: configuration.
 *
 * Parses the canonical founder identity and `FLYWHEEL_FOUNDER_CONSENT_*` env
 * knobs into a typed config.
 *
 * FLY-1981 solidifies production at `audit_only`; founder identity validation
 * is therefore unconditional and fails fast at boot.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
// FLY-709 F3: DecisionMode + resolveDecisionMode are extracted to flywheel-config
// so the feature-flag registry can compute the DECISION_MODE gate's value without
// flywheel-config depending on flywheel-teamlead. Re-exported here for byte-compat
// (existing importers keep importing DecisionMode/resolveDecisionMode from here).
import { type DecisionMode, resolveDecisionMode } from "flywheel-config";

export type { DecisionMode } from "flywheel-config";
export { resolveDecisionMode } from "flywheel-config";
export type FailMode = "closed" | "open";
export type BypassLabelFreshness = "stored" | "linear_live";

/** Canonical evaluator version string. Bump on any prompt/threshold change. */
export const EVALUATOR_VERSION = "v1.29.2-prompt-rev-1";

export interface FounderConsentConfig {
	decisionMode: DecisionMode;
	/** Discord user id of the founder. Required in production audit mode. */
	founderUserId: string;
	llmModel: string;
	/** Global confidence threshold (0..1). */
	threshold: number;
	/** Per-action-key threshold overrides. */
	perActionThreshold: Record<string, number>;
	windowHours: number;
	maxMsgs: number;
	cacheTtlSecs: number;
	failMode: FailMode;
	perActionFailMode: Record<string, FailMode>;
	/** Linear label that bypasses the LLM check when present on the issue. */
	autoApproveLabel?: string;
	bypassLabelFreshness: BypassLabelFreshness;
	/** Single-issue temporary env bypass (issue identifier, e.g. "FLY-175"). */
	bypassIssueId?: string;
	auditDbPath: string;
	debugEndpointMaxLimit: number;
	evaluatorVersion: string;
}

function parseFloatEnv(
	raw: string | undefined,
	fallback: number,
	name: string,
): number {
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseFloat(raw);
	if (Number.isNaN(n)) {
		throw new Error(`${name} must be a number, got "${raw}"`);
	}
	return n;
}

function parseIntEnv(
	raw: string | undefined,
	fallback: number,
	name: string,
): number {
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n)) {
		throw new Error(`${name} must be an integer, got "${raw}"`);
	}
	return n;
}

function parseJsonMap<T>(
	raw: string | undefined,
	name: string,
	validate: (v: unknown) => v is T,
): Record<string, T> {
	if (raw === undefined || raw === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`${name} must be valid JSON: ${(err as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${name} must be a JSON object (action → value map)`);
	}
	const out: Record<string, T> = {};
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		if (!validate(v)) {
			throw new Error(`${name}["${k}"] has an invalid value`);
		}
		out[k] = v;
	}
	return out;
}

/**
 * Parse the full founder-consent config from env.
 *
 * Production decision mode is always `audit_only`; other DecisionMode values
 * remain available only for directly injected module capability tests.
 */
export function parseFounderConsentConfig(
	env: NodeJS.ProcessEnv = process.env,
	warn: (msg: string) => void = (m) => console.warn(`[founder-consent] ${m}`),
): FounderConsentConfig {
	const decisionMode = resolveDecisionMode(env, warn);

	const auditDbPath =
		env.FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH?.trim() ||
		join(homedir(), ".flywheel", "audit.db");

	const canonicalFounderUserId = env.DISCORD_OWNER_USER_ID?.trim() ?? "";
	const founderUserIdOverride = env.FLYWHEEL_FOUNDER_USER_ID?.trim() ?? "";
	if (
		canonicalFounderUserId &&
		founderUserIdOverride &&
		canonicalFounderUserId !== founderUserIdOverride
	) {
		throw new Error(
			"Founder identity mismatch: DISCORD_OWNER_USER_ID does not match the configured founder identity; remove the founder override or set it to the same Discord user ID",
		);
	}
	// Canonical setup provisions DISCORD_OWNER_USER_ID. The override remains a
	// compatibility fallback for existing installs, never a competing identity.
	const founderUserId = canonicalFounderUserId || founderUserIdOverride;
	const llmModel =
		env.FLYWHEEL_FOUNDER_CONSENT_LLM_MODEL?.trim() ||
		"claude-haiku-4-5-20251001";

	const failModeRaw =
		env.FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE?.trim() || "closed";
	if (failModeRaw !== "closed" && failModeRaw !== "open") {
		throw new Error(
			`FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE must be closed|open, got "${failModeRaw}"`,
		);
	}
	const workflowReworkFailMode =
		env.FLYWHEEL_FOUNDER_CONSENT_WORKFLOW_REWORK_FAIL_MODE?.trim() || "closed";
	if (workflowReworkFailMode !== "closed") {
		throw new Error(
			"FLYWHEEL_FOUNDER_CONSENT_WORKFLOW_REWORK_FAIL_MODE must be closed",
		);
	}
	const perActionThreshold = parseJsonMap(
		env.FLYWHEEL_FOUNDER_CONSENT_THRESHOLD_PER_ACTION,
		"FLYWHEEL_FOUNDER_CONSENT_THRESHOLD_PER_ACTION",
		(v): v is number => typeof v === "number" && v >= 0 && v <= 1,
	);
	const workflowReworkThreshold = parseFloatEnv(
		env.FLYWHEEL_FOUNDER_CONSENT_WORKFLOW_REWORK_THRESHOLD,
		0.85,
		"FLYWHEEL_FOUNDER_CONSENT_WORKFLOW_REWORK_THRESHOLD",
	);
	if (workflowReworkThreshold < 0 || workflowReworkThreshold > 1) {
		throw new Error(
			"FLYWHEEL_FOUNDER_CONSENT_WORKFLOW_REWORK_THRESHOLD must be between 0 and 1",
		);
	}
	perActionThreshold.workflow_rework = workflowReworkThreshold;
	const perActionFailMode = parseJsonMap(
		env.FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE_PER_ACTION,
		"FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE_PER_ACTION",
		(v): v is FailMode => v === "closed" || v === "open",
	);
	if (perActionFailMode.workflow_rework === "open") {
		throw new Error(
			"workflow_rework founder consent fail mode must remain closed",
		);
	}
	perActionFailMode.workflow_rework = "closed";

	const freshnessRaw =
		env.FLYWHEEL_FOUNDER_CONSENT_BYPASS_LABEL_FRESHNESS?.trim() || "stored";
	if (freshnessRaw !== "stored" && freshnessRaw !== "linear_live") {
		throw new Error(
			`FLYWHEEL_FOUNDER_CONSENT_BYPASS_LABEL_FRESHNESS must be stored|linear_live, got "${freshnessRaw}"`,
		);
	}

	const config: FounderConsentConfig = {
		decisionMode,
		founderUserId,
		llmModel,
		threshold: parseFloatEnv(
			env.FLYWHEEL_FOUNDER_CONSENT_THRESHOLD,
			0.85,
			"FLYWHEEL_FOUNDER_CONSENT_THRESHOLD",
		),
		perActionThreshold,
		windowHours: parseIntEnv(
			env.FLYWHEEL_FOUNDER_CONSENT_WINDOW_HOURS,
			24,
			"FLYWHEEL_FOUNDER_CONSENT_WINDOW_HOURS",
		),
		maxMsgs: parseIntEnv(
			env.FLYWHEEL_FOUNDER_CONSENT_MAX_MSGS,
			50,
			"FLYWHEEL_FOUNDER_CONSENT_MAX_MSGS",
		),
		cacheTtlSecs: parseIntEnv(
			env.FLYWHEEL_FOUNDER_CONSENT_CACHE_TTL_SECS,
			60,
			"FLYWHEEL_FOUNDER_CONSENT_CACHE_TTL_SECS",
		),
		failMode: failModeRaw as FailMode,
		perActionFailMode,
		autoApproveLabel:
			env.FLYWHEEL_FOUNDER_CONSENT_BYPASS_LABEL?.trim() || undefined,
		bypassLabelFreshness: freshnessRaw as BypassLabelFreshness,
		bypassIssueId:
			env.FLYWHEEL_FOUNDER_CONSENT_BYPASS_ISSUE_ID?.trim() || undefined,
		auditDbPath,
		debugEndpointMaxLimit: parseIntEnv(
			env.FLYWHEEL_FOUNDER_CONSENT_DEBUG_ENDPOINT_MAX_LIMIT,
			50,
			"FLYWHEEL_FOUNDER_CONSENT_DEBUG_ENDPOINT_MAX_LIMIT",
		),
		evaluatorVersion: EVALUATOR_VERSION,
	};

	if (!config.founderUserId) {
		throw new Error("DISCORD_OWNER_USER_ID is required for founder consent");
	}

	return config;
}

/** Threshold for a given action key, falling back to the global threshold. */
export function thresholdForAction(
	config: FounderConsentConfig,
	action: string,
): number {
	return config.perActionThreshold[action] ?? config.threshold;
}

/** Fail mode for a given action key, falling back to the global fail mode. */
export function failModeForAction(
	config: FounderConsentConfig,
	action: string,
): FailMode {
	return config.perActionFailMode[action] ?? config.failMode;
}

/**
 * SHA-256 of the config block at decision time. Stored on each audit row so
 * Track 3 can segment the corpus by config regime, not just prompt regime.
 */
export function configHash(config: FounderConsentConfig): string {
	const stable = {
		decisionMode: config.decisionMode,
		llmModel: config.llmModel,
		threshold: config.threshold,
		perActionThreshold: config.perActionThreshold,
		windowHours: config.windowHours,
		maxMsgs: config.maxMsgs,
		cacheTtlSecs: config.cacheTtlSecs,
		failMode: config.failMode,
		perActionFailMode: config.perActionFailMode,
		autoApproveLabel: config.autoApproveLabel ?? null,
		bypassLabelFreshness: config.bypassLabelFreshness,
		evaluatorVersion: config.evaluatorVersion,
	};
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
