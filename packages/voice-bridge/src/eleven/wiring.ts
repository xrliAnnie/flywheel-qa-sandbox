/**
 * /eleven runtime wiring (FLY-1006 S7) — makes /eleven INVOKABLE on the
 * running voice-bridge daemon: huddle.eleven config → guild command +
 * interaction dispatch (orchestrator bot) → ElevenCommand → ElevenSession,
 * consuming the SHARED VoiceRoomRuntime (S5b) — /eleven and /gemini contend
 * for the same slot and the same resident ears.
 *
 * Deliberately thin next to the /gemini wiring: STT/turn-taking/TTS and
 * interruption live on the platform; the daemon only moves audio. The shim +
 * tunnel + agent are session-front runbook assets (research §2.3) — the
 * command preflight fail-louds when any is missing, never a silent degrade.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AssistantSpeaker } from "../assistant/AssistantSpeaker.js";
import { makeDeferredPlayer } from "../assistant/wiring.js";
import type { PlayerLike, ResourceSource } from "../audio/LeadSpeaker.js";
import type { DiscordDeps } from "../bots/discordWiring.js";
import type { HuddleBridgeConfig } from "../config.js";
import type { VoiceRoomRuntime } from "../VoiceRoomRuntime.js";
import { ELEVEN_SLOT_MODE, type ElevenModeConfig } from "./config.js";
import { ElevenCommand, type ElevenPreflightResult } from "./ElevenCommand.js";
import {
	ElevenSession,
	type ElevenWsHandlers,
	type ElevenWsLike,
} from "./ElevenSession.js";
import { ElevenWs } from "./ElevenWs.js";

const ORCHESTRATOR = "orchestrator";

/** M2 追加要求② — the waiting cue on the SHARED player (the cue and the mouth
 * are the same orchestrator bot). plan §4: the clip LOOPS from the founder's
 * speech-end until the real answer's onset (~1.4s clip vs a multi-second
 * wait). Two guards keep the shared player safe (QA FLY-1006 B2): stop()
 * touches the player only while the cue itself is on, and the idle-loop
 * replays only while on — cue plumbing can never cut a live turn stream. */
export function makeWaitingCue(opts: {
	player: PlayerLike;
	createResource: (src: ResourceSource) => unknown;
	path: string;
}): { start(): void; stop(): void } {
	let on = false;
	const playClip = () =>
		opts.player.play(opts.createResource({ kind: "file", path: opts.path }));
	// registered once per session player; the clip ending fires "idle" → replay
	opts.player.on("idle", () => {
		if (on) playClip();
	});
	return {
		start: () => {
			if (on) return;
			on = true;
			playClip();
		},
		stop: () => {
			if (!on) return;
			on = false;
			opts.player.stop();
		},
	};
}

export interface WireElevenOptions {
	config: HuddleBridgeConfig;
	eleven: ElevenModeConfig;
	registry: {
		client(id: string): unknown;
		join(
			id: string,
			opts: {
				guildId: string;
				channelId: string;
				selfMute: boolean;
				selfDeaf: boolean;
			},
		): Promise<unknown>;
	};
	deps: DiscordDeps;
	/** the daemon's shared room runtime (S5b) — REQUIRED: /eleven never owns
	 * a private slot or ears. */
	room: VoiceRoomRuntime;
	env?: NodeJS.ProcessEnv;
	log?: (msg: string) => void;
	fetchImpl?: typeof fetch;
	/** test seam: replaces the real ElevenWs connect (offline tests). */
	connectWs?: (
		handlers: ElevenWsHandlers,
		sessionId: string,
	) => Promise<ElevenWsLike>;
	/** test seam: state dir override (default ~/.flywheel/voice-eleven). */
	stateDir?: string;
	/** FLY-1160 §3.3 Phase 1: when true, new /eleven invocations are refused
	 * (命令下架) — the daemon is shutting down and must not start meetings. */
	isShuttingDown?: () => boolean;
}

export interface ElevenRuntime {
	commandName: string;
	close(): Promise<void>;
}

export async function wireElevenMode(
	opts: WireElevenOptions,
): Promise<ElevenRuntime> {
	const env = opts.env ?? process.env;
	const log =
		opts.log ?? ((msg: string) => console.log(`[voice-bridge] ${msg}`));
	const { config, eleven, registry, deps, room } = opts;

	const apiKey = env[eleven.apiKeyEnv];
	if (!apiKey && !opts.connectWs) {
		throw new Error(
			`voice-bridge: env ${eleven.apiKeyEnv} unset — /eleven cannot mint signed URLs`,
		);
	}

	const fetchImpl = opts.fetchImpl ?? fetch;
	const stateDir =
		opts.stateDir ??
		join(homedir(), ".flywheel", "voice-eleven", config.projectName);
	mkdirSync(stateDir, { recursive: true });

	// fail-loud preflight (research §2.3): agent reachable + shim healthy.
	// key-in-place is checked above; the tunnel is transitively proven by the
	// shim probe + the first real turn (its URL lives in the agent config).
	const preflight = async (): Promise<ElevenPreflightResult> => {
		try {
			const r = await fetchImpl(
				`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(eleven.agentId)}`,
				{ headers: { "xi-api-key": apiKey ?? "" } },
			);
			if (!r.ok) {
				return {
					ok: false,
					reason: `agent 不可达(GET ${r.status})——按 m1-rig.md runbook 重建 agent 并更新 huddle.eleven.agentId`,
				};
			}
		} catch (err) {
			return {
				ok: false,
				reason: `ElevenLabs API 连不上(${String((err as Error).message ?? err)})`,
			};
		}
		try {
			const h = await fetchImpl(eleven.shimHealthUrl);
			if (!h.ok) {
				return {
					ok: false,
					reason: `shim 探针 ${eleven.shimHealthUrl} 返回 ${h.status}——先按 runbook 起 shim`,
				};
			}
		} catch {
			return {
				ok: false,
				reason: `shim 不在线(${eleven.shimHealthUrl})——runbook: 起 shim → 起隧道 → patch agent`,
			};
		}
		return { ok: true };
	};

	const orchestratorClient = registry.client(ORCHESTRATOR);
	let activeSession: ElevenSession | null = null;

	// QA R3 ②③ — the TIV: status + BOTH sides' transcript into the voice
	// channel's text area (the assistant TivSurface shape). /eleven captions
	// are per-turn platform events (one user_transcript + one agent_response
	// per round), so posting each is a couple of messages per round — not the
	// per-delta flood the /gemini caption stream would be.
	const tiv = {
		status: (line: string) =>
			void deps
				.sendMessage(orchestratorClient, config.voiceChannelId, line)
				.catch((err) => log(`eleven TIV status send failed: ${err.message}`)),
		caption: (role: "user" | "assistant", text: string) =>
			void deps
				.sendMessage(
					orchestratorClient,
					config.voiceChannelId,
					role === "user" ? `🗣 ${text}` : `🤖 ${text}`,
				)
				.catch((err) => log(`eleven TIV caption send failed: ${err.message}`)),
	};

	const command = new ElevenCommand({
		commandName: eleven.commandName,
		slot: room.slot,
		joinUrl: `https://discord.com/channels/${config.guildId}/${config.voiceChannelId}`,
		preflight,
		pingFounder: (text) =>
			deps.sendMessage(orchestratorClient, config.voiceChannelId, text),
		log,
		stopSession: async () => {
			if (!activeSession) return false;
			await activeSession.stop();
			activeSession = null;
			return true;
		},
		startSession: async ({ sessionId, topic }) => {
			let orchestratorConn: unknown;
			const deferredPlayer = makeDeferredPlayer(log);
			const speaker = new AssistantSpeaker({
				player: deferredPlayer.player,
				createResource: deps.createResource,
				log,
			});
			const cue = eleven.waitingCuePath
				? makeWaitingCue({
						player: deferredPlayer.player,
						createResource: deps.createResource,
						path: eleven.waitingCuePath,
					})
				: undefined;
			const transcriptPath = join(stateDir, `${sessionId}.jsonl`);
			const connect =
				opts.connectWs != null
					? (handlers: ElevenWsHandlers) =>
							(opts.connectWs as NonNullable<typeof opts.connectWs>)(
								handlers,
								sessionId,
							)
					: async (handlers: ElevenWsHandlers): Promise<ElevenWsLike> => {
							const ws = new ElevenWs({
								agentId: eleven.agentId,
								apiKey: apiKey as string,
								conversationId: sessionId,
								overrides: {
									voiceId: eleven.voiceId,
									prompt: eleven.prompt,
								},
								fetchImpl,
								log,
								...handlers,
							});
							await ws.connect();
							return ws;
						};
			const session = new ElevenSession({
				sessionId,
				topic,
				slot: room.slot,
				slotMode: ELEVEN_SLOT_MODE,
				ears: room,
				connect,
				speaker,
				voice: {
					join: async () => {
						orchestratorConn = await registry.join(ORCHESTRATOR, {
							guildId: config.guildId,
							channelId: config.voiceChannelId,
							selfMute: false,
							selfDeaf: true, // the ears bot hears; the mouth must not echo
						});
						deferredPlayer.setReal(deps.createPlayer(orchestratorConn));
					},
					leave: () => {
						if (orchestratorConn) deps.leaveVoice(orchestratorConn);
						orchestratorConn = undefined;
						deferredPlayer.clear();
					},
				},
				cue,
				tiv,
				// the 🧠 debounce must cover every pause the ears still treat as
				// the same utterance (Codex R3-fix-3) — align with the holdoff.
				statusDebounceMs: config.bargeInHoldoffMs,
				transcript: (line) => {
					try {
						appendFileSync(transcriptPath, `${JSON.stringify(line)}\n`);
					} catch (err) {
						log(
							`[eleven] transcript write failed: ${String((err as Error).message ?? err)}`,
						);
					}
				},
				log,
				onEnded: () => {
					if (activeSession === session) activeSession = null;
				},
			});
			activeSession = session;
			await session.start();
		},
	});

	try {
		await deps.registerGuildCommand(orchestratorClient, config.guildId, {
			name: command.name,
			description: "ElevenLabs 平台耳嘴 + Claude 脑 — /eleven 语音会话",
		});
		log(`/${command.name} registered on guild ${config.guildId}`);
	} catch (err) {
		log(
			`WARNING: /${command.name} slash registration failed (missing applications.commands scope?): ${String((err as Error).message ?? err)}`,
		);
	}
	deps.onChatCommand(orchestratorClient, command.name, (inv) => {
		// FLY-1160 §3.3 Phase 1: 命令下架 — no new meetings during shutdown.
		if (opts.isShuttingDown?.()) {
			log(`/${command.name} refused — daemon shutting down`);
			void inv
				.reply("voice-bridge 正在关闭,现在开不了新会 — 请稍后再试。")
				.catch(() => {});
			return;
		}
		void command
			.handle({ topic: inv.topic, reply: inv.reply })
			.catch((err) => log(`/${command.name} handle failed: ${err.message}`));
	});

	// QA test-injection seam (FLY-967 autostart precedent): staged rigs have
	// no human to click the slash command. Unset = zero behavior change.
	const autostartTopic = env.FLYWHEEL_ELEVEN_AUTOSTART;
	if (autostartTopic !== undefined) {
		log(
			`/eleven autostart QA seam armed (topic: ${autostartTopic || "(none)"})`,
		);
		setTimeout(() => {
			void command
				.handle({
					topic: autostartTopic || undefined,
					reply: async (text, o) =>
						deps.sendMessage(
							orchestratorClient,
							config.voiceChannelId,
							o?.joinUrl ? `${text}\n${o.joinUrl}` : text,
						),
				})
				.catch((err) => log(`/eleven autostart failed: ${err.message}`));
		}, 2_000).unref?.();
	}

	return {
		commandName: command.name,
		close: async () => {
			await activeSession?.stop();
			activeSession = null;
		},
	};
}
