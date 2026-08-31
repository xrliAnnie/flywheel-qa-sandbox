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

/** FLY-546 VoiceRef — leads[].voice is a union in projects.json (bare
 * edge-tts id string, or { voiceId, rate?, pitch? }); voice-bridge
 * normalizes to the object form in ONE place so every consumer reads
 * .voiceId (a string-only guard would silently drop object-form voices
 * to DEFAULT_VOICE — 546 cross-issue review). */
export interface VoiceRef {
	voiceId: string;
	rate?: string;
	pitch?: string;
}

export interface HuddleBridgeLead {
	agentId: string;
	botTokenEnv: string;
	botToken: string;
	/** edge-tts voice (announce face / FLY-546), normalized; Gemini live
	 * voice is separate (geminiVoice). */
	voice?: VoiceRef;
	/** Gemini prebuilt voiceName for this Lead's Live session (A10 multi-session
	 * engine). Unset → deterministic assignment from the verified default list. */
	geminiVoice?: string;
	/** extra names that count as addressing this Lead in a founder transcript
	 * (AddressRouter); the Discord display name is always included at runtime. */
	aliases?: string[];
	/** the Lead's identity.md for the ask_lead read-only brain; missing at
	 * meeting time = the brain fails its turn loudly (never a silent persona). */
	identityFile?: string;
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
	/** FLY-1160 §4.1/§5: /glaw conversation engine. "gemini" (default, absent =
	 * current behavior) = Gemini Live thinks; "resident" = the resident Claude
	 * brain thinks (Gemini kept for audio/STT only). Only ever present when the
	 * founder explicitly opts in — absent keeps the resolved shape byte-compat. */
	mode?: "gemini" | "resident";
}

export interface HuddleBridgeConfig {
	projectName: string;
	projectRoot: string;
	guildId: string;
	/** the resident #huddle VC; its text area doubles as the TIV. */
	voiceChannelId: string;
	/** slash-command name (PRD R10; Annie-final ①: glaw = Gemini 耳 + Claude 脑). */
	commandName: string;
	moveMembers: boolean;
	orchestratorToken: string;
	/** the Note-taker (ears) bot token. */
	earsToken: string;
	leads: HuddleBridgeLead[];
	/** Bridge HTTP base (Linear proxy routes live there, key never here). */
	bridgeUrl: string;
	/** Bearer for the Bridge proxy routes (FLYWHEEL_API_TOKEN). */
	apiToken: string;
	/** the founder's Discord user id (@ping + MOVE_MEMBERS + lifecycle gates). */
	founderUserId: string;
	/** Gemini Live key — PR-2 fail-fast (the PR-1 residency only warned). */
	geminiApiKey: string;
	/** pinned Live model (FLY-968 C-cell: 2.5 hallucinated on the feed path). */
	geminiModel: string;
	/** claude binary for the read-only ask_lead brain. */
	claudeBin: string;
	/** ask_lead brain hard deadline. */
	brainTimeoutMs: number;
	/** pre-synthesized clips (optional — unset simply skips earcon/filler). */
	earconPath?: string;
	fillerPath?: string;
	/** sustained-speech threshold for barge-in (PRD §15). */
	backchannelMs: number;
	/** noise gate: min mean RMS over the barge-in window (QA R3; 0=off). */
	bargeInMinRms: number;
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

const DEFAULT_COMMAND = "glaw";
const DEFAULT_BACKCHANNEL_MS = 350;
const DEFAULT_BARGE_HOLDOFF_MS = 1000;
const DEFAULT_HEALTH_PORT = 9878;
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:9876";
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-live-preview";

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
			'voice-bridge: no project in projects.json has a "huddle" block — add huddle: { guildId, voiceChannelId, orchestratorBotTokenEnv, earsBotTokenEnv } to the project that should host /glaw',
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
		if (
			lead.aliases !== undefined &&
			(!Array.isArray(lead.aliases) ||
				lead.aliases.some((a) => typeof a !== "string"))
		) {
			throw new Error(
				`voice-bridge: lead "${agentId}" aliases must be an array of strings`,
			);
		}
		const voiceRef = normalizeVoiceRef(agentId, lead.voice);
		leads.push({
			agentId,
			botTokenEnv,
			botToken,
			...(voiceRef ? { voice: voiceRef } : {}),
			...(typeof lead.geminiVoice === "string" && lead.geminiVoice.length > 0
				? { geminiVoice: lead.geminiVoice }
				: {}),
			...(Array.isArray(lead.aliases) && lead.aliases.length > 0
				? { aliases: lead.aliases as string[] }
				: {}),
			...(typeof lead.identityFile === "string" && lead.identityFile.length > 0
				? { identityFile: lead.identityFile }
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
		if (b.mode !== undefined && b.mode !== "gemini" && b.mode !== "resident") {
			throw new Error(
				`voice-bridge: huddle.brain.mode must be "gemini" or "resident", got ${JSON.stringify(b.mode)}`,
			);
		}
		brain = {
			...(b.port !== undefined ? { port: b.port as number } : {}),
			model: (b.model as string | undefined) ?? DEFAULT_BRAIN_MODEL,
			maxSessions:
				(b.maxSessions as number | undefined) ?? DEFAULT_BRAIN_MAX_SESSIONS,
			// FLY-1190 (Annie 拍板): with a resident brain configured, /glaw thinks
			// with the resident Claude brain BY DEFAULT — Gemini is ears-only (STT).
			// An explicit mode:"gemini" keeps the old Gemini-thinks path. (Before
			// FLY-1190 the default was gemini and the STT-abort fix was gemini-only;
			// resident now carries that protection too — see fly1190-resident-stt-design.)
			mode: (b.mode as "gemini" | "resident" | undefined) ?? "resident",
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
		bargeInMinRms: nonNegativeNumericEnv(
			env,
			"FLYWHEEL_HUDDLE_BARGE_MIN_RMS",
			700,
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
		bridgeUrl: env.FLYWHEEL_BRIDGE_URL || DEFAULT_BRIDGE_URL,
		apiToken: requireTokenEnv(
			env,
			"FLYWHEEL_API_TOKEN",
			"the Bridge Linear proxy (kickoff issue / summary comment / issue lookup)",
		),
		founderUserId: requireTokenEnv(
			env,
			"DISCORD_OWNER_USER_ID",
			"the /glaw founder ping + MOVE_MEMBERS + lifecycle gating",
		),
		geminiApiKey: requireTokenEnv(
			env,
			"GEMINI_API_KEY",
			"the huddle conversation loop (PR-2 upgrades the PR-1 warning to fail-fast)",
		),
		geminiModel: env.FLYWHEEL_HUDDLE_GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
		claudeBin: env.FLYWHEEL_VOICE_CLAUDE_BIN || "claude",
		brainTimeoutMs: numericEnv(env, "FLYWHEEL_HUDDLE_BRAIN_TIMEOUT_MS", 30_000),
	};
}

/** the ONE union→object judgment (FLY-546 VoiceRef parity). Present-but-
 * invalid fails LOUD (same discipline as commandName/moveMembers). */
function normalizeVoiceRef(
	agentId: string,
	raw: unknown,
): VoiceRef | undefined {
	// only ABSENT is absent — teamlead rejects an explicit null, so must we
	// (accept/reject parity on the same projects.json, Codex R5).
	if (raw === undefined) return undefined;
	if (typeof raw === "string") {
		if (raw.length === 0) {
			throw new Error(
				`voice-bridge: lead "${agentId}" voice must be a non-empty string or { voiceId, rate?, pitch? }, got ""`,
			);
		}
		return { voiceId: raw };
	}
	if (typeof raw === "object" && !Array.isArray(raw)) {
		const { voiceId, rate, pitch } = raw as Record<string, unknown>;
		if (typeof voiceId !== "string" || voiceId.trim().length === 0) {
			throw new Error(
				`voice-bridge: lead "${agentId}" voice.voiceId must be a non-empty string, got ${JSON.stringify(voiceId)}`,
			);
		}
		// same grammar as the Bridge-side validator (546 parity): a typo fails
		// the daemon load, not a live announce.
		if (
			rate !== undefined &&
			!(typeof rate === "string" && /^[+-]\d+%$/.test(rate))
		) {
			throw new Error(
				`voice-bridge: lead "${agentId}" voice.rate must match ±N% (e.g. "-10%"), got ${JSON.stringify(rate)}`,
			);
		}
		if (
			pitch !== undefined &&
			!(typeof pitch === "string" && /^[+-]\d+Hz$/.test(pitch))
		) {
			throw new Error(
				`voice-bridge: lead "${agentId}" voice.pitch must match ±NHz (e.g. "+2Hz"), got ${JSON.stringify(pitch)}`,
			);
		}
		return {
			voiceId,
			...(typeof rate === "string" ? { rate } : {}),
			...(typeof pitch === "string" ? { pitch } : {}),
		};
	}
	throw new Error(
		`voice-bridge: lead "${agentId}" voice must be a non-empty string or { voiceId, rate?, pitch? }, got ${JSON.stringify(raw)}`,
	);
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

/** like numericEnv but 0 is a legal value (e.g. 0 = disable the noise gate). */
function nonNegativeNumericEnv(
	env: NodeJS.ProcessEnv,
	varName: string,
	fallback: number,
): number {
	const raw = env[varName];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		throw new Error(
			`voice-bridge: ${varName} must be a non-negative number, got ${JSON.stringify(raw)}`,
		);
	}
	return n;
}
