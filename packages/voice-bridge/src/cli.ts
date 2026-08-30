/**
 * voice-bridge daemon entry (FLY-545).
 *
 * PR-1: fail-fast config + playback preflight + /health endpoint +
 * BotRegistry login (orchestrator + Note-taker + Lead bots) + the Note-taker
 * resident in the #huddle VC. PR-2 wires the /glaw meeting on top: guild
 * slash command, founder voiceState tracking, and per-meeting assembly
 * (wireMeeting: LeadLines/feed/router/ladder/conclusion + HuddleSession).
 *
 * Ops discipline mirrors the Bridge daemon: bounded shutdown on
 * SIGTERM/SIGINT, single-instance guarded by the wrapper (PID file + port
 * preflight on the health port), secrets only via env (never argv/logs).
 */
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AudioFormat,
	createGenaiTransport,
	EdgeTts,
	GeminiLiveBackend,
	ResidentBrainManager,
} from "flywheel-voice-core";
import {
	type AssistantModeConfig,
	loadAssistantConfig,
} from "./assistant/config.js";
import {
	type AssistantRuntime,
	wireAssistantMode,
} from "./assistant/wiring.js";
import { ensureDefaultCues } from "./audio/defaultCues.js";
import { EarsReceiver } from "./audio/EarsReceiver.js";
import { LeadSpeaker } from "./audio/LeadSpeaker.js";
import type { TextTurnSpeaker } from "./audio/TextTurnMouth.js";
import { BotRegistry } from "./bots/BotRegistry.js";
import { createDiscordDeps, type DiscordDeps } from "./bots/discordWiring.js";
import { BrainPort } from "./brain/BrainPort.js";
import { type HuddleBridgeConfig, loadHuddleBridgeConfig } from "./config.js";
import { TivPresenter } from "./discord/TivPresenter.js";
import { type ElevenModeConfig, loadElevenConfig } from "./eleven/config.js";
import { type ElevenRuntime, wireElevenMode } from "./eleven/wiring.js";
import { GlawCommand } from "./huddle/GlawCommand.js";
import { createHuddleTiv } from "./huddle/huddleTiv.js";
import { createReadOnlyLeadBrain } from "./huddle/ReadOnlyLeadBrain.js";
import { summarizeViaResidentBrain } from "./huddle/residentMinutes.js";
import {
	type MeetingPorts,
	type WiredMeeting,
	wireMeeting,
} from "./huddle/wireMeeting.js";
import { BridgeLinearClient } from "./linear/BridgeLinearClient.js";
import { type BinaryProbe, verifyPlaybackStack } from "./preflight.js";
import { type RoomEarsRuntime, wireRoomEars } from "./roomEars.js";
import { VoiceRoomRuntime } from "./VoiceRoomRuntime.js";

export interface VoiceBridgeRuntime {
	config: HuddleBridgeConfig;
	close: () => Promise<void>;
	/** FLY-1160: synchronous SIGKILL of every resident brain child — the
	 * supervisor's last-resort reap (never leaves a live claude behind). */
	forceKillAll: () => void;
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

const BRAIN_PORT_TOKEN_ENV = "FLYWHEEL_BRAIN_PORT_TOKEN";

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
	if (assistant?.advanced) {
		throw new Error(
			"voice-bridge: huddle.assistant.advanced was retired by FLY-2105; remove huddle.assistant.advanced",
		);
	}

	// playback stack dies here, not after a bot already joined the VC.
	// (GEMINI_API_KEY / FLYWHEEL_API_TOKEN / DISCORD_OWNER_USER_ID fail-fast
	// inside loadHuddleBridgeConfig — the PR-1 warning got its PR-2 upgrade.)
	await verifyPlaybackStack(config.ffmpegBin, opts.probe);
	if (
		!process.env.GEMINI_API_KEY &&
		!opts.assistantWiring?.createConversation &&
		assistant
	) {
		// FLY-967: assistant mode opens a real Gemini Live session per meeting
		// — a missing key must kill the deploy at startup, not mid-meeting.
		// (The /glaw loop's own key arrives via config.geminiApiKey, which
		// loadHuddleBridgeConfig already fail-fasts on — no warn path left.)
		throw new Error(
			"voice-bridge: GEMINI_API_KEY unset but huddle.assistant is configured — /gemini would fail at first use",
		);
	}
	// FLY-1159 (Codex R3): every enabled voice command registers its own
	// interaction handler on the SAME orchestrator client — a duplicate name
	// would attach two handlers to one command (double deferReply). Refuse to
	// assemble. Checked BEFORE the advanced env preflight so a misconfigured
	// name never hides behind an env error. The /glaw huddle command
	// (config.commandName) is always enabled on this chassis and rides the
	// same client — it belongs in the set (Codex R41: a colliding custom
	// name deterministically double-handled one interaction).
	const voiceCommandNames = [
		config.commandName,
		assistant ? (assistant.commandName ?? "gemini") : null,
		eleven ? eleven.commandName : null,
	].filter((n): n is string => n != null);
	const dupCommandName = voiceCommandNames.find(
		(n, i) => voiceCommandNames.indexOf(n) !== i,
	);
	if (dupCommandName) {
		throw new Error(
			`voice-bridge: duplicate voice command name "/${dupCommandName}" — huddle / assistant / assistant.advanced / eleven command names must all be unique (each registers its own interaction handler on the orchestrator bot)`,
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
	// Discord wiring. Phase B binds /glaw keys onto this manager.
	const brainManager = new ResidentBrainManager({
		maxSessions: config.brain?.maxSessions ?? 4,
	});
	let brainPort: BrainPort | undefined;

	let activeMeeting: WiredMeeting | undefined;
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

		// ---- PR-2: the /glaw meeting face on top of the residency ----
		const orchClient = registry.client(ORCHESTRATOR);
		const linear = new BridgeLinearClient({
			bridgeUrl: config.bridgeUrl,
			apiToken: config.apiToken,
			projectName: config.projectName,
		});
		const backend = new GeminiLiveBackend({
			transport: createGenaiTransport({ apiKey: config.geminiApiKey }),
			profile: { model: config.geminiModel, asyncFunctionCalling: true },
		});
		const defaultCues = ensureDefaultCues();
		// shared TivPresenter (FLY-1065) + the huddle adapter over it (FLY-545:
		// presence vocabulary, per-lead caption names, awaited conclusion cards).
		const tivChannel = deps.tivPort(orchClient, config.voiceChannelId);
		const tiv = createHuddleTiv({
			presenter: new TivPresenter({
				deps: {
					send: async (text) => {
						await tivChannel.post(text);
					},
					sendForId: async (text) => ({
						messageId: (await tivChannel.post(text)).id,
					}),
					edit: (messageId, text) => tivChannel.edit(messageId, text),
				},
				log,
			}),
			postCard: async (content) => {
				await tivChannel.post(content);
			},
		});
		// ONE room mutex for the whole VC (FLY-1006 S5b): /glaw, /gemini and
		// /eleven all contend for the SAME slot — separate slots would let two
		// modes go live at once and founder audio would feed two sessions.
		const room = new VoiceRoomRuntime();
		const slot = room.slot;

		// mentioned bot user → configured Lead (built after login: user ids are
		// only known once each Lead client is ready).
		const leadByUserId = new Map<string, string>();
		for (const lead of config.leads) {
			const uid = (registry.client(lead.agentId) as { user?: { id?: string } })
				.user?.id;
			if (uid) leadByUserId.set(uid, lead.agentId);
		}

		// ONE resident EarsReceiver for the daemon's lifetime — its callbacks
		// route to whatever meeting is active. Attaching per meeting would pile
		// listeners onto the same resident connection's speaking emitter every
		// /glaw (Codex R1 MEDIUM: detach() flags but cannot remove them).
		const FMT16K: AudioFormat = {
			encoding: "pcm16",
			sampleRateHz: 16_000,
			channels: 1,
		};
		const ears = new EarsReceiver({
			speaking: deps.speakingEvents(earsConnection),
			subscribe: deps.subscribeManual(earsConnection),
			createDecoder: deps.createDecoder,
			isHuman: deps.isHumanFactory(registry.client(NOTE_TAKER), config.guildId),
			allowUserIds: config.allowUserIds,
			backchannelMs: config.backchannelMs,
			bargeInMinRms: config.bargeInMinRms,
			onFrame: (frame) =>
				activeMeeting?.huddle.handleFounderFrame(frame, FMT16K),
			// QA R2 F2b/F3: the Discord-side speaking-end is the RELIABLE
			// "she stopped talking" signal (Gemini's server VAD misses it under
			// Discord silence-suppression) — it drives the thinking cue AND the
			// founder-transcript flush. This was never wired before: no cue, no
			// founder captions, and the conclude/confirm flow never saw her words.
			onSpeakingEnd: () => activeMeeting?.huddle.handleFounderSpeechStopped(),
			onBargeIn: () => activeMeeting?.huddle.handleBargeIn(),
			onError: (err, userId) =>
				log(`ears pipeline error (${userId}): ${err.message}`),
		});
		ears.attach();

		const startMeeting = async (
			invocation: Parameters<
				ConstructorParameters<typeof GlawCommand>[0]["onMeet"]
			>[0],
		): Promise<void> => {
			const leadConns: unknown[] = [];
			const destroyLeadConns = () => {
				for (const conn of leadConns) {
					try {
						(conn as { destroy?: () => void }).destroy?.();
					} catch {
						// best-effort — a dead connection object must not mask the
						// original failure.
					}
				}
			};

			// FLY-1160 §4.1-3: the resident mouth synthesizes per-sentence via
			// edge-tts (command overridable for deploys that vend it differently).
			const residentTts =
				config.brain?.mode === "resident"
					? new EdgeTts({ command: "edge-tts" })
					: undefined;

			// FLY-1160 §4.1: resident mode ONLY. Open the line's resident brain on
			// the singleton manager (the daemon is the sole owner + reaper, FLY-1148)
			// and build its edge-tts text speaker over the line's player. Absent in
			// gemini mode → wireMeeting keeps the current Gemini-thinks path.
			const createResidentLine: MeetingPorts["createResidentLine"] =
				config.brain?.mode === "resident" && residentTts
					? (input) => {
							const full = config.leads.find(
								(l) => l.agentId === input.lead.agentId,
							);
							const identityFile =
								input.lead.identityFile ??
								join(
									homedir(),
									".flywheel",
									"leads",
									input.lead.agentId,
									"identity.md",
								);
							const brain = brainManager.open(input.key, {
								claudeBin: config.claudeBin,
								identityFile,
								sessionPreamble: input.sessionPreamble,
								readOnlyRoot: config.projectRoot,
								...(config.brain?.model ? { model: config.brain.model } : {}),
								onEvent: input.onEvent,
							});
							const leadSpeaker = new LeadSpeaker({
								player: input.player,
								createResource: input.createResource,
								tts: residentTts,
								...(full?.voice?.voiceId ? { voice: full.voice.voiceId } : {}),
							});
							const speaker: TextTurnSpeaker = {
								speak: (text) =>
									leadSpeaker
										.speak({ kind: "text", text })
										.then((r) => ({ cancelled: r.cancelled })),
								stop: () => leadSpeaker.stop(),
							};
							return { brain, speaker };
						}
					: undefined;

			try {
				const meeting = await wireMeeting(
					invocation,
					config.leads,
					{
						projectName: config.projectName,
						projectRoot: config.projectRoot,
						// QA R3 ③: cues are default-ON — unset paths fall back to
						// synthesized tones instead of silence.
						earconPath: config.earconPath ?? defaultCues.earconPath,
						fillerPath: config.fillerPath ?? defaultCues.fillerPath,
						transcriptDir: join(
							homedir(),
							".flywheel",
							"huddle",
							"transcripts",
						),
						// FLY-1160 §4.1: absent/gemini = current behavior; resident
						// flips /glaw onto the resident Claude brain.
						...(config.brain?.mode ? { mode: config.brain.mode } : {}),
					},
					{
						joinLeadVoice: async (leadId) => {
							const conn = await registry.join(leadId, {
								guildId: config.guildId,
								channelId: config.voiceChannelId,
								selfMute: false,
								selfDeaf: true,
							});
							leadConns.push(conn);
							return {
								player: deps.createPlayer(conn),
								createResource: deps.createResource,
							};
						},
						createConversation: async (opts) => {
							const create = backend.createConversation?.bind(backend);
							if (!create) throw new Error("backend cannot converse");
							return create(opts);
						},
						createBrain: (lead) =>
							createReadOnlyLeadBrain({
								claudeBin: config.claudeBin,
								identityFile:
									lead.identityFile ??
									join(
										homedir(),
										".flywheel",
										"leads",
										lead.agentId,
										"identity.md",
									),
								projectRoot: config.projectRoot,
								timeoutMs: config.brainTimeoutMs,
							}),
						...(createResidentLine ? { createResidentLine } : {}),
						...(config.brain?.mode === "resident"
							? {
									closeResidentLine: (key: string) => brainManager.close(key),
								}
							: {}),
						summarize: async (journalSnapshot) => {
							// FLY-1160 §4.1-6: in resident mode the HOST's resident session
							// writes the minutes as a final turn (it already holds the whole
							// conversation); the journal snapshot is the crash fallback.
							if (config.brain?.mode === "resident") {
								// §4.1-6 + Codex R1 HIGH-3: host resident final-turn minutes,
								// with the raw-journal fallback on ANY failure (see helper).
								return summarizeViaResidentBrain(
									brainManager.get(
										`${invocation.issue.identifier}:${invocation.hostLeadId}`,
									),
									journalSnapshot,
								);
							}
							const host = config.leads.find(
								(l) => l.agentId === invocation.hostLeadId,
							);
							const brain = createReadOnlyLeadBrain({
								claudeBin: config.claudeBin,
								identityFile:
									host?.identityFile ??
									join(
										homedir(),
										".flywheel",
										"leads",
										invocation.hostLeadId,
										"identity.md",
									),
								projectRoot: config.projectRoot,
								timeoutMs: Math.max(config.brainTimeoutMs, 120_000),
								voiceContext:
									"You are writing the meeting summary for the kickoff issue. Output MARKDOWN: a short 结论 section, then an Action items list. EVERY conclusion/action item must quote the founder's exact words with the [timestamp] from the journal (可追溯). Chinese, concise.",
							});
							let out = "";
							const ac = new AbortController();
							for await (const chunk of brain.respond(
								{
									text: `以下是本场 huddle 的会议记录(带时间戳),请产出 summary + action items:\n\n${journalSnapshot}`,
									history: [],
								},
								{ signal: ac.signal },
							)) {
								out += chunk;
							}
							if (!out.trim())
								throw new Error("summary brain returned nothing");
							return out;
						},
						worktree: {
							create: async (opts) => {
								const { WorktreeManager } = await import(
									"flywheel-edge-worker"
								);
								const info = await new WorktreeManager().create(opts);
								return { path: info.worktreePath };
							},
						},
						linear,
						tiv,
						release: async () => {
							// the resident ears stay attached (single lifetime listener
							// set); only the per-meeting Lead connections come down.
							destroyLeadConns();
							// FLY-1160 §4.1-7: reap THIS meeting's resident brains (the
							// daemon spawned them, so the daemon reaps them — FLY-1148).
							// manager.close confirms each child's exit (EOF→TERM→KILL).
							if (config.brain?.mode === "resident") {
								for (const p of invocation.participants) {
									await brainManager
										.close(`${invocation.issue.identifier}:${p.leadId}`)
										.catch(() => undefined);
								}
							}
							slot.release("glaw", invocation.issue.identifier);
							activeMeeting = undefined;
							log(`meeting ${invocation.issue.identifier} released`);
						},
						log,
					},
				);
				activeMeeting = meeting;
				meeting.huddle.start();
				log(`meeting ${invocation.issue.identifier} assembling`);
				// initial-check (QA R2 follow-on): if she is ALREADY in the VC
				// when /glaw fires, no voiceStateUpdate will ever arrive — probe
				// once and enter live directly, or the meeting no-show-aborts
				// with her sitting right there. FOUNDER-specific and cache-read
				// (Codex R14 HIGH-2: humans>0 admitted any bystander, and a REST
				// probe could return stale "present" after she already left).
				void deps
					.userVoiceChannelId(orchClient, config.guildId, config.founderUserId)
					.then((channelId) => {
						if (channelId === config.voiceChannelId) {
							meeting.huddle.handleFounderVoiceState(true);
						}
					})
					.catch((err) =>
						log(
							`initial VC presence probe failed (voiceStateUpdate remains the path): ${err instanceof Error ? err.message : String(err)}`,
						),
					);
			} catch (err) {
				// mid-assembly failure: some Lead bots may already be in the VC —
				// bring them down before surfacing (Codex R1 HIGH: only the slot
				// was released; ears/conns leaked).
				destroyLeadConns();
				// FLY-1160 Codex R1 HIGH-2 (defense in depth): wireMeeting reaps the
				// brains IT opened, but close every participant key here too in case the
				// failure landed outside its guard — manager.close is idempotent (an
				// unopened key is a no-op).
				if (config.brain?.mode === "resident") {
					for (const p of invocation.participants) {
						await brainManager
							.close(`${invocation.issue.identifier}:${p.leadId}`)
							.catch(() => undefined);
					}
				}
				throw err;
			}
		};

		const glaw = new GlawCommand({
			commandName: config.commandName,
			guildId: config.guildId,
			voiceChannelId: config.voiceChannelId,
			founderUserId: config.founderUserId,
			moveMembers: config.moveMembers,
			linear: { createIssue: (input) => linear.createIssue(input) },
			resolveLead: (userId) => {
				const leadId = leadByUserId.get(userId);
				return leadId ? { leadId } : undefined;
			},
			isBusy: () => slot.current() !== null,
			moveFounderToVc: () =>
				deps.moveMemberDetailed(
					orchClient,
					config.guildId,
					config.founderUserId,
					config.voiceChannelId,
				),
			onMeet: async (invocation) => {
				const acquired = slot.acquire("glaw", invocation.issue.identifier);
				if (!acquired.ok) {
					tiv.warn(acquired.message);
					return;
				}
				try {
					await startMeeting(invocation);
				} catch (err) {
					slot.release("glaw", invocation.issue.identifier);
					const m = err instanceof Error ? err.message : String(err);
					log(`meeting start failed: ${m}`);
					tiv.warn(
						`这场没开起来:${m} — 立项 issue ${invocation.issue.identifier} 留着,修好再 /${config.commandName}。`,
					);
				}
			},
			now: () => new Date(),
			log,
		});
		await deps.registerGuildCommand(
			orchClient,
			config.guildId,
			glaw.commandDefinition(),
		);
		deps.onChatInteraction(orchClient, config.commandName, (interaction) => {
			// FLY-1160 §3.3 Phase 1: no NEW meetings once shutdown begins —
			// and the interaction is ACKNOWLEDGED (Codex R33: a bare return
			// leaves the founder staring at "application did not respond").
			if (state.shuttingDown) {
				void (
					interaction as {
						reply(p: { content: string; ephemeral?: boolean }): Promise<void>;
					}
				)
					.reply({ content: "语音服务正在关闭,稍后再试。", ephemeral: true })
					.catch(() => undefined);
				return;
			}
			void glaw.handleInteraction(interaction).catch((err) => {
				log(
					`interaction failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		});
		deps.onVoiceStateUpdate(orchClient, (u) => {
			if (u.userId !== config.founderUserId) return;
			activeMeeting?.huddle.handleFounderVoiceState(
				u.toChannelId === config.voiceChannelId,
			);
		});
		log(`/${config.commandName} registered on guild ${config.guildId}`);

		// FLY-1006 S5b: ONE shared room runtime (slot + resident-ears routing)
		// for every voice mode — /gemini and /eleven contend for the SAME slot
		// and consume the SAME physical receiver.
		if (assistant || eleven) {
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
					// FLY-1160 §4.2: the resident brain the /eleven meeting speaks
					// with — the SAME daemon-owned manager the BrainPort serves.
					brainManager,
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
		// reaped before the error propagates (FLY-1148: who spawns, reaps) —
		// an earlier step's rejection must never skip the brain cleanup.
		try {
			await new Promise<void>((resolve) => health.close(() => resolve()));
			await registry.destroyAll();
		} finally {
			try {
				if (brainPort) await brainPort.close();
			} finally {
				await brainManager.closeAll();
			}
		}
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
		// Phase 2 (landing, bounded budget): the /glaw meeting teardown +
		// assistant/eleven landing + Discord teardown + health close. A Phase-2
		// failure must NEVER skip Phase 3 (Codex #550 R1 HIGH) — log and fall
		// through to the reaping.
		let phase2Timer: NodeJS.Timeout | undefined;
		const phase2Abort = new AbortController();
		try {
			await Promise.race([
				(async () => {
					// FLY-1160 Phase B: the /glaw meeting's resident finalizer runs
					// inside this same budget (host final-turn minutes + landing);
					// the deadline signal is threaded in §4.1 dispose wiring.
					await activeMeeting?.dispose().catch(() => undefined);
					await assistantRuntime?.close({ signal: phase2Abort.signal });
					// FLY-1160 §3.3 Phase 2 (Codex #552 R1 HIGH-2): /eleven's
					// finalizer must see the SAME deadline signal — an un-cancelled
					// Eleven landing could write Linear past Phase 3's brain close.
					await elevenRuntime?.close({ signal: phase2Abort.signal });
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
			// exit is confirmed before close() resolves.
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
