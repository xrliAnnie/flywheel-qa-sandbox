/**
 * VoiceCoreConfig — component paths + tunables resolved from explicit overrides
 * then env (FLYWHEEL_VOICE_*) then defaults. No path hardcoded;
 * missing components fail-fast with install guidance (plan.md r2 §3). Round-1
 * carries no whisper/standalone-STT config (deferred).
 */
import { existsSync } from "node:fs";
import { VoiceError } from "./types.js";

export interface VoiceCoreConfig {
	/** announce face: edge-tts invocation, split so no default assumes a venv. */
	edgeTts: { command: string; args: string[] };
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
	defaultAnnounceBackendId: string;
	/** no converse backend is bundled (FLY-2860); empty unless configured. */
	defaultConverseBackendId: string;
	timeouts: { ttsMs: number; brainMs: number };
}

const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_TIMEOUTS = { ttsMs: 30_000, brainMs: 120_000 };

export type ConfigOverrides = Partial<
	Omit<VoiceCoreConfig, "edgeTts" | "timeouts">
> & {
	edgeTts?: Partial<VoiceCoreConfig["edgeTts"]>;
	timeouts?: Partial<VoiceCoreConfig["timeouts"]>;
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
		defaultAnnounceBackendId: pick(
			overrides.defaultAnnounceBackendId,
			env.FLYWHEEL_VOICE_ANNOUNCE_BACKEND,
			"edge-tts",
		),
		defaultConverseBackendId: pick(
			overrides.defaultConverseBackendId,
			env.FLYWHEEL_VOICE_CONVERSE_BACKEND,
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
