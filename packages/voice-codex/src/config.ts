import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface VoiceProjectRow {
	projectName: string;
	huddle?: {
		guildId: string;
		voiceChannelId: string;
		orchestratorBotTokenEnv: string;
	} | null;
}

export interface VoiceDaemonConfig {
	apiToken: string;
	bridgeUrl: string;
	voiceRoot: string;
	codexHome: string;
	codexBin: string;
	commCliPath: string;
	projectsPath: string;
	leaseHttpTimeoutMs: number;
	idlePollMs: number;
	leaseRenewMs: number;
	leaseMissMax: number;
	presenceGraceMs: number;
	speechChunkTokens: number;
	confirmationMs: number;
	discordTimeoutMs: number;
	mirrorRetries: number;
	mirrorRetryWindowMs: number;
	ingestRetries: number;
	deliveryRetryMs: number;
}

function integer(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	fallback: number,
): number {
	const value = Number(env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

const VOICE_CODEX_ENV_NAMES = [
	"HOME",
	"PATH",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"TERM",
	"COLORTERM",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

export function voiceCodexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		VOICE_CODEX_ENV_NAMES.flatMap((name) =>
			env[name] === undefined ? [] : [[name, env[name]]],
		),
	);
}

export function loadVoiceDaemonConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
	homeDir: string,
): VoiceDaemonConfig {
	const apiToken = env.TEAMLEAD_API_TOKEN?.trim();
	if (!apiToken) throw new Error("TEAMLEAD_API_TOKEN is required");
	const flywheelDir = env.FLYWHEEL_DIR ?? join(homeDir, "Dev", "flywheel");
	const stateDir = env.FLYWHEEL_STATE_DIR ?? join(homeDir, ".flywheel");
	const voiceRoot = env.FLYWHEEL_VOICE_STATE_DIR ?? join(stateDir, "voice");
	const leaseTtlMs = integer(env, "FLYWHEEL_VOICE_LEASE_TTL_MS", 15_000);
	const leaseRenewMs = integer(env, "FLYWHEEL_VOICE_LEASE_RENEW_MS", 4_000);
	const leaseHttpTimeoutMs = integer(
		env,
		"FLYWHEEL_VOICE_LEASE_HTTP_TIMEOUT_MS",
		2_000,
	);
	if (leaseRenewMs + leaseHttpTimeoutMs >= leaseTtlMs / 2) {
		throw new Error(
			"voice lease renew plus HTTP timeout must be less than half the lease TTL",
		);
	}
	return {
		apiToken,
		bridgeUrl: env.BRIDGE_URL ?? "http://127.0.0.1:9876",
		voiceRoot,
		codexHome: env.FLYWHEEL_VOICE_CODEX_HOME ?? join(voiceRoot, "codex-home"),
		codexBin: env.FLYWHEEL_CODEX_BIN ?? "codex",
		commCliPath:
			env.FLYWHEEL_COMM_CLI ??
			join(flywheelDir, "packages", "flywheel-comm", "dist", "index.js"),
		projectsPath: env.FLYWHEEL_PROJECTS_FILE ?? join(stateDir, "projects.json"),
		leaseHttpTimeoutMs,
		idlePollMs: integer(env, "FLYWHEEL_VOICE_IDLE_POLL_MS", 5_000),
		leaseRenewMs,
		leaseMissMax: integer(env, "FLYWHEEL_VOICE_LEASE_MISS_MAX", 2),
		presenceGraceMs: integer(env, "FLYWHEEL_VOICE_PRESENCE_GRACE_MS", 120_000),
		speechChunkTokens: integer(env, "FLYWHEEL_VOICE_SPEECH_CHUNK_TOKENS", 600),
		confirmationMs: integer(env, "FLYWHEEL_VOICE_CONFIRMATION_MS", 15_000),
		discordTimeoutMs: integer(env, "FLYWHEEL_VOICE_DISCORD_TIMEOUT_MS", 10_000),
		mirrorRetries: integer(env, "FLYWHEEL_VOICE_MIRROR_ATTEMPTS", 2) - 1,
		mirrorRetryWindowMs: integer(
			env,
			"FLYWHEEL_VOICE_MIRROR_RETRY_WINDOW_MS",
			60_000,
		),
		ingestRetries: integer(env, "FLYWHEEL_VOICE_INGEST_ATTEMPTS", 2) - 1,
		deliveryRetryMs: integer(env, "FLYWHEEL_VOICE_DELIVERY_RETRY_MS", 500),
	};
}

export function loadVoiceProjects(
	config: VoiceDaemonConfig,
	env: Readonly<Record<string, string | undefined>> = process.env,
): VoiceProjectRow[] {
	const parsed = JSON.parse(
		env.FLYWHEEL_PROJECTS ?? readFileSync(config.projectsPath, "utf8"),
	) as unknown;
	if (!Array.isArray(parsed))
		throw new Error("voice project registry must be an array");
	return parsed as VoiceProjectRow[];
}

export function resolveVoiceBotToken(
	projectName: string,
	guildId: string,
	voiceChannelId: string,
	projects: VoiceProjectRow[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const matches = projects.filter(
		(project) => project.projectName === projectName,
	);
	if (matches.length !== 1) throw new Error("voice_session_registry_drift");
	const huddle = matches[0]?.huddle;
	if (
		!huddle ||
		huddle.guildId !== guildId ||
		huddle.voiceChannelId !== voiceChannelId ||
		!/^[A-Z_][A-Z0-9_]*$/u.test(huddle.orchestratorBotTokenEnv)
	) {
		throw new Error("voice_session_registry_drift");
	}
	const token = env[huddle.orchestratorBotTokenEnv]?.trim();
	if (!token) throw new Error("voice_bot_token_unset");
	return token;
}
