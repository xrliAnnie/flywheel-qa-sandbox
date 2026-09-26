/**
 * Assistant-mode runtime wiring (FLY-967 QA-B1) — the piece that makes
 * /gemini actually INVOKABLE on the running voice-bridge daemon, instead of
 * dormant library code:
 *
 *   projects.json huddle.assistant → resolveAssistantConfig →
 *   /gemini guild command + interaction dispatch (orchestrator bot) →
 *   GeminiCommand → AssistantSession, with REAL dependencies (BotRegistry
 *   voice presence, resident Note-taker EarsReceiver, AssistantSpeaker on a
 *   real AudioPlayer, Bridge Linear HTTP, BriefingEngine on a disk cache,
 *   voice-core Gemini Live session behind the TalkSessionRotator).
 *
 * Everything Discord/Gemini-real stays behind injected seams (DiscordDeps +
 * an optional conversation-factory override), so the assembly logic is unit
 * tested; the real-SDK glue follows the discordWiring discipline (validated
 * by the staged E2E, not unit tests).
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type BrainAdapter,
	type ConversationSession,
	createGenaiTransport,
	GeminiLiveBackend,
	HeadlessClaudeBrain,
	JsonlTranscriptSink,
	type ResumeHandle,
	resolveConfig as resolveVoiceCoreConfig,
	TalkSessionRotator,
} from "flywheel-voice-core";
import { superviseVoiceConnection } from "../audio/VoiceConnSupervisor.js";
import type { DiscordDeps } from "../bots/discordWiring.js";
import type { HuddleBridgeConfig } from "../config.js";
import { TivPresenter } from "../discord/TivPresenter.js";
import { wireRoomEars } from "../roomEars.js";
import { VoiceRoomRuntime } from "../VoiceRoomRuntime.js";
import { AssistantLanding } from "./AssistantLanding.js";
import { AssistantSession, type ConversationLike } from "./AssistantSession.js";
import { AssistantSpeaker } from "./AssistantSpeaker.js";
import { buildAdvancedDelegateTool } from "./advanced.js";
import { BriefingEngine, type IssuesPage } from "./BriefingEngine.js";
import {
	type AssistantModeConfig,
	DEFAULT_ADVANCED_COMMAND,
} from "./config.js";
import { GeminiCommand } from "./GeminiCommand.js";
import { buildAssistantTools } from "./tools.js";

const ORCHESTRATOR = "orchestrator";

/** spoken-register discipline (plan §5.4) — composed AFTER the briefing. */
const SYSTEM_HINT = [
	"你是这个团队的会议助理。用口语短句回答,零工程黑话;长答先用一句话 ack。",
	"项目事实必须走 lookup_issue / board_snapshot / ask_lead 查,不许编。",
	"任何写动作只口头记下(「我记下了,X 会走正式批准流程」),绝不执行——执行永远在正式批准流程里。",
	"她说「结束/就这样」= 进入收尾 recap:逐条念要点,问她「对吗?」。",
].join("\n");

export interface WireAssistantOptions {
	config: HuddleBridgeConfig;
	assistant: AssistantModeConfig;
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
	/** the resident Note-taker voice connection (ears). */
	earsConnection: unknown;
	/** FLY-1006 S5b: the daemon's shared room runtime (slot + ears routing).
	 * When passed, the daemon owns the physical ears (wireRoomEars) and this
	 * wiring only consumes; absent = FLY-967 behavior (own room + own ears). */
	room?: VoiceRoomRuntime;
	env?: NodeJS.ProcessEnv;
	log?: (msg: string) => void;
	/** test seam: replaces the real Gemini conversation factory. FLY-1065: the
	 * factory receives the assistant sessionId so the JSONL sink lands at
	 * assistantTranscriptPath(stateDir, sessionId) — the path the landing reads.
	 * FLY-1159: sessions started via the advanced command carry advanced=true
	 * (the real factories ignore the flag — the plain one is built from a
	 * config with `advanced` stripped, so /gemini can never mount the delegate). */
	createConversation?: (
		systemPreamble: string,
		opts: { sessionId: string; advanced?: boolean },
	) => Promise<ConversationLike>;
	fetchImpl?: typeof fetch;
	/** test seam: state dir override (default ~/.flywheel/voice-assistant). */
	stateDir?: string;
	/** FLY-1160 §3.3 Phase 1: when true, new /gemini invocations are refused
	 * (命令下架) — the daemon is shutting down and must not start meetings. */
	isShuttingDown?: () => boolean;
}

export interface AssistantRuntime {
	commandName: string;
	/** FLY-1159 founder contract (2026-07-11): the separate delegate-carrying
	 * voice command; undefined = advanced mode off (only /gemini registered). */
	advancedCommandName?: string;
	/** FLY-1160 §3.3 Phase 2: the shutdown landing budget's AbortSignal —
	 * once aborted the landing performs NO further external writes and never
	 * reports success (true cancellation, not stop-waiting). */
	close(opts?: { signal?: AbortSignal }): Promise<void>;
}

export async function wireAssistantMode(
	opts: WireAssistantOptions,
): Promise<AssistantRuntime> {
	const env = opts.env ?? process.env;
	const log =
		opts.log ?? ((msg: string) => console.log(`[voice-bridge] ${msg}`));
	const { config, assistant, deps, registry } = opts;

	// fail-fast: assistant mode ON means these are load-bearing, not optional.
	const apiToken = env.FLYWHEEL_API_TOKEN;
	if (!apiToken) {
		throw new Error(
			"voice-bridge: FLYWHEEL_API_TOKEN unset — /gemini needs the Bridge Linear proxy (briefing + tools + landing)",
		);
	}
	const bridgeUrl =
		env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL ?? "http://127.0.0.1:9876";
	if (!opts.createConversation && !env.GEMINI_API_KEY) {
		throw new Error(
			"voice-bridge: GEMINI_API_KEY unset — /gemini opens a Gemini Live session per meeting",
		);
	}

	if (assistant.assistantToken) {
		// resolved+validated by config, but v1 always speaks through the
		// orchestrator bot (plan D2 default) — silently ignoring a configured
		// dedicated bot would be a lie (Codex R3 LOW). Reject until wired.
		throw new Error(
			"voice-bridge: huddle.assistant.assistantBotTokenEnv is configured, but the dedicated assistant bot is not wired yet (v1 speaks through the orchestrator bot) — drop the key for now",
		);
	}

	const fetchImpl = opts.fetchImpl ?? fetch;
	const stateDir =
		opts.stateDir ??
		join(homedir(), ".flywheel", "voice-assistant", config.projectName);
	mkdirSync(stateDir, { recursive: true });

	// ---- Bridge Linear proxy (projectName-scoped on EVERY call) ----
	const linear = makeLinearClient({
		bridgeUrl,
		apiToken,
		projectName: config.projectName,
		fetchImpl,
	});

	// ---- briefing: pre-generated + cached, refresh loop starts now ----
	const briefing = new BriefingEngine({
		projectName: config.projectName,
		projectRoot: config.projectRoot,
		config: assistant.briefing,
		cachePath: join(stateDir, "voice-briefing.cache.json"),
		fetchIssues: (p) =>
			linear.listIssues(p.states, p.limit) as Promise<IssuesPage>,
		log,
	});
	briefing.start();

	// ---- founder presence over the resident VC ----
	const orchestratorClient = registry.client(ORCHESTRATOR);
	let humanCount = 0;
	void deps
		.voiceChannelHumanCount(
			orchestratorClient,
			config.guildId,
			config.voiceChannelId,
		)
		.then((n) => {
			humanCount = n;
			log(`[presence] humanCount seeded=${n} (boot occupancy)`);
		})
		.catch((err) => {
			log(
				`[presence] humanCount seed FAILED (staying 0): ${String((err as Error).message ?? err)}`,
			);
		});
	const founderJoinCbs = new Set<() => void>();
	const founderLeaveCbs = new Set<() => void>();
	// round-5: this chain was completely blind on the real machine — every
	// delta, count mutation and subscriber fan-out is now in the venue log.
	const unsubVoiceState = deps.onVoiceStateUpdate(orchestratorClient, (u) => {
		const delta = classifyVoiceDelta(u, config.voiceChannelId);
		log(
			`[presence] voiceState user=${u.userId} bot=${u.isBot} ${u.fromChannelId ?? "-"} -> ${u.toChannelId ?? "-"} delta=${delta} humanCount=${humanCount} joinSubs=${founderJoinCbs.size}`,
		);
		if (u.isBot) return;
		if (delta === "join") {
			humanCount++;
			log(
				`[presence] JOIN — humanCount=${humanCount}, firing ${founderJoinCbs.size} founder-join subscriber(s)`,
			);
			for (const cb of founderJoinCbs) cb();
		} else if (delta === "leave") {
			humanCount = Math.max(0, humanCount - 1);
			log(`[presence] LEAVE — humanCount=${humanCount}`);
			if (humanCount === 0) for (const cb of founderLeaveCbs) cb();
		}
	});

	// ---- shared room runtime (FLY-1006 S5b): ONE slot + ONE resident-ears
	// routing for every voice mode. The daemon passes the shared room (and
	// wires the physical receiver itself, once); a direct caller without a
	// room keeps the FLY-967 behavior — its own room + its own receiver.
	// /gemini registers no barge-in consumer, so the room's barge-in route
	// stays a no-op for it (v1 unchanged: Gemini server VAD is the main path).
	const room = opts.room ?? new VoiceRoomRuntime();
	const ownEars = opts.room
		? undefined
		: wireRoomEars({
				room,
				deps,
				earsConnection: opts.earsConnection,
				earsClient: registry.client("note-taker"),
				guildId: config.guildId,
				allowUserIds: config.allowUserIds,
				backchannelMs: config.backchannelMs,
				log,
			});

	const slot = room.slot;
	let activeSession: AssistantSession | null = null;

	const realConversationDeps = {
		bridgeUrl,
		apiToken,
		projectName: config.projectName,
		stateDir,
		log,
		fetchImpl,
		// FLY-1018 voice phase (Codex R1 MEDIUM): the delegate completion's
		// guaranteed landing surface. The spoken announce silently no-ops
		// mid-rotation and after the meeting closes (rotator's current
		// session is null) — Discord text into the voice channel's chat is
		// the always-there fallback, and it is what the spoken copy's
		// "详情见文字记录" promises.
		advancedSendText: (content: string) =>
			deps.sendMessage(orchestratorClient, config.voiceChannelId, content),
	};
	// FLY-1159 founder contract (2026-07-11): /gemini stays plain — its factory
	// is built from a config with `advanced` STRIPPED, so the plain command can
	// never mount the delegate by construction. The separate advanced command
	// gets its own factory built from the full config.
	const createConversation =
		opts.createConversation ??
		makeRealConversationFactory(
			env,
			{ ...assistant, advanced: undefined },
			realConversationDeps,
		);
	const createAdvancedConversation = assistant.advanced
		? (opts.createConversation ??
			makeRealConversationFactory(env, assistant, realConversationDeps))
		: null;

	// FLY-1065: the 545-planned shared TivPresenter replaces the inline v1 tiv —
	// captions render per turn in the channel (Annie's ask) and status lines
	// collapse into one edited anchor message (the 967 status spam fix).
	const tiv = new TivPresenter({
		deps: {
			send: (text) =>
				deps.sendMessage(orchestratorClient, config.voiceChannelId, text),
			sendForId: (text) =>
				deps.sendMessageForId(orchestratorClient, config.voiceChannelId, text),
			edit: (messageId, text) =>
				deps.editMessage(
					orchestratorClient,
					config.voiceChannelId,
					messageId,
					text,
				),
		},
		captions: assistant.captions !== false,
		assistantName: "助理",
		log,
	});

	type CreateConversationFn = NonNullable<
		WireAssistantOptions["createConversation"]
	>;
	const makeStartSession =
		(
			cmdName: string | undefined,
			create: CreateConversationFn,
			advanced: boolean,
		) =>
		async ({
			sessionId,
			issueId,
			topic,
		}: {
			sessionId: string;
			issueId: string;
			topic?: string;
		}) => {
			let orchestratorConn: unknown;
			// the real AudioPlayer exists only after the orchestrator joins the VC.
			// makeDeferredPlayer (round-5b) queues on() registrations until then
			// and logs LOUDLY if anything plays with no player — never silent.
			const deferredPlayer = makeDeferredPlayer(log);
			let disposeOrchWatch: (() => void) | undefined;
			const speaker = new AssistantSpeaker({
				player: deferredPlayer.player,
				createResource: deps.createResource,
				log,
			});
			const session = new AssistantSession({
				issueId,
				sessionId,
				topic,
				slot,
				briefing,
				createConversation: (p: string, o: { sessionId: string }) =>
					create(p, { ...o, advanced }),
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
						// FLY-967 round-3: the mouth died ASYNCHRONOUSLY after a clean
						// Ready on Annie's rounds (best hypothesis: Node v25 IP-discovery
						// error post-join) and nothing noticed. Supervise the connection:
						// log every transition, auto-rejoin, and go LOUD if it cannot
						// recover — never a silent death again.
						const orchHandle = deps.voiceConnHandle?.(orchestratorConn);
						disposeOrchWatch = orchHandle
							? superviseVoiceConnection(orchHandle, {
									label: "orchestrator",
									log,
									onFatal: (reason) =>
										log(
											`[voice-conn][orchestrator] the meeting mouth is DOWN (${reason}) — a fresh /${cmdName ?? "gemini"} round is required`,
										),
								})
							: undefined;
					},
					leave: () => {
						disposeOrchWatch?.();
						disposeOrchWatch = undefined;
						if (orchestratorConn) deps.leaveVoice(orchestratorConn);
						orchestratorConn = undefined;
						deferredPlayer.clear();
					},
					founderPresent: () => {
						const present = humanCount > 0;
						log(
							`[presence] founderPresent()=${present} (humanCount=${humanCount})`,
						);
						return present;
					},
					onFounderJoin: (cb) => {
						founderJoinCbs.add(cb);
						return () => founderJoinCbs.delete(cb);
					},
					onFounderLeave: (cb) => {
						founderLeaveCbs.add(cb);
						return () => founderLeaveCbs.delete(cb);
					},
				},
				ears: {
					onFrame: (cb) => room.onFrame(cb),
					onSpeakingEnd: (cb) => room.onSpeakingEnd(cb),
					onDown: (cb) => room.onDown(cb),
					onUp: (cb) => room.onUp(cb),
				},
				tiv,
				landing: new AssistantLanding({
					linear: {
						comment: (id, body, o) => linear.comment(id, body, o),
						closeIssue: (id, o) => linear.closeIssue(id, o),
					},
					commandName: cmdName,
					receiptPath: join(stateDir, `${sessionId}.landing-receipt.json`),
					transcriptPath: assistantTranscriptPath(stateDir, sessionId),
					log,
				}),
				linearAbort: {
					comment: (id, body) => linear.comment(id, body),
					closeIssue: (id) => linear.closeIssue(id),
				},
				log,
			});
			activeSession = session;
			await session.start();
		};

	const makeCommand = (
		name: string | undefined,
		create: CreateConversationFn,
		advanced: boolean,
	) =>
		new GeminiCommand({
			commandName: name,
			slot,
			joinUrl: `https://discord.com/channels/${config.guildId}/${config.voiceChannelId}`,
			createIssue: (title) => linear.createIssue(title),
			pingFounder: (text) =>
				deps.sendMessage(orchestratorClient, config.voiceChannelId, text),
			moveFounderToVc: env.DISCORD_OWNER_USER_ID
				? () =>
						deps.moveMember(
							orchestratorClient,
							config.guildId,
							env.DISCORD_OWNER_USER_ID as string,
							config.voiceChannelId,
						)
				: undefined,
			log,
			startSession: makeStartSession(name, create, advanced),
		});

	const command = makeCommand(assistant.commandName, createConversation, false);
	// FLY-1159 founder contract (2026-07-11): the delegate rides its OWN voice
	// command — /gemini never carries it. Both commands share the SessionSlot,
	// so the huddle still runs at most one assistant voice session at a time,
	// whichever command opened it.
	const advancedCommand = createAdvancedConversation
		? makeCommand(
				assistant.advanced?.commandName ?? DEFAULT_ADVANCED_COMMAND,
				createAdvancedConversation,
				true,
			)
		: null;

	const registerCommand = async (cmd: GeminiCommand, description: string) => {
		try {
			await deps.registerGuildCommand(orchestratorClient, config.guildId, {
				name: cmd.name,
				description,
			});
			log(`/${cmd.name} registered on guild ${config.guildId}`);
		} catch (err) {
			// a bot invited without the applications.commands scope cannot register
			// slash commands — LOUD, and the daemon stays up (the autostart QA seam
			// below still exercises the full meeting chain on staged rigs).
			log(
				`WARNING: /${cmd.name} slash registration failed (missing applications.commands scope on the bot invite?): ${String((err as Error).message ?? err)}`,
			);
		}
		deps.onChatCommand(orchestratorClient, cmd.name, (inv) => {
			// FLY-1160 §3.3 Phase 1: 命令下架 — no new meetings during shutdown.
			if (opts.isShuttingDown?.()) {
				log(`/${cmd.name} refused — daemon shutting down`);
				void inv
					.reply("voice-bridge 正在关闭,现在开不了新会 — 请稍后再试。")
					.catch(() => {});
				return;
			}
			void cmd
				.handle({ topic: inv.topic, reply: inv.reply })
				.catch((err) => log(`/${cmd.name} handle failed: ${err.message}`));
		});
	};
	await registerCommand(command, "纯 Gemini 语音助理 — 开一场带简报的快聊");
	if (advancedCommand) {
		await registerCommand(
			advancedCommand,
			"Gemini Advanced 语音版 — 开会+说一句派深活,完成口播+文字落地",
		);
	}

	// QA test-injection seam (allowUserIds precedent): a staged rig has no human
	// to click the slash command, so an env-gated autostart drives the SAME
	// GeminiCommand.handle path with a synthetic invocation whose replies land
	// on the TIV channel. Unset = zero behavior change.
	const autostartTopic = env.FLYWHEEL_GEMINI_AUTOSTART;
	if (autostartTopic !== undefined) {
		log(`autostart QA seam armed (topic: ${autostartTopic || "(none)"})`);
		setTimeout(() => {
			void command
				.handle({
					topic: autostartTopic || undefined,
					reply: async (text, o) =>
						deps.sendMessage(
							orchestratorClient,
							config.voiceChannelId,
							o?.joinUrl
								? `${text}
${o.joinUrl}`
								: text,
						),
				})
				.catch((err) => log(`autostart handle failed: ${err.message}`));
		}, 2_000).unref?.();
	}

	return {
		commandName: command.name,
		...(advancedCommand && { advancedCommandName: advancedCommand.name }),
		close: async (closeOpts?: { signal?: AbortSignal }) => {
			briefing.stop();
			unsubVoiceState();
			ownEars?.dispose();
			await activeSession?.stop(closeOpts);
			activeSession = null;
		},
	};
}

/**
 * Classify a voice-state update relative to the huddle VC. Mute/deaf/video
 * updates fire voiceStateUpdate with from === to — counting those as joins
 * drifts the presence counter and can suppress founder-leave teardown
 * (Codex R3 MEDIUM). Only true channel transitions count.
 */
/**
 * Deferred PlayerLike (round-5b): the real AudioPlayer exists only after the
 * orchestrator joins the VC, but the AssistantSpeaker is constructed before.
 * The old inline proxy silently dropped on() registrations and play() calls
 * made before join — nothing uses on() today, but "silently" is exactly the
 * failure class Annie's rounds kept hitting, so: on() queues and replays when
 * the real player arrives, play()/stop() without a player log LOUDLY, and
 * attachment itself is logged (timing evidence in the venue log).
 */
export function makeDeferredPlayer(log: (line: string) => void): {
	player: import("../audio/LeadSpeaker.js").PlayerLike;
	setReal(p: import("../audio/LeadSpeaker.js").PlayerLike): void;
	clear(): void;
} {
	type P = import("../audio/LeadSpeaker.js").PlayerLike;
	let real: P | null = null;
	const pendingOns: Parameters<P["on"]>[] = [];
	return {
		player: {
			play: (resource) => {
				if (!real) {
					log(
						"[deferred-player] play() dropped — no real player yet (orchestrator not in VC)",
					);
					return;
				}
				real.play(resource);
			},
			stop: () => {
				if (!real) return;
				real.stop();
			},
			on: (event, cb) => {
				if (real) {
					real.on(event, cb);
				} else {
					pendingOns.push([event, cb]);
				}
			},
		},
		setReal: (p) => {
			real = p;
			log("[deferred-player] real player attached (orchestrator in VC)");
			for (const [event, cb] of pendingOns.splice(0)) real.on(event, cb);
		},
		clear: () => {
			real = null;
		},
	};
}

export function classifyVoiceDelta(
	u: { fromChannelId: string | null; toChannelId: string | null },
	vcId: string,
): "join" | "leave" | "none" {
	if (u.toChannelId === vcId && u.fromChannelId !== vcId) return "join";
	if (u.fromChannelId === vcId && u.toChannelId !== vcId) return "leave";
	return "none";
}

/**
 * The ONE place the per-meeting transcript JSONL path comes from (FLY-1065 P3
 * — the FLY-967 broken link was the sink writing conversation-<uuid>.jsonl
 * while the landing read <sessionId>.jsonl). Alignment contract: the file
 * NAME is the assistant sessionId — one meeting, one file, naturally
 * aggregating across rotator rotations. JSONL rows keep the Gemini backend
 * session UUID in their `sessionId` field (a rotation trace; the landing
 * reads by file only and never reconciles row ids).
 */
export function assistantTranscriptPath(
	stateDir: string,
	sessionId: string,
): string {
	return join(stateDir, `${sessionId}.jsonl`);
}

// ---- Bridge Linear proxy client ----

interface LinearClientOpts {
	bridgeUrl: string;
	apiToken: string;
	projectName: string;
	fetchImpl: typeof fetch;
}

function makeLinearClient(o: LinearClientOpts) {
	const call = async (
		method: "GET" | "POST" | "PATCH",
		path: string,
		body?: Record<string, unknown>,
		query?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<unknown> => {
		const url = new URL(path, o.bridgeUrl);
		for (const [k, v] of Object.entries(query ?? {})) {
			url.searchParams.set(k, v);
		}
		if (method === "GET") url.searchParams.set("projectName", o.projectName);
		const res = await o.fetchImpl(url.toString(), {
			method,
			headers: {
				Authorization: `Bearer ${o.apiToken}`,
				"Content-Type": "application/json",
			},
			body:
				method === "GET"
					? undefined
					: JSON.stringify({ ...body, projectName: o.projectName }),
			// FLY-1160 §3.3: the shutdown deadline aborts landing mutations
			// mid-flight (true cancellation, not stop-waiting)
			...(signal ? { signal } : {}),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`Bridge ${method} ${path} → ${res.status} ${detail}`);
		}
		return res.json();
	};
	return {
		listIssues: async (states: string[], limit: number) => {
			const data = (await call("GET", "/api/linear/issues", undefined, {
				state: states.join(","),
				limit: String(limit),
				slim: "1",
			})) as { issues: unknown[]; truncated: boolean };
			return { issues: data.issues, truncated: data.truncated };
		},
		createIssue: async (title: string) => {
			const data = (await call("POST", "/api/linear/create-issue", {
				title,
			})) as { issue: { identifier: string; url?: string } };
			return data.issue;
		},
		comment: async (
			issueId: string,
			body: string,
			opts?: { signal?: AbortSignal },
		) => {
			const data = (await call(
				"POST",
				"/api/linear/comment",
				{ issueId, body },
				undefined,
				opts?.signal,
			)) as { comment?: { url?: string } };
			return { url: data.comment?.url };
		},
		closeIssue: async (issueId: string, opts?: { signal?: AbortSignal }) => {
			await call(
				"PATCH",
				"/api/linear/update-issue",
				{ issueId, status: "Done" },
				undefined,
				opts?.signal,
			);
		},
	};
}

// ---- real Gemini conversation factory (rotator-wrapped) ----

interface RealConversationDeps {
	bridgeUrl: string;
	apiToken: string;
	projectName: string;
	stateDir: string;
	log: (msg: string) => void;
	fetchImpl: typeof fetch;
	/** FLY-1018 voice phase: the delegate completion's guaranteed Discord-text
	 * landing (the spoken announce is best-effort — silent no-op mid-rotation
	 * and after the meeting ends). */
	advancedSendText?: (content: string) => Promise<unknown>;
}

function makeRealConversationFactory(
	env: NodeJS.ProcessEnv,
	assistant: AssistantModeConfig,
	d: RealConversationDeps,
): (
	systemPreamble: string,
	opts: { sessionId: string },
) => Promise<ConversationLike> {
	return async (systemPreamble: string, opts: { sessionId: string }) => {
		const vc = resolveVoiceCoreConfig({}, env);
		const apiKey = env[vc.gemini.apiKeyEnv];
		if (!apiKey) {
			throw new Error(`voice-bridge: ${vc.gemini.apiKeyEnv} unset`);
		}
		const backend = new GeminiLiveBackend({
			transport: createGenaiTransport({ apiKey }),
			profile: { model: vc.gemini.model, asyncFunctionCalling: false },
		});
		const brain: BrainAdapter = vc.identityFile
			? new HeadlessClaudeBrain({
					claudeBin: vc.claudeBin,
					identityFile: vc.identityFile,
					timeoutMs: vc.timeouts.brainMs,
				})
			: {
					// explicit, never silent: without an identity the deep-dive brain
					// is unavailable and says so instead of hanging the Live turn.
					async *respond() {
						yield "Lead 的深查脑子(FLYWHEEL_VOICE_IDENTITY)没配置——请用 lookup_issue / board_snapshot,或让工程配置后再问我深问题。";
					},
				};
		// FLY-1065 P3: the sink file IS the file the landing reads (one meeting,
		// one file, shared across rotator rotations — the sink outlives sessions).
		const transcriptSink = new JsonlTranscriptSink(
			assistantTranscriptPath(d.stateDir, opts.sessionId),
		);
		// FLY-1018 voice phase: assistant.advanced mounts the delegate_task
		// deep-dispatch tool. `speak` closes over `adapter` (declared below,
		// same hoisting pattern as the rotator's attach hook) — completion
		// fires long after the adapter exists.
		const advancedTool = assistant.advanced
			? buildAdvancedDelegateTool({
					advanced: assistant.advanced,
					projectName: d.projectName,
					env,
					speak: (text) => adapter.sendText(text),
					log: d.log,
					sendText: d.advancedSendText,
				})
			: null;
		const rotator = new TalkSessionRotator({
			create: (resumeHandle?: ResumeHandle) =>
				(
					backend.createConversation as NonNullable<
						typeof backend.createConversation
					>
				)({
					brain,
					voice: assistant.voice,
					systemHint: SYSTEM_HINT,
					systemPreamble,
					bargeIn: assistant.bargeIn !== false,
					transcriptSink,
					resumeHandle,
					extraTools: (() => {
						const base = buildAssistantTools({
							bridgeUrl: d.bridgeUrl,
							apiToken: d.apiToken,
							projectName: d.projectName,
							fetchImpl: d.fetchImpl,
						});
						return advancedTool ? [...base, advancedTool] : base;
					})(),
				}),
			attach: (session) => adapter.bind(session),
			log: d.log,
			onError: (err) =>
				d.log(
					`conversation rotation failed: ${String((err as Error).message ?? err)}`,
				),
		});
		const adapter = new RotatorConversationAdapter(rotator);
		await rotator.start();
		return adapter;
	};
}

/**
 * ConversationLike over the TalkSessionRotator: handlers survive goAway
 * rotation because the rotator re-binds them onto every successor session.
 */
export class RotatorConversationAdapter implements ConversationLike {
	private readonly handlers = new Map<
		string,
		Set<(...args: never[]) => void>
	>();
	/** the live session — rotator.start() attaches the FIRST session before
	 * AssistantSession has registered any handlers, so on() must bind to the
	 * current session too, not only replay into future bind()s (Codex R3 HIGH). */
	private current: ConversationSession | null = null;

	constructor(private readonly rotator: TalkSessionRotator) {}

	/** rotator attach hook — first session and every rotated successor. */
	bind(session: ConversationSession): void {
		this.current = session;
		for (const [event, cbs] of this.handlers) {
			for (const cb of cbs) {
				session.on(event as never, cb as never);
			}
		}
	}

	sendText(text: string): void {
		this.rotator.sendText(text);
	}

	endUserTurn(): void {
		this.rotator.endUserTurn();
	}

	sendAudio(frame: Buffer, format: unknown): void {
		this.rotator.sendAudio(frame, format as never);
	}

	on(event: string, h: (...args: never[]) => void): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(h);
		this.handlers.set(event, set);
		// late registration must reach the ALREADY-attached session (Codex R3).
		this.current?.on(event as never, h as never);
		// unbind stops future rebinding — teardown closes the whole rotator.
		return () => set.delete(h);
	}

	async close(): Promise<unknown> {
		return this.rotator.close();
	}
}
