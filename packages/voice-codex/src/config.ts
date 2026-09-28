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
	buildSha: string | null;
	apiToken: string;
	bridgeUrl: string;
	voiceRoot: string;
	healthStateRoot: string;
	voiceHealthHelperPath: string;
	codexHome: string;
	codexBin: string;
	/**
	 * FLY-2885: the fleet's ChatGPT subscription credential. Engine B's temporary
	 * CODEX_HOME only symlinks to it; it is never copied or read here.
	 */
	codexAuthSource: string;
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
	/** Uplink VAD pre-roll for the room's speech gate; see FLY-2798/FLY-2799. */
	uplinkPrerollMs: number;
	/**
	 * FLY-2885 T6: sentence-level peak gate for WebRTC rooms; null turns it off.
	 * Far-away voices peaked at -34.1 dBFS, the founder's softest line at -26.2.
	 */
	uplinkMinOnsetDbfs: number | null;
	/** FLY-2885 T2: ICE servers for the WebRTC leg; empty means host candidates only. */
	webrtcStunUrls: string[];
	/** FLY-2885 QA-3a fault switch; the production wrapper never sets it. */
	qaFaults: boolean;
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

function boundedMs(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	fallback: number,
	max: number,
): number {
	const raw = env[name];
	const value = raw === undefined ? fallback : Number(raw);
	if (!Number.isSafeInteger(value) || value < 0 || value > max) {
		throw new Error(`${name} must be an integer between 0 and ${max}`);
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

/** FLY-2885: engine B must not carry either key into its own process. */
export function scrubVoiceApiKeys(env: NodeJS.ProcessEnv): void {
	delete env.OPENAI_API_KEY;
	delete env.CODEX_API_KEY;
}

function onsetDbfs(
	env: Readonly<Record<string, string | undefined>>,
): number | null {
	const raw = env.FLYWHEEL_VOICE_UPLINK_MIN_ONSET_DBFS?.trim();
	if (raw === undefined || raw === "") return -30;
	if (raw === "off") return null;
	const value = Number(raw);
	if (!/^-?\d+(?:\.\d+)?$/u.test(raw) || value > 0 || value < -90) {
		throw new Error(
			"FLYWHEEL_VOICE_UPLINK_MIN_ONSET_DBFS must be off or a dBFS value between -90 and 0",
		);
	}
	return value;
}

function stunUrls(env: Readonly<Record<string, string | undefined>>): string[] {
	const raw = env.FLYWHEEL_VOICE_WEBRTC_STUN;
	if (raw === undefined) return ["stun:stun.l.google.com:19302"];
	const urls = raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (urls.some((url) => !/^stuns?:[^\s/]+$/u.test(url))) {
		throw new Error("FLYWHEEL_VOICE_WEBRTC_STUN must list stun: URLs");
	}
	return urls;
}

function qaFaults(env: Readonly<Record<string, string | undefined>>): boolean {
	const raw = env.FLYWHEEL_VOICE_QA_FAULTS;
	if (raw === undefined || raw === "" || raw === "0") return false;
	if (raw === "1") return true;
	throw new Error("FLYWHEEL_VOICE_QA_FAULTS must be 0 or 1");
}

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
	const apiToken = env.TEAMLEAD_API_TOKEN?.trim();
	if (!apiToken) throw new Error("TEAMLEAD_API_TOKEN is required");
	const flywheelDir = env.FLYWHEEL_DIR ?? join(homeDir, "Dev", "flywheel");
	const stateDir = env.FLYWHEEL_STATE_DIR ?? join(homeDir, ".flywheel");
	const voiceRoot = env.FLYWHEEL_VOICE_STATE_DIR ?? join(stateDir, "voice");
	const commDbPath = env.FLYWHEEL_COMM_DB?.trim();
	const buildSha = env.FLYWHEEL_VOICE_BUILD_SHA?.trim() || null;
	// FLY-2982: engine B is the only engine. It authenticates with the ChatGPT
	// subscription over WebRTC, so no selector or platform key is read here.
	const codexAuthSource =
		env.FLYWHEEL_VOICE_CODEX_AUTH_SOURCE?.trim() ||
		join(homeDir, ".codex", "auth.json");
	if (!isAbsolute(codexAuthSource) || resolve(codexAuthSource) === sep) {
		throw new Error(
			"FLYWHEEL_VOICE_CODEX_AUTH_SOURCE must be an absolute file path",
		);
	}
	const codexBin = env.FLYWHEEL_CODEX_BIN ?? "codex";
	if (!isAbsolute(codexBin)) {
		throw new Error("voice requires an absolute standalone Codex binary");
	}
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
		buildSha,
		apiToken,
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
		codexBin,
		codexAuthSource,
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
		// FLY-2798: soft sentence starts were silenced by the uplink VAD gate.
		uplinkPrerollMs: boundedMs(
			env,
			"FLYWHEEL_VOICE_UPLINK_PREROLL_MS",
			200,
			1_000,
		),
		uplinkMinOnsetDbfs: onsetDbfs(env),
		webrtcStunUrls: stunUrls(env),
		qaFaults: qaFaults(env),
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
