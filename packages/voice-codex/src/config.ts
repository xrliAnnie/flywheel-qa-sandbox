import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface VoiceProjectRow {
	projectName: string;
	huddle?: unknown;
	voiceRoom?: { guildId: string; voiceChannelId: string } | null;
	leads?: { agentId: string; botUserId?: string; botTokenEnv?: string }[];
}

export interface VoiceBotBinding {
	projectName: string;
	leadId: string;
	guildId: string;
	voiceChannelId: string;
	voiceBotUserId: string;
}

export interface VoiceDaemonConfig {
	engine: "legacy-realtime" | "openai-live";
	buildSha: string | null;
	realtimeApiKey: string;
	apiToken: string;
	bridgeUrl: string;
	voiceRoot: string;
	healthStateRoot: string;
	voiceHealthHelperPath: string;
	codexHome: string;
	codexBin: string;
	commCliPath: string;
	commDbPath?: string;
	projectsPath: string;
	idleHttpTimeoutMs: number;
	leaseHttpTimeoutMs: number;
	idlePollMs: number;
	idleExitMs: number;
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

export function validateVoiceBridgeUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("voice_bridge_url_invalid");
	}
	const hostname = parsed.hostname.toLowerCase();
	const loopback =
		hostname === "localhost" ||
		hostname === "[::1]" ||
		/^127(?:\.[0-9]{1,3}){3}$/u.test(hostname);
	if (
		!(["http:", "https:"] as const).includes(
			parsed.protocol as "http:" | "https:",
		) ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		!loopback
	) {
		throw new Error("voice_bridge_url_invalid");
	}
	return parsed.toString().replace(/\/+$/u, "");
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
	const bridgeUrl = validateVoiceBridgeUrl(
		env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL ?? "http://127.0.0.1:9876",
	);
	const engine = env.FLYWHEEL_VOICE_ENGINE?.trim() || "legacy-realtime";
	if (engine !== "legacy-realtime" && engine !== "openai-live") {
		throw new Error(
			"FLYWHEEL_VOICE_ENGINE must be legacy-realtime or openai-live",
		);
	}
	const apiToken = env.TEAMLEAD_API_TOKEN?.trim();
	if (!apiToken) throw new Error("TEAMLEAD_API_TOKEN is required");
	const realtimeApiKey = env.OPENAI_API_KEY?.trim();
	if (!realtimeApiKey) throw new Error("OPENAI_API_KEY is required");
	const flywheelDir = env.FLYWHEEL_DIR ?? join(homeDir, "Dev", "flywheel");
	const stateDir = env.FLYWHEEL_STATE_DIR ?? join(homeDir, ".flywheel");
	const voiceRoot = env.FLYWHEEL_VOICE_STATE_DIR ?? join(stateDir, "voice");
	const commDbPath = env.FLYWHEEL_COMM_DB?.trim();
	const buildSha = env.FLYWHEEL_VOICE_BUILD_SHA?.trim() || null;
	if (buildSha && !/^[0-9a-f]{40}$/u.test(buildSha)) {
		throw new Error(
			"FLYWHEEL_VOICE_BUILD_SHA must be a full lowercase git SHA",
		);
	}
	if (commDbPath && (!isAbsolute(commDbPath) || resolve(commDbPath) === sep)) {
		throw new Error("FLYWHEEL_COMM_DB must be an absolute non-root path");
	}
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
	if (leaseRenewMs + 3 * leaseHttpTimeoutMs >= leaseTtlMs) {
		throw new Error(
			"voice lease must reserve time for the health retry and fencing margin",
		);
	}
	return {
		engine,
		buildSha,
		apiToken,
		realtimeApiKey,
		bridgeUrl,
		voiceRoot,
		healthStateRoot: stateDir,
		voiceHealthHelperPath: join(
			flywheelDir,
			"scripts",
			"lib",
			"voice-health.py",
		),
		codexHome: env.FLYWHEEL_VOICE_CODEX_HOME ?? join(voiceRoot, "codex-home"),
		codexBin: env.FLYWHEEL_CODEX_BIN ?? "codex",
		commCliPath:
			env.FLYWHEEL_COMM_CLI ??
			join(flywheelDir, "packages", "flywheel-comm", "dist", "index.js"),
		...(commDbPath ? { commDbPath } : {}),
		projectsPath: env.FLYWHEEL_PROJECTS_FILE ?? join(stateDir, "projects.json"),
		idleHttpTimeoutMs: integer(
			env,
			"FLYWHEEL_VOICE_IDLE_HTTP_TIMEOUT_MS",
			2_000,
		),
		leaseHttpTimeoutMs,
		idlePollMs: integer(env, "FLYWHEEL_VOICE_IDLE_POLL_MS", 5_000),
		idleExitMs: integer(env, "FLYWHEEL_VOICE_IDLE_EXIT_MS", 120_000),
		leaseRenewMs,
		leaseMissMax: integer(env, "FLYWHEEL_VOICE_LEASE_MISS_MAX", 2),
		// FLY-2701 (founder 2026-09-22): after the host is woken, the bot waits in
		// the room ten minutes for her. "Idle" means an empty room, so a short
		// grace would hang up on her while she is still walking over.
		presenceGraceMs: integer(env, "FLYWHEEL_VOICE_PRESENCE_GRACE_MS", 600_000),
		// FLY-2655 lowered this to 80; keep it — it belongs to the recovered
		// receive path, not to anything this issue changed.
		speechChunkTokens: integer(env, "FLYWHEEL_VOICE_SPEECH_CHUNK_TOKENS", 80),
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

export function resolveVoiceCommDbPath(
	config: Pick<VoiceDaemonConfig, "commDbPath">,
	projectName: string,
	homeDir: string,
): string {
	return (
		config.commDbPath ??
		join(homeDir, ".flywheel", "comm", projectName, "comm.db")
	);
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

export function resolveLeadVoiceToken(
	projection: VoiceBotBinding,
	projects: VoiceProjectRow[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const drift = () => new Error("voice_session_registry_drift");
	if (
		!projection ||
		!projection.projectName ||
		!projection.leadId ||
		![
			projection.guildId,
			projection.voiceChannelId,
			projection.voiceBotUserId,
		].every((id) => typeof id === "string" && /^\d{17,20}$/u.test(id))
	)
		throw drift();
	const matches = projects.filter(
		(project) => project?.projectName === projection.projectName,
	);
	if (matches.length !== 1) throw drift();
	const project = matches[0]!;
	if (
		project.huddle != null ||
		project.voiceRoom?.guildId !== projection.guildId ||
		project.voiceRoom?.voiceChannelId !== projection.voiceChannelId ||
		!Array.isArray(project.leads)
	)
		throw drift();
	const leads = project.leads.filter(
		(lead) => lead?.agentId === projection.leadId,
	);
	if (leads.length !== 1) throw drift();
	const lead = leads[0]!;
	if (
		lead.botUserId !== projection.voiceBotUserId ||
		typeof lead.botTokenEnv !== "string" ||
		!/^[A-Z_][A-Z0-9_]*$/u.test(lead.botTokenEnv)
	)
		throw drift();
	const token = env[lead.botTokenEnv]?.trim();
	if (!token) throw new Error("voice_bot_token_unset");
	return token;
}
