/**
 * Assistant-mode config (FLY-967) — the OPTIONAL `huddle.assistant` sub-block
 * of ~/.flywheel/projects.json. Absent = /live is OFF and FLY-545's /meet
 * behavior is byte-identical (the whole block is additive).
 *
 * Deliberately a SEPARATE resolver from 545's resolveHuddleBridgeConfig
 * (their chassis file stays untouched — parallel-work boundary); same
 * discipline though: fail fast with fix guidance, tokens only from env,
 * never argv/logs.
 */

export interface AssistantBriefingConfig {
	refreshSec: number;
	maxAgeSec: number;
	charBudget: number;
	docs: string[];
}

export interface AssistantModeConfig {
	/** slash-command name (Annie-final default: live; still configurable). */
	commandName: string;
	/** Gemini prebuilt voiceName; unset = model default (audition pick: Kore). */
	voice?: string;
	/** a dedicated assistant bot; null = the orchestrator bot speaks (D2). */
	assistantToken: string | null;
	briefing: AssistantBriefingConfig;
	/** §6 local pre-stop barge-in gate; default OFF pending full-chain S-A1. */
	localBargeIn: boolean;
}

const DEFAULT_COMMAND = "live";
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
			"voice-bridge: huddle.assistant must be an object (see FLY-967 plan §4) — remove the key to turn /live off",
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
	};
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
