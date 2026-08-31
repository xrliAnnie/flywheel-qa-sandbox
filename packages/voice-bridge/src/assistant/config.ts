/**
 * Assistant-mode config (FLY-967) — the OPTIONAL `huddle.assistant` sub-block
 * of ~/.flywheel/projects.json. Absent = /gemini is OFF and FLY-545's /meet
 * behavior is byte-identical (the whole block is additive).
 *
 * Deliberately a SEPARATE resolver from 545's resolveHuddleBridgeConfig
 * (their chassis file stays untouched — parallel-work boundary); same
 * discipline though: fail fast with fix guidance, tokens only from env,
 * never argv/logs.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantAdvancedConfig } from "./advanced.js";

export interface AssistantBriefingConfig {
	refreshSec: number;
	maxAgeSec: number;
	charBudget: number;
	docs: string[];
}

export interface AssistantModeConfig {
	/** slash-command name (Annie-final default: gemini; still configurable). */
	commandName: string;
	/** Gemini prebuilt voiceName; unset = model default (audition pick: Kore). */
	voice?: string;
	/** a dedicated assistant bot; null = the orchestrator bot speaks (D2). */
	assistantToken: string | null;
	briefing: AssistantBriefingConfig;
	/** §6 local pre-stop barge-in gate; default OFF pending full-chain S-A1. */
	localBargeIn: boolean;
	/** FLY-967 round-5 (Annie's call): server-VAD voice barge-in. Default ON —
	 * she can cut the assistant off by speaking (headphone users). Set false
	 * for SPEAKER users: the mic echoes the assistant's own audio back and
	 * server VAD misjudges it as an interruption, cancelling every reply.
	 * Optional so hand-constructed configs (runVoiceBridge callers, e2e rigs)
	 * stay compatible; unset = ON everywhere downstream (Codex R21). */
	bargeIn?: boolean;
	/** FLY-1065: per-turn transcript captions in the TIV channel. Default ON;
	 * false = captions degrade to the daemon log (the 967 v1 behavior — the
	 * one-key escape hatch if the rendering misbehaves). Optional for
	 * hand-constructed configs; downstream treats `!== false` as ON. */
	captions?: boolean;
	/** FLY-1018 voice phase: mounts the delegate_task deep-dispatch tool
	 * (/gemini-advanced). Absent = the assistant stays byte-identical. */
	advanced?: AssistantAdvancedConfig;
}

const DEFAULT_COMMAND = "gemini";
/** FLY-1159 founder contract (2026-07-11): the delegate's own voice command. */
export const DEFAULT_ADVANCED_COMMAND = "gemini-advanced";

/** the SessionSlot mode key both GeminiCommand (acquire) and
 * AssistantSession (release) must agree on. */
export const ASSISTANT_SLOT_MODE = "gemini";
const DEFAULT_REFRESH_SEC = 600;
const DEFAULT_MAX_AGE_SEC = 1800;
const DEFAULT_CHAR_BUDGET = 8000;

/**
 * Resolve the assistant sub-block from the raw projects.json array.
 * Returns null when no project declares `huddle.assistant` (feature off).
 */
export function resolveAssistantConfig(
	rawProjects: unknown,
	env: NodeJS.ProcessEnv,
): AssistantModeConfig | null {
	if (!Array.isArray(rawProjects)) return null;
	const entry = (rawProjects as Record<string, unknown>[]).find(
		(p) =>
			p?.huddle != null &&
			(p.huddle as Record<string, unknown>).assistant != null,
	);
	if (!entry) return null;
	const a = (entry.huddle as Record<string, unknown>).assistant as Record<
		string,
		unknown
	>;
	if (typeof a !== "object") {
		throw new Error(
			"voice-bridge: huddle.assistant must be an object (see FLY-967 plan §4) — remove the key to turn /gemini off",
		);
	}

	const commandName = optString(a, "commandName") ?? DEFAULT_COMMAND;
	const voice = optString(a, "voice");

	let assistantToken: string | null = null;
	if (a.assistantBotTokenEnv != null) {
		const tokenEnv = a.assistantBotTokenEnv;
		if (typeof tokenEnv !== "string" || !tokenEnv.trim()) {
			throw new Error(
				"voice-bridge: huddle.assistant.assistantBotTokenEnv must be a non-empty env-var name (or omitted for the orchestrator bot to speak)",
			);
		}
		const token = env[tokenEnv];
		if (!token) {
			throw new Error(
				`voice-bridge: env ${tokenEnv} is not set — add it to ~/.flywheel/.env or drop assistantBotTokenEnv`,
			);
		}
		assistantToken = token;
	}

	const b = (a.briefing ?? {}) as Record<string, unknown>;
	if (typeof b !== "object" || Array.isArray(b)) {
		throw new Error(
			"voice-bridge: huddle.assistant.briefing must be an object",
		);
	}
	const docsRaw = b.docs ?? [];
	if (
		!Array.isArray(docsRaw) ||
		!docsRaw.every((d) => typeof d === "string" && d.trim())
	) {
		throw new Error(
			"voice-bridge: huddle.assistant.briefing.docs must be an array of non-empty repo-relative paths",
		);
	}

	if (a.advanced != null) {
		throw new Error(
			"voice-bridge: huddle.assistant.advanced was retired by FLY-2105; remove huddle.assistant.advanced",
		);
	}

	return {
		commandName,
		voice,
		assistantToken,
		briefing: {
			refreshSec: optPositive(b, "refreshSec") ?? DEFAULT_REFRESH_SEC,
			maxAgeSec: optPositive(b, "maxAgeSec") ?? DEFAULT_MAX_AGE_SEC,
			charBudget: optPositive(b, "charBudget") ?? DEFAULT_CHAR_BUDGET,
			docs: docsRaw as string[],
		},
		localBargeIn: a.localBargeIn === true,
		bargeIn: optBoolean(a, "bargeIn") ?? true,
		captions: optBoolean(a, "captions") ?? true,
	};
}

/** a truthy STRING like "false" silently meaning ON is exactly the failure
 * this switch protects speaker users from — non-boolean fails fast (R21). */
function optBoolean(
	o: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const v = o[key];
	if (v == null) return undefined;
	if (typeof v !== "boolean") {
		throw new Error(
			`voice-bridge: huddle.assistant.${key} must be true or false when set (got ${JSON.stringify(v)})`,
		);
	}
	return v;
}

function optString(
	o: Record<string, unknown>,
	key: string,
): string | undefined {
	const v = o[key];
	if (v == null) return undefined;
	if (typeof v !== "string" || !v.trim()) {
		throw new Error(
			`voice-bridge: huddle.assistant.${key} must be a non-empty string when set`,
		);
	}
	return v.trim();
}

function optPositive(
	o: Record<string, unknown>,
	key: string,
): number | undefined {
	const v = o[key];
	if (v == null) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
		throw new Error(
			`voice-bridge: huddle.assistant.briefing.${key} must be a positive number when set`,
		);
	}
	return v;
}

/** file-reading wrapper (mirrors loadHuddleBridgeConfig's source of truth). */
export function loadAssistantConfig(
	opts: { path?: string; env?: NodeJS.ProcessEnv } = {},
): AssistantModeConfig | null {
	const path = opts.path ?? join(homedir(), ".flywheel", "projects.json");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// unreadable projects.json already fail-fasts in loadHuddleBridgeConfig;
		// the assistant block simply resolves to OFF here.
		return null;
	}
	return resolveAssistantConfig(raw, opts.env ?? process.env);
}
