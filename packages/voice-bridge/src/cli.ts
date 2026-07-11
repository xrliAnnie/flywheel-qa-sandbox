/**
 * voice-bridge daemon entry (FLY-545 P6 — PR-1 resident skeleton).
 *
 * PR-1 scope: fail-fast config + playback preflight + /health endpoint +
 * BotRegistry login (orchestrator + Note-taker + Lead bots) + the Note-taker
 * joining the resident #huddle VC. The /meet orchestration loop (HuddleSession
 * + conversation wiring) lands in PR-2 on top of this residency.
 *
 * Ops discipline mirrors the Bridge daemon: bounded shutdown on
 * SIGTERM/SIGINT, single-instance guarded by the wrapper (PID file + port
 * preflight on the health port), secrets only via env (never argv/logs).
 */
import { createServer, type Server } from "node:http";
import { ResidentBrainManager } from "flywheel-voice-core";
import { loadAdvancedAgentConfig } from "./assistant/advanced.js";
import {
	type AssistantModeConfig,
	DEFAULT_ADVANCED_COMMAND,
	loadAssistantConfig,
} from "./assistant/config.js";
import {
	type AssistantRuntime,
	wireAssistantMode,
} from "./assistant/wiring.js";
import { BotRegistry } from "./bots/BotRegistry.js";
import { createDiscordDeps, type DiscordDeps } from "./bots/discordWiring.js";
import { BrainPort } from "./brain/BrainPort.js";
import { type HuddleBridgeConfig, loadHuddleBridgeConfig } from "./config.js";
import { type ElevenModeConfig, loadElevenConfig } from "./eleven/config.js";
import { type ElevenRuntime, wireElevenMode } from "./eleven/wiring.js";
import { type BinaryProbe, verifyPlaybackStack } from "./preflight.js";
import { type RoomEarsRuntime, wireRoomEars } from "./roomEars.js";
import { VoiceRoomRuntime } from "./VoiceRoomRuntime.js";

export interface VoiceBridgeRuntime {
	config: HuddleBridgeConfig;
	close: () => Promise<void>;
	/** FLY-1160: synchronous SIGKILL of every resident brain child — the
	 * outer shutdown hard-timer path (never exit with a live child behind). */
	forceKillAll: () => void;
}

/** FLY-1160: token env name is HARD-PINNED (Codex R2 #4b) — a configurable
 * tokenEnv would let daemon and shim read different secrets. */
const BRAIN_PORT_TOKEN_ENV = "FLYWHEEL_BRAIN_PORT_TOKEN";

export interface RunVoiceBridgeOptions {
	config?: HuddleBridgeConfig;
	deps?: DiscordDeps;
	log?: (msg: string) => void;
	/** test seam for the ffmpeg preflight probe. */
	probe?: BinaryProbe;
	/** FLY-967: assistant sub-block; undefined = load from projects.json,
	 * null = explicitly off (byte-compat with the pre-assistant daemon). */
	assistant?: AssistantModeConfig | null;
	/** FLY-967 test seam: forwarded to wireAssistantMode. */
	assistantWiring?: {
		createConversation?: Parameters<
			typeof wireAssistantMode
		>[0]["createConversation"];
		fetchImpl?: typeof fetch;
		stateDir?: string;
		env?: NodeJS.ProcessEnv;
	};
	/** FLY-1006: /eleven sub-block; undefined = load from projects.json,
	 * null = explicitly off (byte-compat with the pre-eleven daemon). */
	eleven?: ElevenModeConfig | null;
	/** FLY-1006 test seam: forwarded to wireElevenMode. */
	elevenWiring?: {
		connectWs?: Parameters<typeof wireElevenMode>[0]["connectWs"];
		fetchImpl?: typeof fetch;
		stateDir?: string;
		env?: NodeJS.ProcessEnv;
	};
	/** FLY-1160 test seam: Phase-2 landing budget of the two-phase shutdown
	 * (default 10s — the pre-existing bounded-close behavior). */
	shutdownBudgetMs?: number;
}

const NOTE_TAKER = "note-taker";
const ORCHESTRATOR = "orchestrator";

export async function runVoiceBridge(
	opts: RunVoiceBridgeOptions = {},
): Promise<VoiceBridgeRuntime> {
	const log =
		opts.log ?? ((msg: string) => console.log(`[voice-bridge] ${msg}`));
	const config = opts.config ?? loadHuddleBridgeConfig();
	const assistant =
		opts.assistant !== undefined ? opts.assistant : loadAssistantConfig();
	const eleven = opts.eleven !== undefined ? opts.eleven : loadElevenConfig();

	// playback stack dies here, not after a bot already joined the VC.
	await verifyPlaybackStack(config.ffmpegBin, opts.probe);
	if (
		!process.env.GEMINI_API_KEY &&
		!opts.assistantWiring?.createConversation
	) {
		if (assistant) {
			// FLY-967: assistant mode opens a real Gemini Live session per meeting
			// — a missing key must kill the deploy at startup, not mid-meeting.
			throw new Error(
				"voice-bridge: GEMINI_API_KEY unset but huddle.assistant is configured — /gemini would fail at first use",
			);
		}
		// PR-1 residency without assistant mode does not open a Gemini session
		// yet; PR-2 (the /meet loop) upgrades this to fail-fast. Warn loudly so
		// the deploy gets fixed before the loop lands.
		log(
			"WARNING: GEMINI_API_KEY unset — the PR-2 conversation loop will fail-fast on this",
		);
	}
	// FLY-1159 (Codex R3): every enabled voice command registers its own
	// interaction handler on the SAME orchestrator client — a duplicate name
	// would attach two handlers to one command (double deferReply). Refuse to
	// assemble. Checked BEFORE the advanced env preflight so a misconfigured
	// name never hides behind an env error.
	const voiceCommandNames = [
		assistant ? (assistant.commandName ?? "gemini") : null,
		assistant?.advanced
			? (assistant.advanced.commandName ?? DEFAULT_ADVANCED_COMMAND)
			: null,
		eleven ? eleven.commandName : null,
	].filter((n): n is string => n != null);
	const dupCommandName = voiceCommandNames.find(
		(n, i) => voiceCommandNames.indexOf(n) !== i,
	);
	if (dupCommandName) {
		throw new Error(
			`voice-bridge: duplicate voice command name "/${dupCommandName}" — assistant / assistant.advanced / eleven command names must all be unique (each registers its own interaction handler on the orchestrator bot)`,
		);
	}
	// FLY-1018 voice phase: a half-configured advanced mode must kill the
	// deploy at startup, never at the founder's first /gemini-advanced use.
	if (assistant?.advanced && !opts.assistantWiring?.createConversation) {
		loadAdvancedAgentConfig(process.env);
	}

	const deps = opts.deps ?? (await createDiscordDeps());
	const registry = new BotRegistry<
		ReturnType<DiscordDeps["createClient"]>,
		unknown
	>({
		createClient: deps.createClient,
		joinVoice: deps.joinVoice,
	});

	const state = {
		bots: [] as string[],
		earsJoined: false,
		/** FLY-967: the registered assistant command name (null = mode off). */
		assistant: null as string | null,
		/** FLY-1159: the separate delegate-carrying voice command
		 * (null = advanced mode off — only the plain assistant registered). */
		assistantAdvanced: null as string | null,
		/** FLY-1006: the registered /eleven command name (null = mode off). */
		eleven: null as string | null,
		// scripts/lib/bridge-port.sh classifies health JSON WITHOUT a
		// shuttingDown field as "legacy" and reclaims (kills) the instance —
		// omitting it would make every duplicate launchd start kill a healthy
		// voice-bridge (Codex R1 HIGH). Schema must match the Bridge's /health.
		shuttingDown: false,
	};

	const health: Server = createServer((req, res) => {
		if (req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					shuttingDown: state.shuttingDown,
					service: "voice-bridge",
					project: config.projectName,
					bots: state.bots,
					earsJoined: state.earsJoined,
					assistant: state.assistant,
					assistantAdvanced: state.assistantAdvanced,
					eleven: state.eleven,
				}),
			);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve, reject) => {
		health.once("error", reject);
		health.listen(config.healthPort, "127.0.0.1", () => resolve());
	});
	log(`health endpoint on 127.0.0.1:${config.healthPort}/health`);

	// FLY-1160: the daemon is the ONLY owner of resident brains — singleton
	// manager first, then (when configured) the loopback BrainPort, then the
	// Discord wiring. Phase A wires no consumers on main; /glaw and /eleven
	// bind keys in their own branches.
	const brainManager = new ResidentBrainManager({
		maxSessions: config.brain?.maxSessions ?? 4,
	});
	let brainPort: BrainPort | undefined;

	let assistantRuntime: AssistantRuntime | undefined;
	let elevenRuntime: ElevenRuntime | undefined;
	let roomEars: RoomEarsRuntime | undefined;
	try {
		if (config.brain?.port !== undefined) {
			const brainToken = process.env[BRAIN_PORT_TOKEN_ENV];
			if (brainToken) {
				brainPort = new BrainPort({
					manager: brainManager,
					port: config.brain.port,
					token: brainToken,
					log,
				});
				await brainPort.listen();
				log(
					`brain port on 127.0.0.1:${config.brain.port}/brain (Bearer-gated)`,
				);
			} else {
				// half-configured is OFF, loudly: port without secret must not
				// open an unauthenticated brain endpoint.
				log(
					`huddle.brain.port configured but ${BRAIN_PORT_TOKEN_ENV} unset — BrainPort NOT started`,
				);
			}
		}

		const bots = [
			{ id: ORCHESTRATOR, token: config.orchestratorToken },
			{ id: NOTE_TAKER, token: config.earsToken },
			...config.leads.map((lead) => ({
				id: lead.agentId,
				token: lead.botToken,
			})),
		];
		await registry.start(bots);
		state.bots = bots.map((b) => b.id);
		log(`bots online: ${state.bots.join(", ")}`);

		// the Note-taker is the resident ear — selfMute (it never speaks),
		// selfDeaf false (hearing is its whole job).
		const earsConnection = await registry.join(NOTE_TAKER, {
			guildId: config.guildId,
			channelId: config.voiceChannelId,
			selfMute: true,
			selfDeaf: false,
		});
		state.earsJoined = true;
		log(`Note-taker resident in VC ${config.voiceChannelId}`);

		// FLY-1006 S5b: ONE shared room runtime (slot + resident-ears routing)
		// for every voice mode — /gemini and /eleven contend for the SAME slot
		// and consume the SAME physical receiver.
		if (assistant || eleven) {
			const room = new VoiceRoomRuntime();
			roomEars = wireRoomEars({
				room,
				deps,
				earsConnection,
				earsClient: registry.client(NOTE_TAKER),
				guildId: config.guildId,
				allowUserIds: config.allowUserIds,
				backchannelMs: config.backchannelMs,
				bargeInHoldoffMs: config.bargeInHoldoffMs,
				log,
			});
			// FLY-967: /gemini assistant mode — only when the config opts in.
			if (assistant) {
				assistantRuntime = await wireAssistantMode({
					config,
					assistant,
					registry,
					deps,
					earsConnection,
					room,
					log,
					...opts.assistantWiring,
					// FLY-1160 §3.3 Phase 1: 命令下架 during shutdown
					isShuttingDown: () => state.shuttingDown,
				});
				state.assistant = assistantRuntime.commandName;
				state.assistantAdvanced = assistantRuntime.advancedCommandName ?? null;
			}
			// FLY-1006: /eleven mode — only when the config opts in.
			if (eleven) {
				elevenRuntime = await wireElevenMode({
					config,
					eleven,
					registry,
					deps,
					room,
					log,
					...opts.elevenWiring,
					isShuttingDown: () => state.shuttingDown,
				});
				state.eleven = elevenRuntime.commandName;
			}
		}
		if (!assistant) log("assistant mode off (no huddle.assistant block)");
		if (!eleven) log("eleven mode off (no huddle.eleven block)");
	} catch (err) {
		// assembly-failure rollback: BrainPort down + every resident child
		// reaped before the error propagates (FLY-1148: who spawns, reaps).
		await new Promise<void>((resolve) => health.close(() => resolve()));
		await registry.destroyAll();
		if (brainPort) await brainPort.close();
		await brainManager.closeAll();
		throw err;
	}

	const shutdownBudgetMs = opts.shutdownBudgetMs ?? 10_000;
	const close = async (): Promise<void> => {
		log("shutting down (two-phase, bounded)");
		// Phase 1 (immediate): stop taking new work. Flip BEFORE teardown so a
		// concurrent launcher preflight sees shutting_down (waits) instead of
		// healthy (walks away) — same zombie-vs-healthy disambiguation
		// contract as the Bridge (FLY-516). BrainPort answers 503 from here.
		state.shuttingDown = true;
		brainPort?.beginShutdown();
		// Phase 2 (landing, bounded budget): assistant/eleven landing + Discord
		// teardown + health close. Consumers (545/1006) hang their meeting
		// finalizers into this same budget in their wiring PRs. A Phase-2
		// failure must NEVER skip Phase 3 (Codex #550 R1 HIGH) — log and fall
		// through to the reaping.
		let phase2Timer: NodeJS.Timeout | undefined;
		// the deadline is TRUE cancellation, not stop-waiting: once the budget
		// expires this signal aborts, and the landing performs no further
		// external writes and never reports success (Codex #550 R2 HIGH).
		const phase2Abort = new AbortController();
		try {
			await Promise.race([
				(async () => {
					await assistantRuntime?.close({ signal: phase2Abort.signal });
					await elevenRuntime?.close();
					roomEars?.dispose();
					await registry.destroyAll();
					await new Promise<void>((resolve) => health.close(() => resolve()));
				})(),
				new Promise<void>((resolve) => {
					phase2Timer = setTimeout(() => {
						phase2Abort.abort();
						resolve();
					}, shutdownBudgetMs);
				}),
			]);
		} catch (err) {
			log(
				`shutdown Phase 2 failed (continuing to reap): ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			if (phase2Timer) clearTimeout(phase2Timer);
			// Phase 3 (finally, NOT raceable/skippable): every resident child's
			// exit is confirmed before close() resolves — never leave a live
			// claude process behind (dispose ladder is bounded: EOF→TERM→KILL).
			try {
				if (brainPort) await brainPort.close();
			} finally {
				await brainManager.closeAll();
			}
		}
	};

	return { config, close, forceKillAll: () => brainManager.forceKillAll() };
}

/** daemon main (used by scripts/run-voice-bridge.ts). */
export async function main(): Promise<void> {
	const runtime = await runVoiceBridge();
	const shutdown = (signal: string) => {
		console.log(`[voice-bridge] ${signal} received`);
		void runtime.close().then(() => process.exit(0));
		// outer hard timer: bounded for the supervisor, and NEVER exit with a
		// live resident child behind — synchronous SIGKILL first (FLY-1160).
		setTimeout(() => {
			runtime.forceKillAll();
			process.exit(1);
		}, 12_000).unref();
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}
