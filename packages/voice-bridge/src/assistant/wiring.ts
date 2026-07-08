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

import { randomUUID } from "node:crypto";
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
import { EarsReceiver } from "../audio/EarsReceiver.js";
import { superviseVoiceConnection } from "../audio/VoiceConnSupervisor.js";
import type { DiscordDeps } from "../bots/discordWiring.js";
import type { HuddleBridgeConfig } from "../config.js";
import { SessionSlot } from "../SessionSlot.js";
import { AssistantLanding } from "./AssistantLanding.js";
import { AssistantSession, type ConversationLike } from "./AssistantSession.js";
import { AssistantSpeaker } from "./AssistantSpeaker.js";
import { BriefingEngine, type IssuesPage } from "./BriefingEngine.js";
import type { AssistantModeConfig } from "./config.js";
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
	env?: NodeJS.ProcessEnv;
	log?: (msg: string) => void;
	/** test seam: replaces the real Gemini conversation factory. */
	createConversation?: (systemPreamble: string) => Promise<ConversationLike>;
	fetchImpl?: typeof fetch;
	/** test seam: state dir override (default ~/.flywheel/voice-assistant). */
	stateDir?: string;
}

export interface AssistantRuntime {
	commandName: string;
	close(): Promise<void>;
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

	// ---- resident ears: ONE receiver for the daemon lifetime; frames are
	// routed to whichever meeting is live (SessionSlot enforces ≤1). ----
	let activeFrames: ((frame: Buffer, format: unknown) => void) | null = null;
	const earsDownCbs = new Set<() => void>();
	const earsUpCbs = new Set<() => void>();
	const ears = new EarsReceiver({
		speaking: deps.speakingEvents(opts.earsConnection),
		subscribe: deps.subscribeManual(opts.earsConnection),
		createDecoder: deps.createDecoder,
		isHuman: deps.isHumanFactory(registry.client("note-taker"), config.guildId),
		allowUserIds: config.allowUserIds,
		backchannelMs: config.backchannelMs,
		onFrame: (frame) =>
			activeFrames?.(frame, {
				encoding: "pcm16",
				sampleRateHz: 16_000,
				channels: 1,
			}),
		// v1: Gemini server VAD is the barge-in main path (plan §6); the local
		// pre-stop gate arrives with assistant.localBargeIn after full-chain S-A1.
		onBargeIn: () => {},
		onError: (err, userId) =>
			log(`ears pipeline error (user ${userId}): ${err.message}`),
	});
	ears.attach();
	const conn = deps.connectionEvents(opts.earsConnection);
	const unsubDown = conn.onDown(() => {
		for (const cb of earsDownCbs) cb();
	});
	const unsubUp = conn.onUp(() => {
		for (const cb of earsUpCbs) cb();
	});
	// diagnostics only (FLY-967 round-3): the ears connection has its own
	// EARS_LOST degradation flow; here we just want every state transition and
	// error in the venue log.
	const earsHandle = deps.voiceConnHandle?.(opts.earsConnection);
	const disposeEarsWatch = earsHandle
		? superviseVoiceConnection(earsHandle, {
				label: "ears",
				log,
				mode: "observe",
			})
		: undefined;

	const slot = new SessionSlot();
	let activeSession: AssistantSession | null = null;

	const createConversation =
		opts.createConversation ??
		makeRealConversationFactory(env, assistant, {
			bridgeUrl,
			apiToken,
			projectName: config.projectName,
			stateDir,
			log,
			fetchImpl,
		});

	const tiv = {
		status: (line: string) =>
			void deps
				.sendMessage(orchestratorClient, config.voiceChannelId, line)
				.catch((err) => log(`TIV status send failed: ${err.message}`)),
		// v1: captions go to the daemon log, not the channel — a message per
		// transcript line would flood the TIV (throttled captions ride with the
		// shared TivPresenter when 545 PR-2 lands it).
		caption: (role: "user" | "assistant", text: string) =>
			log(`[caption:${role}] ${text}`),
		card: (text: string) =>
			void deps
				.sendMessage(orchestratorClient, config.voiceChannelId, text)
				.catch((err) => log(`TIV card send failed: ${err.message}`)),
		error: (text: string) =>
			void deps
				.sendMessage(orchestratorClient, config.voiceChannelId, `⚠️ ${text}`)
				.catch((err) => log(`TIV error send failed: ${err.message}`)),
	};

	const command = new GeminiCommand({
		commandName: assistant.commandName,
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
		startSession: async ({ sessionId, issueId, topic }) => {
			let orchestratorConn: unknown;
			// the real AudioPlayer exists only after the orchestrator joins the VC;
			// AssistantSpeaker only ever calls play/stop, so a deferred proxy is a
			// safe seam (no buffering needed — nothing plays before a turn streams,
			// and turns cannot start before join completes).
			let realPlayer: import("../audio/LeadSpeaker.js").PlayerLike | null =
				null;
			let disposeOrchWatch: (() => void) | undefined;
			const speaker = new AssistantSpeaker({
				player: {
					play: (resource) => realPlayer?.play(resource),
					stop: () => realPlayer?.stop(),
					on: (event, cb) => realPlayer?.on(event, cb),
				},
				createResource: deps.createResource,
				log,
			});
			const session = new AssistantSession({
				issueId,
				sessionId,
				topic,
				slot,
				briefing,
				createConversation,
				speaker,
				voice: {
					join: async () => {
						orchestratorConn = await registry.join(ORCHESTRATOR, {
							guildId: config.guildId,
							channelId: config.voiceChannelId,
							selfMute: false,
							selfDeaf: true, // the ears bot hears; the mouth must not echo
						});
						realPlayer = deps.createPlayer(orchestratorConn);
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
											`[voice-conn][orchestrator] the meeting mouth is DOWN (${reason}) — a fresh /${assistant.commandName ?? "gemini"} round is required`,
										),
								})
							: undefined;
					},
					leave: () => {
						disposeOrchWatch?.();
						disposeOrchWatch = undefined;
						if (orchestratorConn) deps.leaveVoice(orchestratorConn);
						orchestratorConn = undefined;
						realPlayer = null;
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
					onFrame: (cb) => {
						activeFrames = cb;
						return () => {
							if (activeFrames === cb) activeFrames = null;
						};
					},
					onDown: (cb) => {
						earsDownCbs.add(cb);
						return () => earsDownCbs.delete(cb);
					},
					onUp: (cb) => {
						earsUpCbs.add(cb);
						return () => earsUpCbs.delete(cb);
					},
				},
				tiv,
				landing: new AssistantLanding({
					linear: {
						comment: (id, body) => linear.comment(id, body),
						closeIssue: (id) => linear.closeIssue(id),
					},
					commandName: assistant.commandName,
					receiptPath: join(stateDir, `${sessionId}.landing-receipt.json`),
					transcriptPath: join(stateDir, `${sessionId}.jsonl`),
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
		},
	});

	try {
		await deps.registerGuildCommand(orchestratorClient, config.guildId, {
			name: command.name,
			description: "纯 Gemini 语音助理 — 开一场带简报的快聊",
		});
		log(`/${command.name} registered on guild ${config.guildId}`);
	} catch (err) {
		// a bot invited without the applications.commands scope cannot register
		// slash commands — LOUD, and the daemon stays up (the autostart QA seam
		// below still exercises the full meeting chain on staged rigs).
		log(
			`WARNING: /${command.name} slash registration failed (missing applications.commands scope on the bot invite?): ${String((err as Error).message ?? err)}`,
		);
	}
	deps.onChatCommand(orchestratorClient, command.name, (inv) => {
		void command
			.handle({ topic: inv.topic, reply: inv.reply })
			.catch((err) => log(`/${command.name} handle failed: ${err.message}`));
	});

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
		close: async () => {
			briefing.stop();
			unsubVoiceState();
			unsubDown();
			unsubUp();
			disposeEarsWatch?.();
			ears.detach();
			await activeSession?.stop();
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
export function classifyVoiceDelta(
	u: { fromChannelId: string | null; toChannelId: string | null },
	vcId: string,
): "join" | "leave" | "none" {
	if (u.toChannelId === vcId && u.fromChannelId !== vcId) return "join";
	if (u.fromChannelId === vcId && u.toChannelId !== vcId) return "leave";
	return "none";
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
		comment: async (issueId: string, body: string) => {
			const data = (await call("POST", "/api/linear/comment", {
				issueId,
				body,
			})) as { comment?: { url?: string } };
			return { url: data.comment?.url };
		},
		closeIssue: async (issueId: string) => {
			await call("PATCH", "/api/linear/update-issue", {
				issueId,
				status: "Done",
			});
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
}

function makeRealConversationFactory(
	env: NodeJS.ProcessEnv,
	assistant: AssistantModeConfig,
	d: RealConversationDeps,
): (systemPreamble: string) => Promise<ConversationLike> {
	return async (systemPreamble: string) => {
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
		const transcriptSink = new JsonlTranscriptSink(
			join(d.stateDir, `conversation-${randomUUID()}.jsonl`),
		);
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
					transcriptSink,
					resumeHandle,
					extraTools: buildAssistantTools({
						bridgeUrl: d.bridgeUrl,
						apiToken: d.apiToken,
						projectName: d.projectName,
						fetchImpl: d.fetchImpl,
					}),
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
