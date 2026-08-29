/**
 * FLY-175 Track 2 — Founder Consent Hard Gate: configuration.
 *
 * Parses the `FLYWHEEL_FOUNDER_CONSENT_*` env knobs into a typed config.
 *
 * Critical invariant (plan §8.1): when `decisionMode === "off"` (the
 * default), the parser MUST NOT require `FLYWHEEL_FOUNDER_USER_ID` /
 * `FLYWHEEL_FOUNDER_CONSENT_LLM_MODEL` etc. The evaluator is simply not
 * constructed in that case and Bridge boots in pre-Track-2 behavior
 * byte-for-byte. Only when `decisionMode !== "off"` does the parser
 * validate required fields and fail-fast on missing ones.
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
	/** Discord user id of the founder. Required when decisionMode !== "off". */
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
 * Returns a config whose `decisionMode` may be "off". Callers MUST skip
 * evaluator construction when `decisionMode === "off"`. Required-field
 * validation only runs when mode !== "off".
 */
export function parseFounderConsentConfig(
	env: NodeJS.ProcessEnv = process.env,
	warn: (msg: string) => void = (m) => console.warn(`[founder-consent] ${m}`),
): FounderConsentConfig {
	const decisionMode = resolveDecisionMode(env, warn);

	const auditDbPath =
		env.FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH?.trim() ||
		join(homedir(), ".flywheel", "audit.db");

	const founderUserId = env.FLYWHEEL_FOUNDER_USER_ID?.trim() ?? "";
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
		perActionThreshold: parseJsonMap(
			env.FLYWHEEL_FOUNDER_CONSENT_THRESHOLD_PER_ACTION,
			"FLYWHEEL_FOUNDER_CONSENT_THRESHOLD_PER_ACTION",
			(v): v is number => typeof v === "number" && v >= 0 && v <= 1,
		),
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
		perActionFailMode: parseJsonMap(
			env.FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE_PER_ACTION,
			"FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE_PER_ACTION",
			(v): v is FailMode => v === "closed" || v === "open",
		),
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

	// Required-field validation ONLY when enforcement is live.
	if (decisionMode !== "off") {
		if (!config.founderUserId) {
			throw new Error(
				"FLYWHEEL_FOUNDER_USER_ID is required when FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE != off",
			);
		}
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
