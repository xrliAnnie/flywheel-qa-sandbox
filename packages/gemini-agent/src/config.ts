/**
 * FLY-1018 env config (plan §2.7) — fail-closed parsing.
 *
 * All entries (CLI / daemon / delegate) load config through here; a
 * ConfigError maps to Terminal reason "config_error" at the entry shell.
 * The feature flag FLYWHEEL_GEMINI_AGENT is default-off: unset (or not
 * exactly "1") refuses to start.
 */

import os from "node:os";
import path from "node:path";

export class ConfigError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "ConfigError";
	}
}

/**
 * Pinned model ids — re-verified against ListModels on 2026-07-08
 * (FLY-883 lesson: never trust remembered model ids at build time).
 */
export const MODEL_IDS = {
	flash: "gemini-3.5-flash",
	pro: "gemini-3.1-pro-preview",
} as const;

export type ModelTier = keyof typeof MODEL_IDS;
export type Surface = "interactions" | "generate";

export interface AgentConfig {
	apiKey: string;
	modelTier: ModelTier;
	model: string;
	surface: Surface;
	maxSteps: number;
	tokenBudgetIn: number;
	tokenBudgetOut: number;
	toolTimeoutMs: number;
	resultCapChars: number;
	/** Base origin, trailing slash stripped. The ONLY allowed outbound origin. */
	bridgeUrl: string;
	bridgeToken: string;
	auditDir: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
	const val = env[key];
	if (val === undefined || val.trim() === "") {
		throw new ConfigError(`${key} is required (fail-closed)`);
	}
	return val.trim();
}

function positiveInt(env: Env, key: string, dflt: number): number {
	const raw = env[key];
	if (raw === undefined || raw.trim() === "") return dflt;
	const n = Number(raw.trim());
	if (!Number.isInteger(n) || n <= 0) {
		throw new ConfigError(`${key} must be a positive integer, got "${raw}"`);
	}
	return n;
}

export function loadAgentConfig(env: Env = process.env): AgentConfig {
	if (env.FLYWHEEL_GEMINI_AGENT !== "1") {
		throw new ConfigError(
			"FLYWHEEL_GEMINI_AGENT is not enabled (set FLYWHEEL_GEMINI_AGENT=1) — the agent is default-off",
		);
	}

	const apiKey = required(env, "GEMINI_API_KEY");
	const bridgeToken = required(env, "FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN");

	const rawUrl = required(env, "FLYWHEEL_BRIDGE_URL");
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new ConfigError(
			`FLYWHEEL_BRIDGE_URL is not a valid URL: "${rawUrl}"`,
		);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new ConfigError(
			`FLYWHEEL_BRIDGE_URL must be http(s), got "${parsed.protocol}"`,
		);
	}
	const bridgeUrl = rawUrl.replace(/\/+$/, "");

	const tierRaw = env.FLYWHEEL_GEMINI_AGENT_MODEL_TIER?.trim() || "flash";
	if (!(tierRaw in MODEL_IDS)) {
		throw new ConfigError(
			`FLYWHEEL_GEMINI_AGENT_MODEL_TIER must be one of: ${Object.keys(MODEL_IDS).join(", ")} — got "${tierRaw}"`,
		);
	}
	const modelTier = tierRaw as ModelTier;

	const surfaceRaw =
		env.FLYWHEEL_GEMINI_AGENT_SURFACE?.trim() || "interactions";
	if (surfaceRaw !== "interactions" && surfaceRaw !== "generate") {
		throw new ConfigError(
			`FLYWHEEL_GEMINI_AGENT_SURFACE must be "interactions" or "generate" — got "${surfaceRaw}"`,
		);
	}

	return {
		apiKey,
		modelTier,
		model: MODEL_IDS[modelTier],
		surface: surfaceRaw,
		maxSteps: positiveInt(env, "FLYWHEEL_GEMINI_AGENT_MAX_STEPS", 12),
		tokenBudgetIn: positiveInt(
			env,
			"FLYWHEEL_GEMINI_AGENT_TOKEN_BUDGET_IN",
			200_000,
		),
		tokenBudgetOut: positiveInt(
			env,
			"FLYWHEEL_GEMINI_AGENT_TOKEN_BUDGET_OUT",
			20_000,
		),
		toolTimeoutMs: positiveInt(
			env,
			"FLYWHEEL_GEMINI_AGENT_TOOL_TIMEOUT_MS",
			15_000,
		),
		resultCapChars: positiveInt(
			env,
			"FLYWHEEL_GEMINI_AGENT_RESULT_CAP_CHARS",
			16_000,
		),
		bridgeUrl,
		bridgeToken,
		auditDir:
			env.FLYWHEEL_GEMINI_AGENT_AUDIT_DIR?.trim() ||
			path.join(os.homedir(), ".flywheel", "gemini-agent"),
	};
}
