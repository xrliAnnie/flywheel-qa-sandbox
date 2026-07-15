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
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResidentBrainManager } from "flywheel-voice-core";
import { AssistantSpeaker } from "../assistant/AssistantSpeaker.js";
import {
	classifyVoiceDelta,
	makeDeferredPlayer,
	makeLinearClient,
} from "../assistant/wiring.js";
import type { PlayerLike, ResourceSource } from "../audio/LeadSpeaker.js";
import type { DiscordDeps } from "../bots/discordWiring.js";
import type { HuddleBridgeConfig } from "../config.js";
import type { VoiceRoomRuntime } from "../VoiceRoomRuntime.js";
import { ELEVEN_SLOT_MODE, type ElevenModeConfig } from "./config.js";
import { ElevenCommand, type ElevenPreflightResult } from "./ElevenCommand.js";
import {
	type ElevenMinutes,
	ElevenSession,
	type ElevenWsHandlers,
	type ElevenWsLike,
} from "./ElevenSession.js";
import { ElevenWs } from "./ElevenWs.js";
import {
	ElevenLanding,
	elevenTranscriptPath,
	readElevenTranscriptRows,
	reconcilePendingLandings,
} from "./landing.js";

const ORCHESTRATOR = "orchestrator";
/** FLY-1160 §4.2-4: the founder-join assemble window before a meeting is a
 * no-show. Presence-based (occupancy probe + voice-state join), NOT audio. */
const DEFAULT_NO_SHOW_MS = 10 * 60 * 1000;
const MINUTES_PROMPT =
	"这场语音会到此结束。请用中文把它整理成一段简短的会议纪要:先一句话总结聊定的事,再列关键决定与待办(有就列,没有就说没有)。只输出纪要正文,不要客套。";

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
	// ---- FLY-1160 §4.2 resident brain (all optional; absent = pre-1160
	// bare product-test surface, no kickoff issue, no landing) ----
	/** the daemon's resident brain manager — /eleven opens ONE session per
	 * meeting keyed eleven:<sessionId> (the shim reaches it via BrainPort; the
	 * daemon drives the final minutes turn directly). */
	brainManager?: ResidentBrainManager;
	/** claude binary for the resident brain (default "claude"). */
	claudeBin?: string;
	/** test seam: drive the resident final-turn minutes generation. */
	generateMinutes?: (sessionId: string) => Promise<ElevenMinutes | null>;
	/** FLY-1160 §4.2-4 (Codex #552 R2 HIGH-3): the founder-join assemble window
	 * before a meeting is a no-show. Default 10min; 0 disables. */
	noShowMs?: number;
}

export interface ElevenRuntime {
	commandName: string;
	/** FLY-1160 §3.3 Phase 2 (Codex #552 R1 HIGH-2): the shutdown deadline
	 * signal reaches the finalizer's minutes turn + landing — true cancellation,
	 * no deadline-crossing Linear writes. */
	close(opts?: { signal?: AbortSignal }): Promise<void>;
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

	// FLY-1160 §4.2: the resident brain writes minutes onto a kickoff issue.
	// The Bridge Linear proxy is load-bearing when the brain is enabled — a
	// missing token is a fail-loud config error, not a silent bare surface.
	const brainEnabled = opts.brainManager !== undefined;
	const apiToken = env.FLYWHEEL_API_TOKEN;
	if (brainEnabled && !apiToken) {
		throw new Error(
			"voice-bridge: FLYWHEEL_API_TOKEN unset — /eleven resident brain needs the Bridge Linear proxy (kickoff issue + minutes landing)",
		);
	}
	const bridgeUrl =
		env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL ?? "http://127.0.0.1:9876";
	const linear =
		brainEnabled && apiToken
			? makeLinearClient({
					bridgeUrl,
					apiToken,
					projectName: config.projectName,
					fetchImpl,
				})
			: undefined;
	const identityFile = brainEnabled
		? join(config.projectRoot, ".lead", eleven.leadId, "identity.md")
		: undefined;
	if (brainEnabled && identityFile && !existsSync(identityFile)) {
		// the persona source must exist — fail-loud at wire time, not mid-meeting
		throw new Error(
			`voice-bridge: /eleven leadId "${eleven.leadId}" identity file not found at ${identityFile} — the resident brain persona source`,
		);
	}

	// FLY-1160 §4.2-4 boot reconciliation: resume any landing a shutdown
	// deadline / crash cut mid-flight, before serving new meetings. Best-effort
	// (a failing envelope is kept for the next boot; never blocks startup).
	if (linear) {
		void reconcilePendingLandings({
			stateDir,
			linear,
			read: linear,
			commandName: eleven.commandName,
			log,
		}).catch((err) =>
			log(
				`[eleven] boot reconciliation error (non-fatal): ${String((err as Error).message ?? err)}`,
			),
		);
	}

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

	// FLY-1160 §4.2-4 (Codex #552 R2 HIGH-3): founder PRESENCE over the resident
	// VC drives the no-show decision (occupancy probe + voice-state join), NOT
	// audio. A founder who joined but stayed silent is present, never a no-show.
	const noShowMs = opts.noShowMs ?? DEFAULT_NO_SHOW_MS;
	let humanCount = 0;
	const founderJoinCbs = new Set<() => void>();
	const unsubVoiceState =
		brainEnabled && typeof deps.onVoiceStateUpdate === "function"
			? deps.onVoiceStateUpdate(orchestratorClient, (u) => {
					if (u.isBot) return;
					const delta = classifyVoiceDelta(u, config.voiceChannelId);
					if (delta === "join") {
						humanCount++;
						for (const cb of founderJoinCbs) cb();
					} else if (delta === "leave") {
						humanCount = Math.max(0, humanCount - 1);
					}
				})
			: undefined;
	/** seed occupancy so a founder ALREADY in the VC when /eleven starts counts
	 * as present (no false no-show). Best-effort — a probe failure stays 0. */
	const seedOccupancy = async (): Promise<void> => {
		if (!brainEnabled || typeof deps.voiceChannelHumanCount !== "function")
			return;
		try {
			humanCount = await deps.voiceChannelHumanCount(
				orchestratorClient,
				config.guildId,
				config.voiceChannelId,
			);
		} catch (err) {
			log(
				`[eleven] occupancy seed failed (staying 0): ${String((err as Error).message ?? err)}`,
			);
		}
	};

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

	// FLY-1160: kickoff issue (brain enabled) — the resident brain lands
	// minutes here. Absent brain = the pre-1160 bare surface, no issue.
	const createIssue = async (title: string) => {
		if (!linear) return { identifier: "", url: undefined };
		return linear.createIssue(title);
	};

	const command = new ElevenCommand({
		commandName: eleven.commandName,
		slot: room.slot,
		joinUrl: `https://discord.com/channels/${config.guildId}/${config.voiceChannelId}`,
		preflight,
		createIssue,
		founderName: env.FLYWHEEL_FOUNDER_NAME || "Annie",
		pingFounder: (text) =>
			deps.sendMessage(orchestratorClient, config.voiceChannelId, text),
		log,
		stopSession: async () => {
			if (!activeSession) return false;
			await activeSession.stop("manual");
			activeSession = null;
			return true;
		},
		startSession: async ({ sessionId, issueId, topic }) => {
			let orchestratorConn: unknown;
			let noShowTimer: ReturnType<typeof setTimeout> | undefined;
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
			const transcriptPath = elevenTranscriptPath(stateDir, sessionId);
			const brainKey = `eleven:${sessionId}`;
			// FLY-1160 §4.2-3 (Codex #552 R1 HIGH-4): pre-heat is a start() step,
			// NOT best-effort here. A preheat failure THROWS → start-failure →
			// abort-close the issue (no dead meeting whose shim turns all 404).
			// The captured brain ref is used for the minutes turn so the finalizer
			// can SUSPEND the key (BrainPort 404s new shim turns) without hiding
			// the brain from the daemon's own final turn (HIGH-5).
			let brainRef: ReturnType<ResidentBrainManager["open"]> | null = null;
			const preheat = (): void => {
				if (!opts.brainManager || !identityFile) return;
				brainRef = opts.brainManager.open(brainKey, {
					claudeBin: opts.claudeBin ?? "claude",
					identityFile,
					readOnlyRoot: config.projectRoot,
					model: config.brain?.model,
					sessionPreamble: topic
						? `本场 /eleven 语音会话的话题:${topic}`
						: undefined,
				});
			};

			// FLY-1160 §4.2-4: minutes = the resident brain's FINAL turn on the
			// CAPTURED ref (reachable even while the key is suspended). Test seam
			// wins; brain gone/failed → null → the finalizer degrades to journal.
			// The shutdown-deadline signal cancels the turn (§3.3 Phase 2).
			const generateMinutes = async (
				signal?: AbortSignal,
			): Promise<ElevenMinutes | null> => {
				if (opts.generateMinutes) return opts.generateMinutes(sessionId);
				if (!brainRef) return null;
				try {
					let text = "";
					for await (const chunk of brainRef.respond(
						{ text: MINUTES_PROMPT, history: [] },
						{ signal: signal ?? new AbortController().signal },
					)) {
						text += chunk;
					}
					if (!text.trim()) return null;
					return { recapText: text.trim(), quotes: journalQuotes() };
				} catch (err) {
					log(
						`[eleven] resident minutes turn failed (degrading to journal): ${String((err as Error).message ?? err)}`,
					);
					return null;
				}
			};

			// degraded-minutes quote source: the founder's verbatim lines.
			const journalQuotes = (): { ts: string; text: string }[] =>
				readElevenTranscriptRows(transcriptPath)
					.filter((r) => r.role === "user")
					.map((r) => ({ ts: r.ts, text: r.text }));

			const landing = linear
				? new ElevenLanding({
						stateDir,
						sessionId,
						linear,
						commandName: eleven.commandName,
						log,
					})
				: undefined;

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
				...(issueId ? { issueId } : {}),
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
				// FLY-1160 §4.2-4 finalizer seams (present only with the brain)
				...(landing ? { landing } : {}),
				...(brainEnabled ? { generateMinutes } : {}),
				...(brainEnabled ? { journalQuotes } : {}),
				...(linear ? { linearAbort: linear } : {}),
				...(brainEnabled ? { preheat } : {}),
				...(brainEnabled
					? {
							// ④ interrupt the in-flight brain turn + await its barrier;
							// ② suspend the key so BrainPort 404s new shim turns.
							brainInterrupt: async () => {
								await brainRef?.interrupt();
							},
							suspendBrain: () => opts.brainManager?.suspend(brainKey),
						}
					: {}),
				log,
				onEnded: () => {
					if (activeSession === session) activeSession = null;
					// disarm the no-show watch for this meeting.
					if (noShowTimer) clearTimeout(noShowTimer);
					noShowTimer = undefined;
					founderJoinCbs.delete(onFounderJoin);
					// who spawns reaps (FLY-1148): close the resident brain for
					// this meeting — after the finalizer's minutes turn is done.
					void opts.brainManager?.close(brainKey).catch(() => {});
				},
			});

			// FLY-1160 §4.2-4 (Codex #552 R2 HIGH-3): arm the presence-based
			// no-show watch. Seed occupancy (a founder already in the VC counts
			// as present); a voice-state JOIN disarms it; the timer fires →
			// stop("no-show") only if the founder never joined.
			const onFounderJoin = (): void => {
				if (noShowTimer) {
					clearTimeout(noShowTimer);
					noShowTimer = undefined;
				}
			};
			if (brainEnabled && noShowMs > 0) {
				await seedOccupancy();
				if (humanCount > 0) {
					// founder already present — never a no-show
				} else {
					founderJoinCbs.add(onFounderJoin);
					noShowTimer = setTimeout(() => {
						noShowTimer = undefined;
						founderJoinCbs.delete(onFounderJoin);
						if (activeSession === session) {
							log("[eleven] no-show — founder never joined; abort-closing");
							void session.stop("no-show");
						}
					}, noShowMs);
					noShowTimer.unref?.();
				}
			}

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
		close: async (closeOpts?: { signal?: AbortSignal }) => {
			// daemon shutdown → the finalizer runs the minutes+landing under the
			// two-phase shutdown budget (FLY-1160 §3.3). The deadline signal is
			// TRUE cancellation: it reaches the minutes turn + landing writes.
			await activeSession?.stop(
				"shutdown",
				closeOpts?.signal ? { signal: closeOpts.signal } : {},
			);
			activeSession = null;
			unsubVoiceState?.();
		},
	};
}
