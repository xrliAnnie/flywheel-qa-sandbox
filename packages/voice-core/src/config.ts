/**
 * VoiceCoreConfig — component paths + tunables resolved from explicit overrides
 * then env (FLYWHEEL_VOICE_* / GEMINI_API_KEY) then defaults. No path hardcoded;
 * missing components fail-fast with install guidance (plan.md r2 §3). Round-1
 * carries no whisper/standalone-STT config (deferred).
 */
import { existsSync } from "node:fs";
import { VoiceError } from "./types.js";

export interface VoiceCoreConfig {
	/** announce face: edge-tts invocation, split so no default assumes a venv. */
	edgeTts: {
		command: string;
		args: string[];
		streamCommand: string;
		streamMaxBufferedBytes: number;
	};
	/** mp3 file playback (announce). */
	afplayBin: string;
	/** streaming PCM playback (converse). */
	ffplayBin: string;
	/** mic capture (converse). */
	ffmpegBin: string;
	/** mic capture device — avfoundation input spec (converse), e.g. ":default" / ":2". */
	micDevice: string;
	/** converse-face brain. */
	claudeBin: string;
	/** Lead identity.md; required only when the headless-claude brain is used. */
	identityFile: string;
	/** JSONL transcript output dir. */
	transcriptDir: string;
	/** default edge-tts voice id. */
	voice: string;
	/** converse backend (Gemini Live). */
	gemini: { model: string; apiKeyEnv: string };
	/** OpenAI Live converse backend (engine A). */
	openaiLive: {
		model: string;
		endpoint: string;
		apiKeyEnv: string;
		protocolVersion: 1;
		voice: string;
		delegation: "client";
	};
	defaultAnnounceBackendId: string;
	defaultConverseBackendId: string;
	timeouts: { ttsMs: number; brainMs: number };
}

const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_OPENAI_LIVE_MODEL = "gpt-live-1";
const DEFAULT_OPENAI_LIVE_ENDPOINT = "wss://api.openai.com/v1/live/sessions";
const DEFAULT_TIMEOUTS = { ttsMs: 30_000, brainMs: 120_000 };

export type ConfigOverrides = Partial<
	Omit<VoiceCoreConfig, "edgeTts" | "timeouts" | "gemini" | "openaiLive">
> & {
	edgeTts?: Partial<VoiceCoreConfig["edgeTts"]>;
	timeouts?: Partial<VoiceCoreConfig["timeouts"]>;
	gemini?: Partial<VoiceCoreConfig["gemini"]>;
	openaiLive?: Partial<VoiceCoreConfig["openaiLive"]>;
};

function pick(...vals: (string | undefined)[]): string {
	for (const v of vals) {
		if (v !== undefined && v !== "") return v;
	}
	return "";
}

function pickNum(...vals: (string | number | undefined)[]): number | undefined {
	for (const v of vals) {
		if (typeof v === "number") return v;
		if (typeof v === "string" && v !== "") {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	return undefined;
}

/** Merge order per field: override > env > default. Pure (no filesystem). */
export function resolveConfig(
	overrides: ConfigOverrides = {},
	env: NodeJS.ProcessEnv = process.env,
): VoiceCoreConfig {
	const edgeArgsEnv = env.FLYWHEEL_VOICE_EDGE_TTS_ARGS;
	return {
		edgeTts: {
			command: pick(
				overrides.edgeTts?.command,
				env.FLYWHEEL_VOICE_EDGE_TTS_CMD,
				"edge-tts",
			),
			args:
				overrides.edgeTts?.args ??
				(edgeArgsEnv ? edgeArgsEnv.split(" ").filter(Boolean) : []),
			streamCommand: pick(
				overrides.edgeTts?.streamCommand,
				env.FLYWHEEL_VOICE_EDGE_TTS_STREAM_CMD,
				"python3",
			),
			streamMaxBufferedBytes:
				pickNum(
					overrides.edgeTts?.streamMaxBufferedBytes,
					env.FLYWHEEL_VOICE_EDGE_TTS_STREAM_MAX_BYTES,
				) ?? 1024 * 1024,
		},
		afplayBin: pick(overrides.afplayBin, env.FLYWHEEL_VOICE_AFPLAY, "afplay"),
		ffplayBin: pick(overrides.ffplayBin, env.FLYWHEEL_VOICE_FFPLAY, "ffplay"),
		ffmpegBin: pick(overrides.ffmpegBin, env.FLYWHEEL_VOICE_FFMPEG, "ffmpeg"),
		micDevice: pick(
			overrides.micDevice,
			env.FLYWHEEL_VOICE_MIC_DEVICE,
			":default",
		),
		claudeBin: pick(
			overrides.claudeBin,
			env.FLYWHEEL_VOICE_CLAUDE_BIN,
			"claude",
		),
		identityFile: pick(overrides.identityFile, env.FLYWHEEL_VOICE_IDENTITY),
		transcriptDir: pick(
			overrides.transcriptDir,
			env.FLYWHEEL_VOICE_TRANSCRIPT_DIR,
			"./voice-transcripts",
		),
		voice: pick(overrides.voice, env.FLYWHEEL_VOICE_VOICE, DEFAULT_VOICE),
		gemini: {
			model: pick(
				overrides.gemini?.model,
				env.FLYWHEEL_VOICE_GEMINI_MODEL,
				DEFAULT_GEMINI_MODEL,
			),
			apiKeyEnv: pick(
				overrides.gemini?.apiKeyEnv,
				env.FLYWHEEL_VOICE_GEMINI_KEY_ENV,
				"GEMINI_API_KEY",
			),
		},
		openaiLive: {
			model: pick(
				overrides.openaiLive?.model,
				env.FLYWHEEL_VOICE_OPENAI_LIVE_MODEL,
				DEFAULT_OPENAI_LIVE_MODEL,
			),
			endpoint: pick(
				overrides.openaiLive?.endpoint,
				env.FLYWHEEL_VOICE_OPENAI_LIVE_ENDPOINT,
				DEFAULT_OPENAI_LIVE_ENDPOINT,
			),
			apiKeyEnv: pick(
				overrides.openaiLive?.apiKeyEnv,
				env.FLYWHEEL_VOICE_OPENAI_LIVE_KEY_ENV,
				"OPENAI_API_KEY",
			),
			protocolVersion: overrides.openaiLive?.protocolVersion ?? 1,
			voice: pick(
				overrides.openaiLive?.voice,
				env.FLYWHEEL_VOICE_OPENAI_LIVE_VOICE,
				"marin",
			),
			delegation: overrides.openaiLive?.delegation ?? "client",
		},
		defaultAnnounceBackendId: pick(
			overrides.defaultAnnounceBackendId,
			env.FLYWHEEL_VOICE_ANNOUNCE_BACKEND,
			"edge-tts",
		),
		defaultConverseBackendId: pick(
			overrides.defaultConverseBackendId,
			env.FLYWHEEL_VOICE_CONVERSE_BACKEND,
			"gemini-live",
		),
		timeouts: {
			ttsMs:
				pickNum(overrides.timeouts?.ttsMs, env.FLYWHEEL_VOICE_TTS_TIMEOUT_MS) ??
				DEFAULT_TIMEOUTS.ttsMs,
			brainMs:
				pickNum(
					overrides.timeouts?.brainMs,
					env.FLYWHEEL_VOICE_BRAIN_TIMEOUT_MS,
				) ?? DEFAULT_TIMEOUTS.brainMs,
		},
	};
}

/** announce face fail-fast: edge-tts command must be set (bare commands assumed on PATH). */
export function verifyAnnounceComponents(config: VoiceCoreConfig): void {
	if (!config.edgeTts.command) {
		throw new VoiceError(
			"component-missing",
			"edge-tts command not set (set FLYWHEEL_VOICE_EDGE_TTS_CMD, e.g. edge-tts or python with args -m edge_tts)",
		);
	}
	if (!config.edgeTts.streamCommand) {
		throw new VoiceError(
			"component-missing",
			"edge-tts streaming command not set (FLYWHEEL_VOICE_EDGE_TTS_STREAM_CMD)",
		);
	}
	if (
		!Number.isSafeInteger(config.edgeTts.streamMaxBufferedBytes) ||
		config.edgeTts.streamMaxBufferedBytes <= 0
	) {
		throw new VoiceError(
			"component-missing",
			"edge-tts streaming buffer limit must be a positive integer",
		);
	}
}

/** converse face fail-fast: GEMINI_API_KEY present + model pinned. */
export function verifyConverseComponents(
	config: VoiceCoreConfig,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!config.gemini.model) {
		throw new VoiceError(
			"component-missing",
			"Gemini model not set (FLYWHEEL_VOICE_GEMINI_MODEL)",
		);
	}
	if (!env[config.gemini.apiKeyEnv]) {
		throw new VoiceError(
			"component-missing",
			`${config.gemini.apiKeyEnv} not set — the converse (Gemini Live) face needs an API key`,
		);
	}
}

/** Engine A fail-fast admission: exact protocol plus a TLS OpenAI endpoint. */
export function verifyOpenAiLiveComponents(
	config: VoiceCoreConfig,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const unavailable = (detail: string): never => {
		throw new VoiceError("component-missing", `语音不可用: ${detail}`);
	};
	if (!config.openaiLive.model) unavailable("OpenAI Live model is not set");
	if (
		config.openaiLive.protocolVersion !== 1 ||
		config.openaiLive.delegation !== "client"
	) {
		unavailable("OpenAI Live protocol must be v1 with client delegation");
	}
	if (!config.openaiLive.voice) unavailable("OpenAI Live voice is not set");
	try {
		const endpoint = new URL(config.openaiLive.endpoint);
		if (
			endpoint.protocol !== "wss:" ||
			endpoint.hostname !== "api.openai.com" ||
			endpoint.username ||
			endpoint.password
		) {
			unavailable("OpenAI Live endpoint is outside the TLS allowlist");
		}
	} catch (error) {
		if (error instanceof VoiceError) throw error;
		unavailable("OpenAI Live endpoint is outside the TLS allowlist");
	}
	if (!env[config.openaiLive.apiKeyEnv]) {
		unavailable(`${config.openaiLive.apiKeyEnv} is not set`);
	}
}

/** required only when the headless-claude brain is used (converse face). */
export function verifyBrainComponents(
	config: VoiceCoreConfig,
	exists: (p: string) => boolean = existsSync,
): void {
	if (!config.identityFile) {
		throw new VoiceError(
			"component-missing",
			"Lead identity file not set (FLYWHEEL_VOICE_IDENTITY or --lead/--project) — the brain persona source",
		);
	}
	if (!exists(config.identityFile)) {
		throw new VoiceError(
			"component-missing",
			`identity file not found: ${config.identityFile}`,
		);
	}
}
