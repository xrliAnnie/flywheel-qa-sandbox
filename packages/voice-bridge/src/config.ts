/**
 * HuddleBridgeConfig — the voice-bridge daemon's fail-fast config resolver
 * (FLY-545 P2).
 *
 * Source of truth = ~/.flywheel/projects.json (the SAME file the Bridge
 * loads; teamlead's ProjectConfig validates the huddle shape on the Bridge
 * side, but voice-bridge deliberately does NOT import the teamlead package —
 * it re-reads only the fields it needs and fails fast with fix guidance,
 * because a launchd crash loop gets debugged from one log line).
 *
 * Secrets: every token is resolved from env (sourced from ~/.flywheel/.env
 * by the wrapper) and NEVER appears in argv or logs.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HuddleBridgeLead {
	agentId: string;
	botTokenEnv: string;
	botToken: string;
	/** edge-tts voice id (announce face / FLY-546); Gemini live voice is separate. */
	voice?: string;
	chatChannel?: string;
}

/**
 * FLY-1160: resident brain face. The token env name is HARD-PINNED to
 * FLYWHEEL_BRAIN_PORT_TOKEN and deliberately NOT configurable (Codex R2 #4b —
 * a configurable tokenEnv lets daemon and shim read different secrets). The
 * BrainPort listens only when `port` is set AND that env var has a value.
 */
export interface HuddleBrainConfig {
	/** loopback BrainPort port; unset = the port server never starts. */
	port?: number;
	/** resident claude model (founder knob; FLY-980 data: sonnet > haiku > opus). */
	model: string;
	/** global resident-session hard cap. */
	maxSessions: number;
}

export interface HuddleBridgeConfig {
	projectName: string;
	projectRoot: string;
	guildId: string;
	/** the resident #huddle VC; its text area doubles as the TIV. */
	voiceChannelId: string;
	/** slash-command name (PRD R10; Annie-final default: meet). */
	commandName: string;
	moveMembers: boolean;
	orchestratorToken: string;
	/** the Note-taker (ears) bot token. */
	earsToken: string;
	leads: HuddleBridgeLead[];
	/** sustained-speech threshold for barge-in (PRD §15). */
	backchannelMs: number;
	/** continuous-silence duration ending an utterance — one barge-in per
	 * utterance (QA FLY-1006 R3 ①). */
	bargeInHoldoffMs: number;
	/** QA test-injection: non-human user ids the Note-taker may subscribe. */
	allowUserIds: string[];
	healthPort: number;
	/** playback stack preflight target (mp3→opus transcode runs through it). */
	ffmpegBin: string;
	/** FLY-1160 resident brain; absent = feature fully off (byte-compat). */
	brain?: HuddleBrainConfig;
}

const DEFAULT_BRAIN_MODEL = "sonnet";
const DEFAULT_BRAIN_MAX_SESSIONS = 4;

const DEFAULT_COMMAND = "meet";
const DEFAULT_BACKCHANNEL_MS = 350;
const DEFAULT_BARGE_HOLDOFF_MS = 1000;
const DEFAULT_HEALTH_PORT = 9878;

export function loadHuddleBridgeConfig(
	opts: { path?: string; env?: NodeJS.ProcessEnv } = {},
): HuddleBridgeConfig {
	const path = opts.path ?? join(homedir(), ".flywheel", "projects.json");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		throw new Error(
			`voice-bridge: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
	return resolveHuddleBridgeConfig(raw, opts.env ?? process.env);
}

/** Pure resolver (fs-free) — the unit-testable core. */
export function resolveHuddleBridgeConfig(
	rawProjects: unknown,
	env: NodeJS.ProcessEnv,
): HuddleBridgeConfig {
	if (!Array.isArray(rawProjects)) {
		throw new Error(
			"voice-bridge: projects.json must be a JSON array of project entries",
		);
	}
	const entries = rawProjects as Record<string, unknown>[];
	const withHuddle = entries.filter((p) => p?.huddle != null);
	if (withHuddle.length === 0) {
		throw new Error(
			'voice-bridge: no project in projects.json has a "huddle" block — add huddle: { guildId, voiceChannelId, orchestratorBotTokenEnv, earsBotTokenEnv } to the project that should host /meet',
		);
	}
	if (withHuddle.length > 1) {
		throw new Error(
			`voice-bridge: v1 supports exactly ONE huddle project, found ${withHuddle.length}: ${withHuddle
				.map((p) => String(p.projectName))
				.join(", ")} — remove the extra huddle blocks`,
		);
	}
	const entry = withHuddle[0] as Record<string, unknown>;
	const huddle = entry.huddle as Record<string, unknown>;

	for (const field of [
		"guildId",
		"voiceChannelId",
		"orchestratorBotTokenEnv",
		"earsBotTokenEnv",
	] as const) {
		if (typeof huddle[field] !== "string" || huddle[field].length === 0) {
			throw new Error(
				`voice-bridge: project "${String(entry.projectName)}" huddle.${field} must be a non-empty string`,
			);
		}
	}

	const orchestratorToken = requireTokenEnv(
		env,
		huddle.orchestratorBotTokenEnv as string,
		"the orchestrator bot",
	);
	const earsToken = requireTokenEnv(
		env,
		huddle.earsBotTokenEnv as string,
		"the Note-taker (ears) bot",
	);

	const rawLeads = Array.isArray(entry.leads)
		? (entry.leads as Record<string, unknown>[])
		: [];
	const leads: HuddleBridgeLead[] = [];
	for (const lead of rawLeads) {
		const agentId = String(lead.agentId ?? "");
		const botTokenEnv = lead.botTokenEnv;
		if (typeof botTokenEnv !== "string" || botTokenEnv.length === 0) continue;
		const botToken = env[botTokenEnv];
		if (!botToken) {
			throw new Error(
				`voice-bridge: lead "${agentId}" declares botTokenEnv="${botTokenEnv}" but the env var is unset — add it to ~/.flywheel/.env (the wrapper sources it)`,
			);
		}
		leads.push({
			agentId,
			botTokenEnv,
			botToken,
			...(typeof lead.voice === "string" && lead.voice.length > 0
				? { voice: lead.voice }
				: {}),
			...(typeof lead.chatChannel === "string" && lead.chatChannel.length > 0
				? { chatChannel: lead.chatChannel }
				: {}),
		});
	}
	if (leads.length === 0) {
		throw new Error(
			`voice-bridge: project "${String(entry.projectName)}" has no lead with a botTokenEnv — huddle needs at least one Lead bot to speak through`,
		);
	}

	// Optional fields fail LOUD when present-but-invalid (Codex R1 MEDIUM:
	// voice-bridge reads projects.json itself — a typo like moveMembers:"false"
	// must not silently become the default).
	if (huddle.commandName !== undefined) {
		if (
			typeof huddle.commandName !== "string" ||
			!/^[a-z0-9_-]{1,32}$/.test(huddle.commandName)
		) {
			throw new Error(
				`voice-bridge: huddle.commandName must match ^[a-z0-9_-]{1,32}$ (Discord slash-command grammar), got ${JSON.stringify(huddle.commandName)}`,
			);
		}
	}
	if (
		huddle.moveMembers !== undefined &&
		typeof huddle.moveMembers !== "boolean"
	) {
		throw new Error(
			`voice-bridge: huddle.moveMembers must be a boolean, got ${JSON.stringify(huddle.moveMembers)}`,
		);
	}

	// FLY-1160 resident brain block — present-but-invalid fails LOUD.
	let brain: HuddleBrainConfig | undefined;
	if (huddle.brain !== undefined) {
		if (
			typeof huddle.brain !== "object" ||
			huddle.brain === null ||
			Array.isArray(huddle.brain)
		) {
			throw new Error(
				`voice-bridge: huddle.brain must be an object, got ${JSON.stringify(huddle.brain)}`,
			);
		}
		const b = huddle.brain as Record<string, unknown>;
		if (
			b.port !== undefined &&
			(typeof b.port !== "number" || !Number.isInteger(b.port) || b.port <= 0)
		) {
			throw new Error(
				`voice-bridge: huddle.brain.port must be a positive integer, got ${JSON.stringify(b.port)}`,
			);
		}
		if (
			b.model !== undefined &&
			(typeof b.model !== "string" || b.model.length === 0)
		) {
			throw new Error(
				`voice-bridge: huddle.brain.model must be a non-empty string, got ${JSON.stringify(b.model)}`,
			);
		}
		if (
			b.maxSessions !== undefined &&
			(typeof b.maxSessions !== "number" ||
				!Number.isInteger(b.maxSessions) ||
				b.maxSessions <= 0)
		) {
			throw new Error(
				`voice-bridge: huddle.brain.maxSessions must be a positive integer, got ${JSON.stringify(b.maxSessions)}`,
			);
		}
		brain = {
			...(b.port !== undefined ? { port: b.port as number } : {}),
			model: (b.model as string | undefined) ?? DEFAULT_BRAIN_MODEL,
			maxSessions:
				(b.maxSessions as number | undefined) ?? DEFAULT_BRAIN_MAX_SESSIONS,
		};
	}

	return {
		projectName: String(entry.projectName),
		projectRoot: String(entry.projectRoot),
		guildId: huddle.guildId as string,
		voiceChannelId: huddle.voiceChannelId as string,
		commandName: (huddle.commandName as string | undefined) ?? DEFAULT_COMMAND,
		moveMembers: (huddle.moveMembers as boolean | undefined) ?? true,
		orchestratorToken,
		earsToken,
		leads,
		backchannelMs: numericEnv(
			env,
			"FLYWHEEL_HUDDLE_BACKCHANNEL_MS",
			DEFAULT_BACKCHANNEL_MS,
		),
		bargeInHoldoffMs: numericEnv(
			env,
			"FLYWHEEL_HUDDLE_BARGE_HOLDOFF_MS",
			DEFAULT_BARGE_HOLDOFF_MS,
		),
		allowUserIds: (env.FLYWHEEL_HUDDLE_ALLOW_USER_IDS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		healthPort: numericEnv(
			env,
			"FLYWHEEL_VOICE_BRIDGE_HEALTH_PORT",
			DEFAULT_HEALTH_PORT,
		),
		ffmpegBin: env.FLYWHEEL_VOICE_FFMPEG || "ffmpeg",
		...(brain ? { brain } : {}),
	};
}

function requireTokenEnv(
	env: NodeJS.ProcessEnv,
	varName: string,
	what: string,
): string {
	const value = env[varName];
	if (!value) {
		throw new Error(
			`voice-bridge: ${varName} is unset — ${what} cannot login. Add ${varName}=<bot token> to ~/.flywheel/.env (the wrapper sources it)`,
		);
	}
	return value;
}

function numericEnv(
	env: NodeJS.ProcessEnv,
	varName: string,
	fallback: number,
): number {
	const raw = env[varName];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(
			`voice-bridge: ${varName} must be a positive number, got ${JSON.stringify(raw)}`,
		);
	}
	return n;
}
