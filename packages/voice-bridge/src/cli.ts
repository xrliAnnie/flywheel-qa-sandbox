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
import {
	type AssistantModeConfig,
	loadAssistantConfig,
} from "./assistant/config.js";
import {
	type AssistantRuntime,
	wireAssistantMode,
} from "./assistant/wiring.js";
import { BotRegistry } from "./bots/BotRegistry.js";
import { createDiscordDeps, type DiscordDeps } from "./bots/discordWiring.js";
import { type HuddleBridgeConfig, loadHuddleBridgeConfig } from "./config.js";
import { type BinaryProbe, verifyPlaybackStack } from "./preflight.js";

export interface VoiceBridgeRuntime {
	config: HuddleBridgeConfig;
	close: () => Promise<void>;
}

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

	let assistantRuntime: AssistantRuntime | undefined;
	try {
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

		// FLY-967: /gemini assistant mode — only when the config opts in.
		if (assistant) {
			assistantRuntime = await wireAssistantMode({
				config,
				assistant,
				registry,
				deps,
				earsConnection,
				log,
				...opts.assistantWiring,
			});
			state.assistant = assistantRuntime.commandName;
		} else {
			log("assistant mode off (no huddle.assistant block)");
		}
	} catch (err) {
		await new Promise<void>((resolve) => health.close(() => resolve()));
		await registry.destroyAll();
		throw err;
	}

	const close = async (): Promise<void> => {
		log("shutting down (bounded)");
		// flip BEFORE teardown so a concurrent launcher preflight sees
		// shutting_down (waits) instead of healthy (walks away) — same
		// zombie-vs-healthy disambiguation contract as the Bridge (FLY-516).
		state.shuttingDown = true;
		await Promise.race([
			(async () => {
				await assistantRuntime?.close();
				await registry.destroyAll();
				await new Promise<void>((resolve) => health.close(() => resolve()));
			})(),
			new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
		]);
	};

	return { config, close };
}

/** daemon main (used by scripts/run-voice-bridge.ts). */
export async function main(): Promise<void> {
	const runtime = await runVoiceBridge();
	const shutdown = (signal: string) => {
		console.log(`[voice-bridge] ${signal} received`);
		void runtime.close().then(() => process.exit(0));
		// bounded: never hang the supervisor
		setTimeout(() => process.exit(1), 12_000).unref();
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}
