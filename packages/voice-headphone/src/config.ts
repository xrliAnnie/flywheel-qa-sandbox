/**
 * Headphone daemon config (FLY-546 B2-1) — `~/.flywheel/headphone.json`.
 *
 * Fail-fast philosophy (voice-core config.ts style): a missing/misshapen
 * field aborts startup with setup guidance — the daemon must never run
 * half-configured (it holds a bot token and can write founder approvals).
 *
 * The message SCOPE (lead bot ids, channels, founder fingerprint) is NOT
 * configured here — it comes from the Bridge scope contract
 * (`GET /api/voice/scope`), so the daemon never guesses it ad hoc.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VoiceSpec } from "flywheel-voice-core";

export type HeadphoneConfig = {
	botTokenEnv: string;
	/** resolved at load; never serialized back. */
	botToken: string;
	coreChannelId: string;
	founderUserId: string;
	includeRoundtable: boolean;
	bridgeUrl: string;
	bridgeTokenEnv?: string;
	bridgeToken?: string;
	stateFile: string;
	/** explicit per-agent voice overrides (pre-audition finalization). */
	voices?: Record<string, VoiceSpec>;
	/** word-set overrides for the turn machine vocabulary. */
	phrases?: Partial<{
		stop: string[];
		skip: string[];
		reply: string[];
		confirm: string[];
		deny: string[];
		approveIntent: string[];
		pause: string[];
	}>;
};

const SETUP_HINT =
	'headphone.json setup: {"botTokenEnv":"HEADPHONE_BOT_TOKEN","coreChannelId":"<#flywheel-core id>","founderUserId":"<Annie discord id>","bridgeUrl":"http://localhost:9876","bridgeTokenEnv":"FLYWHEEL_BRIDGE_TOKEN"}';

const RATE_RE = /^[+-]\d+%$/;
const PITCH_RE = /^[+-]\d+Hz$/;

function requireString(obj: Record<string, unknown>, field: string): string {
	const v = obj[field];
	if (typeof v !== "string" || v.trim().length === 0) {
		throw new Error(
			`headphone config: "${field}" must be a non-empty string. ${SETUP_HINT}`,
		);
	}
	return v;
}

export function loadHeadphoneConfig(opts: {
	configPath?: string;
	env: Record<string, string | undefined>;
}): HeadphoneConfig {
	const configPath =
		opts.configPath ??
		opts.env.FLYWHEEL_HEADPHONE_CONFIG ??
		join(homedir(), ".flywheel", "headphone.json");
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (err) {
		throw new Error(
			`headphone config: cannot read ${configPath} (create ~/.flywheel/headphone.json first). ${SETUP_HINT}`,
			{ cause: err },
		);
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		throw new Error(
			`headphone config: ${configPath} is not valid JSON. ${SETUP_HINT}`,
			{ cause: err },
		);
	}

	const botTokenEnv = requireString(parsed, "botTokenEnv");
	const coreChannelId = requireString(parsed, "coreChannelId");
	const founderUserId = requireString(parsed, "founderUserId");
	const bridgeUrl = requireString(parsed, "bridgeUrl");

	const botToken = opts.env[botTokenEnv];
	if (!botToken) {
		throw new Error(
			`headphone config: env var ${botTokenEnv} (the daemon's Discord bot token) is not set — the daemon cannot run without its own bot.`,
		);
	}

	const bridgeTokenEnv = requireString(parsed, "bridgeTokenEnv");
	const bridgeToken = opts.env[bridgeTokenEnv];
	if (!bridgeToken) {
		throw new Error(
			`headphone config: env var ${bridgeTokenEnv} (Bridge apiToken) is not set.`,
		);
	}

	const voices = parsed.voices as Record<string, VoiceSpec> | undefined;
	if (voices !== undefined) {
		if (
			typeof voices !== "object" ||
			voices === null ||
			Array.isArray(voices)
		) {
			throw new Error("headphone config: voices must be an object map.");
		}
		for (const [agentId, spec] of Object.entries(voices)) {
			if (
				typeof spec !== "object" ||
				spec === null ||
				typeof spec.voiceId !== "string" ||
				spec.voiceId.trim().length === 0
			) {
				throw new Error(
					`headphone config: voices["${agentId}"].voiceId must be a non-empty string.`,
				);
			}
			if (spec.rate !== undefined && !RATE_RE.test(spec.rate)) {
				throw new Error(
					`headphone config: voices["${agentId}"].rate must match ±N% (e.g. "-10%").`,
				);
			}
			if (spec.pitch !== undefined && !PITCH_RE.test(spec.pitch)) {
				throw new Error(
					`headphone config: voices["${agentId}"].pitch must match ±NHz (e.g. "+2Hz").`,
				);
			}
		}
	}

	const includeRoundtable = parsed.includeRoundtable === true;

	return {
		botTokenEnv,
		botToken,
		coreChannelId,
		founderUserId,
		includeRoundtable,
		bridgeUrl,
		bridgeTokenEnv,
		bridgeToken,
		stateFile:
			opts.env.FLYWHEEL_HEADPHONE_STATE_FILE ??
			(typeof parsed.stateFile === "string" && parsed.stateFile.length > 0
				? parsed.stateFile
				: join(homedir(), ".flywheel", "headphone-state.json")),
		voices,
		phrases: parsed.phrases as HeadphoneConfig["phrases"],
	};
}
