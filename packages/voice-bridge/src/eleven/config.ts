/**
 * /eleven mode config (FLY-1006 S7) — the OPTIONAL `huddle.eleven` sub-block
 * of ~/.flywheel/projects.json. Absent = /eleven is OFF and the daemon is
 * byte-identical to FLY-967 (the whole block is additive, mirroring
 * assistant/config.ts discipline: fail fast with fix guidance, secrets only
 * via env, never argv/logs).
 *
 * v1 运维诚实边界 (research §2.3): shim + tunnel + agent are session-front
 * assets started by the runbook, NOT by the daemon — the config only points
 * at them, and the command preflight fail-louds when any is missing.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** the SessionSlot mode key ElevenCommand (acquire) and ElevenSession
 * (release) must agree on. */
export const ELEVEN_SLOT_MODE = "eleven";

export interface ElevenModeConfig {
	/** slash-command name (default: eleven). */
	commandName: string;
	/** the ElevenLabs agent id (rebuilt per rig session; m1-rig.md runbook). */
	agentId: string;
	/** env var holding the xi-api-key (default ELEVENLABS_API_KEY). */
	apiKeyEnv: string;
	/** shim health probe (default http://127.0.0.1:8980/health). */
	shimHealthUrl: string;
	/** per-session voice override; unset = the agent's configured voice. */
	voiceId?: string;
	/** per-session persona prompt override (the Lead identity travels via the
	 * shim's system-prompt channel; this is the platform-side persona). */
	prompt?: string;
	/** pre-synthesized waiting-cue clip (M2 追加要求②); unset = cue off. */
	waitingCuePath?: string;
}

const DEFAULT_COMMAND = "eleven";
const DEFAULT_API_KEY_ENV = "ELEVENLABS_API_KEY";
const DEFAULT_SHIM_HEALTH = "http://127.0.0.1:8980/health";

/** resolve `huddle.eleven` from the raw projects.json array; null = off. */
export function resolveElevenConfig(
	rawProjects: unknown,
	env: NodeJS.ProcessEnv,
): ElevenModeConfig | null {
	if (!Array.isArray(rawProjects)) return null;
	const entry = (rawProjects as Record<string, unknown>[]).find(
		(p) =>
			p?.huddle != null && (p.huddle as Record<string, unknown>).eleven != null,
	);
	if (!entry) return null;
	const e = (entry.huddle as Record<string, unknown>).eleven as Record<
		string,
		unknown
	>;
	if (typeof e !== "object" || Array.isArray(e)) {
		throw new Error(
			"voice-bridge: huddle.eleven must be an object — remove the key to turn /eleven off",
		);
	}
	const agentId = optString(e, "agentId");
	if (!agentId) {
		throw new Error(
			"voice-bridge: huddle.eleven.agentId is required — rebuild the agent per engineering/doc/FLY-1006-eleven-product-e2e/evidence/m1-rig.md and paste its id",
		);
	}
	const apiKeyEnv = optString(e, "apiKeyEnv") ?? DEFAULT_API_KEY_ENV;
	if (!env[apiKeyEnv]) {
		throw new Error(
			`voice-bridge: env ${apiKeyEnv} is not set — /eleven cannot mint signed URLs (add it to ~/.flywheel/.env)`,
		);
	}
	return {
		commandName: optString(e, "commandName") ?? DEFAULT_COMMAND,
		agentId,
		apiKeyEnv,
		shimHealthUrl: optString(e, "shimHealthUrl") ?? DEFAULT_SHIM_HEALTH,
		voiceId: optString(e, "voiceId"),
		prompt: optString(e, "prompt"),
		waitingCuePath: optString(e, "waitingCuePath"),
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
			`voice-bridge: huddle.eleven.${key} must be a non-empty string when set`,
		);
	}
	return v.trim();
}

/** file-reading wrapper (mirrors loadAssistantConfig's source of truth). */
export function loadElevenConfig(
	opts: { path?: string; env?: NodeJS.ProcessEnv } = {},
): ElevenModeConfig | null {
	const path = opts.path ?? join(homedir(), ".flywheel", "projects.json");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
	return resolveElevenConfig(raw, opts.env ?? process.env);
}
