/**
 * wireMeeting (FLY-545 PR-2) — assemble one /glaw meeting: build a LeadLine
 * per participant (Gemini session via rotator + streaming mouth + read-only
 * brain + issue_status tool + per-Lead system preamble), the feed/router/
 * ladder/tiv/conclusion graph, and the HuddleSession conducting it all.
 *
 * Everything Discord/Gemini-real is injected (MeetingPorts) — the cli builds
 * the ports from discordWiring/BotRegistry/GeminiLiveBackend; tests can drive
 * the whole assembly with fakes. The meeting owns its resources: dispose()
 * closes every session and hands the VC back.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	AudioFormat,
	BrainAdapter,
	ConversationSession,
	LiveToolSpec,
	ResidentBrainEvent,
	ResumeHandle,
} from "flywheel-voice-core";
import { TalkSessionRotator } from "flywheel-voice-core";
import { GeminiTurnMouth } from "../audio/GeminiTurnMouth.js";
import type { PlayerLike, ResourceSource } from "../audio/LeadSpeaker.js";
import { TextTurnMouth, type TextTurnSpeaker } from "../audio/TextTurnMouth.js";
import type {
	BridgeLinearClient,
	CreatedIssue,
} from "../linear/BridgeLinearClient.js";
import { AddressRouter } from "./AddressRouter.js";
import { ConclusionPipeline } from "./ConclusionPipeline.js";
import { ConfirmationLadder } from "./ConfirmationLadder.js";
import { FeedPipeline } from "./FeedPipeline.js";
import type { GlawInvocation } from "./GlawCommand.js";
import {
	type HuddleLine,
	HuddleSession,
	type LineMouth,
} from "./HuddleSession.js";
import type { HuddleTivPort } from "./huddleTiv.js";
import {
	type ResidentBrainHandle,
	ResidentLineDriver,
} from "./ResidentLineDriver.js";

export interface MeetingLeadConfig {
	agentId: string;
	geminiVoice?: string;
	aliases?: string[];
	identityFile?: string;
}

export interface MeetingPorts {
	/** join this Lead's bot to the VC and return its playback seams. */
	joinLeadVoice: (leadId: string) => Promise<{
		player: PlayerLike;
		createResource: (src: ResourceSource) => unknown;
	}>;
	/** open one Gemini Live conversation (cli binds backend + api key/model). */
	createConversation: (opts: {
		brain: BrainAdapter;
		voice?: string;
		systemPreamble: string;
		systemHint: string;
		extraTools: LiveToolSpec[];
		bargeIn?: boolean;
		/** QA R4: the rotator's resume handle MUST reach the backend — it was
		 * silently dropped here, so "resumed" sessions were brand-new blank
		 * brains (resumed=true was a lie). */
		resumeHandle?: ResumeHandle;
	}) => Promise<ConversationSession>;
	/** per-Lead read-only ask_lead brain (gemini mode: the tool Gemini calls). */
	createBrain: (lead: MeetingLeadConfig) => BrainAdapter;
	/** FLY-1160 §4.1 resident mode ONLY: open this line's resident Claude brain
	 * (keyed on the manager) + build its text speaker (edge-tts over the line's
	 * player). cli.ts wires it from the singleton ResidentBrainManager +
	 * LeadSpeaker/EdgeTts; wireMeeting wraps the speaker in a TextTurnMouth and
	 * the brain in a ResidentLineDriver. Absent ⇒ gemini mode (byte-compat). */
	createResidentLine?: (input: {
		lead: MeetingLeadConfig;
		/** manager key: `<issueIdentifier>:<leadId>`. */
		key: string;
		/** meeting-context preamble (issue / attendees / control conventions) —
		 * injected via stdin on the first turn (never argv). */
		sessionPreamble: string;
		player: PlayerLike;
		createResource: (src: ResourceSource) => unknown;
		/** the meeting-facing brain lifecycle sink (recovering/failed → TIV,
		 * context-drained → feed.retry, lifetime-expiry → host degraded land). */
		onEvent: (e: ResidentBrainEvent) => void;
	}) => { brain: ResidentBrainHandle; speaker: TextTurnSpeaker };
	/** FLY-1160 §4.1 resident mode ONLY: reap a resident brain opened by
	 * createResidentLine (manager.close, keyed). wireMeeting calls this to close
	 * every brain it opened if assembly fails partway (Codex R1 HIGH-2 — a brain
	 * opened before a later join/connect throws would otherwise leak its process
	 * + hard-cap slot); the normal teardown path uses ports.release. */
	closeResidentLine?: (key: string) => Promise<void> | void;
	/** summary generator (host persona, markdown register). */
	summarize: (journalSnapshot: string) => Promise<string>;
	worktree: {
		create(opts: {
			mainRepoPath: string;
			projectName: string;
			issueId: string;
		}): Promise<{ path: string }>;
	};
	linear: BridgeLinearClient;
	tiv: HuddleTivPort;
	/** leave the VC / release the meeting slot when the meeting ends. */
	release: () => Promise<void> | void;
	log?: (line: string) => void;
}

export interface MeetingConfigSlice {
	projectName: string;
	projectRoot: string;
	earconPath?: string;
	fillerPath?: string;
	/** transcript archive location (journal JSONL). */
	transcriptDir: string;
	assembleTimeoutMs?: number;
	/** FLY-1160 §4.1/§5: conversation engine. "gemini" (default / undefined =
	 * current behavior) = Gemini Live thinks; "resident" = the resident Claude
	 * brain thinks (Gemini kept for audio/STT only). */
	mode?: "gemini" | "resident";
}

/** FLY-968 V8 sweep: verified-intelligible prebuilt voices, assigned by
 * index when leads[].geminiVoice is unset. */
const DEFAULT_GEMINI_VOICES = ["Kore", "Puck", "Charon"];
/** gap between per-lead Gemini connects (QA R2 F1): keeps the assembly burst
 * from starving a live ws handshake. */
const ASSEMBLY_STAGGER_MS = 300;

export interface WiredMeeting {
	huddle: HuddleSession;
	feed: FeedPipeline;
	dispose: () => Promise<void>;
}

export async function wireMeeting(
	invocation: GlawInvocation,
	leadsConfig: MeetingLeadConfig[],
	config: MeetingConfigSlice,
	ports: MeetingPorts,
): Promise<WiredMeeting> {
	const participants = invocation.participants;
	const feed = new FeedPipeline({
		onLag: (leadId, failed) =>
			ports.tiv.warn(
				`${leadId} 的会议上下文同步落后(连续 ${failed} 次投递失败)— 它接下来的回答可能缺最新事实。`,
			),
	});
	const router = new AddressRouter(
		participants.map((p) => {
			const lead = leadsConfig.find((l) => l.agentId === p.leadId);
			return {
				leadId: p.leadId,
				aliases: [p.displayName, ...(lead?.aliases ?? [])],
			};
		}),
		invocation.hostLeadId,
	);

	// huddleRef breaks the line↔session circularity: lines forward events into
	// the HuddleSession that is constructed after them.
	const huddleRef: { current?: HuddleSession } = {};
	const rotators: TalkSessionRotator[] = [];
	const lines: HuddleLine[] = [];
	// Codex R1 HIGH-2: resident brains are opened per participant DURING assembly.
	// If a later join/connect/start fails, the whole assembly rejects before it
	// can return a WiredMeeting (whose release hook would reap them), so track the
	// opened keys and close them in the failure path below.
	const openedResidentKeys: string[] = [];

	try {
		for (const [i, p] of participants.entries()) {
			// QA R2 F2a: the assembly window must be visibly "connecting — don't
			// talk yet"; speech in this window used to be silently swallowed (F1's
			// abort window) and she could not tell "broken" from "starting".
			ports.tiv.presence(
				"connecting",
				`正在接入 ${p.displayName} (${i + 1}/${participants.length})`,
			);
			const lead = leadsConfig.find((l) => l.agentId === p.leadId);
			const { player, createResource } = await ports.joinLeadVoice(p.leadId);

			// ---- FLY-1160 §4.1: resident-brain line (mode === "resident") ----
			// Gemini stays for AUDIO/STT only (its response is discarded); the
			// resident Claude brain thinks and speaks through a TextTurnMouth.
			if (config.mode === "resident" && ports.createResidentLine) {
				wireResidentLine({
					i,
					p,
					lead,
					player,
					createResource,
					invocation,
					config,
					ports,
					feed,
					huddleRef,
					rotators,
					lines,
					openedResidentKeys,
				});
				continue;
			}

			const mouth = new GeminiTurnMouth({
				player,
				createResource,
				...(config.earconPath ? { earconPath: config.earconPath } : {}),
				...(config.fillerPath ? { fillerPath: config.fillerPath } : {}),
				log: ports.log,
			});
			const brain = ports.createBrain(lead ?? { agentId: p.leadId });
			const issueStatusTool: LiveToolSpec = {
				declaration: {
					name: "issue_status",
					description:
						"Query a Linear issue's status by identifier (FLY-123) or keyword. Read-only.",
					parameters: {
						type: "OBJECT",
						properties: {
							query: {
								type: "STRING",
								description: "issue identifier or keyword",
							},
						},
						required: ["query"],
					},
				},
				handler: async (args) => {
					const query = String(
						(args as { query?: unknown })?.query ?? "",
					).trim();
					if (!query) return "没给查询词,查不了。";
					try {
						const r = await ports.linear.lookupIssue(query);
						if (r.matchType === "identifier" && r.issue) {
							const it = r.issue as Record<string, unknown>;
							return `${String(it.identifier)}「${String(it.title ?? "")}」状态 ${String(it.state ?? it.status ?? "未知")}`;
						}
						const list = (r.issues ?? [])
							.slice(0, 3)
							.map(
								(it) =>
									`${String(it.identifier)}「${String(it.title ?? "")}」${String(it.state ?? "")}`,
							)
							.join(";");
						return list || "没找到匹配的 issue。";
					} catch (err) {
						return `查询失败:${err instanceof Error ? err.message : String(err)}`;
					}
				},
			};

			const currentRef: { session?: ConversationSession } = {};
			let sessionCount = 0;
			let rebuiltWithoutResume = false;
			let replayedOnAttach = false;
			const rotator = new TalkSessionRotator({
				create: (handle) => {
					// a successor opened WITHOUT a resume handle lost its Gemini-side
					// context — the whole journal must be replayed, not just the tail.
					rebuiltWithoutResume = sessionCount > 0 && !handle;
					// per-ROTATION flag: a graceful no-handle rotation sets it in
					// attach but never reaches onReconnected — without this reset a
					// LATER connection-death rotation would read the stale true and
					// skip its defensive replay (Codex R27).
					replayedOnAttach = false;
					sessionCount++;
					return ports.createConversation({
						// QA R4 (Annie's 裸-LLM freeze): pass the resume handle THROUGH —
						// dropping it here meant Gemini session resumption never actually
						// happened and every "reconnect" produced a context-less line.
						...(handle ? { resumeHandle: handle } : {}),
						brain,
						voice:
							lead?.geminiVoice ??
							DEFAULT_GEMINI_VOICES[i % DEFAULT_GEMINI_VOICES.length],
						systemPreamble: buildPreamble(p.displayName, invocation),
						systemHint:
							"口语短句,零工程黑话,不用 markdown、不用列表符号;长答案先用一句话 ack。",
						extraTools: [issueStatusTool],
						// QA R3 P1 (环境杂音误打断): Gemini's server VAD must NEVER
						// self-cancel a line's answer — footsteps/room tone through
						// her open mic tripped it. Interruption authority is OUR
						// energy-gated EarsReceiver barge-in exclusively.
						bargeIn: false,
					});
				},
				attach: (session) => {
					currentRef.session = session;
					// a rotation just settled — drain feed entries that were held
					// while no live session existed (Codex R1 HIGH: never lose one);
					// a context-lost rebuild gets the whole journal again.
					if (rebuiltWithoutResume) {
						rebuiltWithoutResume = false;
						replayedOnAttach = true;
						feed.replay(p.leadId);
					} else {
						feed.retry();
					}
					const id = p.leadId;
					session.on("transcript", (t) =>
						huddleRef.current?.handleLineTranscript(id, t),
					);
					session.on("response-started", () =>
						huddleRef.current?.handleLineResponseStarted(id),
					);
					session.on("response-audio", (chunk) =>
						huddleRef.current?.handleLineResponseAudio(id, chunk),
					);
					session.on("response-done", () =>
						huddleRef.current?.handleLineResponseDone(id),
					);
					session.on("response-cancelled", () =>
						huddleRef.current?.handleLineResponseCancelled(id),
					);
					session.on("tool-call", () =>
						huddleRef.current?.handleLineToolCall(id),
					);
					session.on("speech-stopped", () => {
						// server VAD endpoint — only meaningful on the addressed line.
						huddleRef.current?.handleFounderSpeechStopped();
					});
					session.on("error", (err) => {
						ports.log?.(`[meeting] line ${id} error: ${err.message}`);
						ports.tiv.warn(`${p.displayName} 的语音线路出错:${err.message}`);
					});
				},
				// QA R5 (FLY-1186): the STT-abort window gets a TRUTHFUL state from
				// the moment the death is detected — not a "thinking" lie until the
				// reconnect lands.
				onDown: () => {
					ports.log?.(
						`[meeting] line ${p.leadId} connection down — reconnecting`,
					);
					huddleRef.current?.handleLineDown(p.leadId);
				},
				// QA R2 F1: an unexpected disconnect is auto-recovered by the
				// rotator — tell her, and tell her what was lost, so the abort
				// window is never "说话没人理" silence again.
				onReconnected: (resumed) => {
					ports.log?.(
						`[meeting] line ${p.leadId} reconnected (resumed=${resumed})`,
					);
					// QA R3 P0 (重连后对话哑掉), CONNECTION-DEATH path only (Codex R23
					// MEDIUM-1: a graceful goAway rotation mid-answer must not cut the
					// tail audio): the dead turn never sent response-done — flush the
					// zombie mouth stream and reset the huddle's turn state so the
					// next turn starts clean and audible.
					mouth.flush();
					// QA R4 (b): defensive journal replay on EVERY connection-death
					// recovery — even a genuinely resumed session may have lost the
					// tail of its server-side context around the abort. Skip only if
					// attach's no-handle path already replayed this rotation. MUST
					// run BEFORE the audio replay (Codex R35 MEDIUM-3): the recovered
					// utterance must not be committed into a session whose context has
					// not been restored yet — mirror of the no-handle attach ordering.
					if (!replayedOnAttach) feed.replay(p.leadId);
					replayedOnAttach = false;
					// QA R5 P0: the huddle replays her buffered utterance into the
					// successor session — the abort window must not eat her words. It
					// also owns the presence restore (addressed-line gated, Codex R35
					// MEDIUM-4) — no wiring-level presence stomp here.
					const rec = huddleRef.current?.handleLineReconnected(p.leadId);
					const replayed = rec?.replayed ?? false;
					const handoffDelivered = rec?.handoffDelivered ?? false;
					ports.log?.(
						`[meeting] line ${p.leadId} utterance replay: ${
							replayed ? "replayed buffered founder audio" : "nothing to replay"
						}${handoffDelivered ? " (queued handoff delivered)" : ""}`,
					);
					// Codex R39 MEDIUM-2: a recovery that DID deliver her words (audio
					// replay or queued handoff) must never be followed by a
					// contradictory 请再说一遍.
					ports.tiv.warn(
						replayed
							? `${p.displayName} 的线路闪断了一下,已自动接回 — 你刚才说的我补听到了,稍等回复。`
							: handoffDelivered
								? `${p.displayName} 的线路闪断了一下,已自动接回 — 你刚才点名它的那句我转给它了,稍等回复。`
								: resumed
									? `${p.displayName} 的线路闪断了一下,已自动接回 — 刚才那句请再说一遍。`
									: `${p.displayName} 的线路闪断重连,上下文丢了一段 — 会自动补上会议纪要,刚才那句请再说一遍。`,
					);
				},
				// QA R5 (Codex R35 MEDIUM-4): rotation exhausted — the line is dead
				// for the rest of the meeting. Without this the huddle's "recovering"
				// state wedges forever and she stares at a lie.
				onError: (err) => {
					ports.log?.(
						`[meeting] line ${p.leadId} reconnect FAILED: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
					huddleRef.current?.handleLineFailed(p.leadId);
					ports.tiv.warn(
						`${p.displayName} 的线路重连失败,这条声部本场会议不可用 — 可以点名其他人继续,或结束会议重开。`,
					);
				},
			});
			rotators.push(rotator);

			lines.push({
				leadId: p.leadId,
				displayName: p.displayName,
				session: {
					sendAudio: (f: Buffer, fmt: AudioFormat) => rotator.sendAudio(f, fmt),
					sendText: (t: string) => rotator.sendText(t),
					injectContext: (t: string) => rotator.injectContext(t),
					interrupt: () => currentRef.session?.interrupt(),
					// QA R5: lets the abort-window replay close a finished utterance
					// so the successor's VAD does not wait for silence forever.
					endUserTurn: () => rotator.endUserTurn(),
				},
				mouth,
			});
			feed.register(p.leadId, {
				inject: (t) => {
					// a rotation-window drop must THROW so the feed cursor holds and
					// the entry re-delivers when the successor session attaches.
					if (!rotator.injectContext(t)) {
						throw new Error("rotation in flight — feed entry held");
					}
				},
			});
		}

		const ladder = new ConfirmationLadder({
			speaker: { speak: (text) => huddleRef.current?.promptHost(text) },
			postReceipt: (content) => ports.tiv.card(content),
			log: ports.log,
		});

		const transcriptPath = `${config.transcriptDir}/${invocation.issue.identifier}.jsonl`;
		// durable partial-landing ledger (Codex R2): comment/worktree steps that
		// already ran must not repeat on a resumed landing. Same dir family as the
		// transcript archive — the daemon is single-machine.
		const landingDir = `${config.transcriptDir}/landing`;
		const progressStore = {
			load(identifier: string) {
				try {
					return JSON.parse(
						readFileSync(`${landingDir}/${identifier}.json`, "utf-8"),
					) as { commented?: boolean; worktreePath?: string };
				} catch {
					return undefined;
				}
			},
			save(identifier: string, progress: object) {
				mkdirSync(landingDir, { recursive: true });
				writeFileSync(
					`${landingDir}/${identifier}.json`,
					JSON.stringify(progress),
					"utf-8",
				);
			},
		};
		const conclusion = new ConclusionPipeline({
			linear: {
				comment: (issueId, body) => ports.linear.comment(issueId, body),
				setStatus: (issueId, status) => ports.linear.setStatus(issueId, status),
				getState: async (issueId) => {
					try {
						const r = await ports.linear.lookupIssue(issueId, 1);
						const it = r.issue as Record<string, unknown> | undefined;
						const state = it?.state ?? it?.status;
						return typeof state === "string" ? state : undefined;
					} catch {
						return undefined; // guard only — never blocks a landing
					}
				},
			},
			worktree: ports.worktree,
			summarize: ports.summarize,
			tiv: ports.tiv,
			mainRepoPath: config.projectRoot,
			projectName: config.projectName,
			progressStore,
			log: ports.log,
		});

		const huddle = new HuddleSession({
			issue: invocation.issue,
			hostLeadId: invocation.hostLeadId,
			lines,
			router,
			feed,
			ladder,
			tiv: ports.tiv,
			conclusion: {
				land: (input) => {
					archiveJournal(feed, transcriptPath, ports.log);
					return conclusion.land({ ...input, transcriptPath });
				},
				abortNoShow: (issue: CreatedIssue) => conclusion.abortNoShow(issue),
			},
			onTeardown: async () => {
				for (const r of rotators) await r.close().catch(() => undefined);
				await ports.release();
			},
			...(config.assembleTimeoutMs !== undefined
				? { assembleTimeoutMs: config.assembleTimeoutMs }
				: {}),
			log: ports.log,
		});
		huddleRef.current = huddle;

		// open every line's first Gemini session BEFORE going live — STAGGERED
		// (QA R2 F1): the assembly burst (N joins + N connects back-to-back)
		// reproducibly starved a live ws mid-handshake; a short gap between
		// connects keeps the event loop breathing. connect-level retry/backoff
		// (voice-core) is the second belt under this.
		for (const [i, r] of rotators.entries()) {
			ports.tiv.presence(
				"connecting",
				`正在唤醒声部 (${i + 1}/${rotators.length}) — 先别说话`,
			);
			await r.start();
			if (i < rotators.length - 1) {
				await new Promise((res) => setTimeout(res, ASSEMBLY_STAGGER_MS));
			}
		}
		// NOTE: no "listening" presence here — huddle.start() (called by the cli
		// right after) sets the assembling state, and the live transition is what
		// announces 可以说话了 (Codex R13 MEDIUM: a presence set here was stomped
		// one tick later and the ready state never rendered).

		return {
			huddle,
			feed,
			dispose: async () => {
				for (const r of rotators) await r.close().catch(() => undefined);
				await ports.release();
			},
		};
	} catch (err) {
		// assembly failed partway — reap every resident brain already opened (else
		// it leaks a claude process + a hard-cap slot; a same-key retry could reuse
		// a brain bound to this abandoned meeting) and close the rotators started so
		// far, then surface the failure.
		for (const key of openedResidentKeys) {
			await Promise.resolve(ports.closeResidentLine?.(key)).catch(
				() => undefined,
			);
		}
		for (const r of rotators) await r.close().catch(() => undefined);
		throw err;
	}
}

/** the resident-mode Gemini session's only job is STT — its generated response
 * is discarded, so its system instruction is squeezed to the shortest possible
 * reply to keep the wasted generation cheap (§4.1-2). */
const RESIDENT_STT_PREAMBLE =
	"你只负责把用户说的话转成文字,不要主动回答。收到内容时只回一个字「嗯」。";

/** a discard brain for the resident-mode Gemini STT session — it never thinks,
 * so the ask_lead tool is moot; respond yields nothing. */
const NOOP_BRAIN: BrainAdapter = {
	async *respond() {},
};

/** HuddleSession never drives a resident line's mouth through LineMouth (the
 * ResidentLineDriver owns the real TextTurnMouth); this inert adapter satisfies
 * the HuddleLine.mouth field. Teardown routes through `resident.bargeIn`. */
const RESIDENT_NOOP_MOUTH: LineMouth = {
	beginTurn: () => {},
	feed: () => {},
	endTurn: () => {},
	flush: () => {},
	noteToolCall: () => {},
	noteToolResolved: () => {},
};

/**
 * Assemble ONE resident-brain /glaw line (§4.1): resident Claude brain +
 * TextTurnMouth (edge-tts) + ResidentLineDriver, plus a Gemini session used
 * ONLY for founder STT (its response is discarded). Pushed into rotators/lines
 * and registered on the feed exactly like a gemini line, so HuddleSession
 * conducts both uniformly.
 */
function wireResidentLine(args: {
	i: number;
	p: GlawInvocation["participants"][number];
	lead: MeetingLeadConfig | undefined;
	player: PlayerLike;
	createResource: (src: ResourceSource) => unknown;
	invocation: GlawInvocation;
	config: MeetingConfigSlice;
	ports: MeetingPorts;
	feed: FeedPipeline;
	huddleRef: { current?: HuddleSession };
	rotators: TalkSessionRotator[];
	lines: HuddleLine[];
	openedResidentKeys: string[];
}): void {
	const {
		i,
		p,
		lead,
		player,
		createResource,
		invocation,
		ports,
		feed,
		huddleRef,
		rotators,
		lines,
		openedResidentKeys,
	} = args;
	const createResidentLine = ports.createResidentLine;
	if (!createResidentLine) return; // caller guarantees it; narrow for TS

	const key = `${invocation.issue.identifier}:${p.leadId}`;

	// brain lifecycle → meeting surfaces (§4.1-4 feed retry / §4.1-8 TIV /
	// §4.1-7 host lifetime-expiry → degraded landing).
	const onEvent = (e: ResidentBrainEvent): void => {
		switch (e.type) {
			case "context-drained":
				// a context block reached a NORMAL terminal result — the held feed
				// entries can now re-deliver.
				feed.retry();
				break;
			case "state":
				if (e.state === "recovering") {
					ports.tiv.warn(
						`${p.displayName} 的常驻大脑在重连,这一两句可能要多等一下。`,
					);
				} else if (e.state === "failed") {
					ports.tiv.warn(
						`${p.displayName} 的大脑掉线了 — 会继续开,但它暂时答不上来。`,
					);
				}
				break;
			case "lifetime-expiry":
				if (p.leadId === invocation.hostLeadId) {
					huddleRef.current?.handleResidentLifetimeExpiry();
				}
				break;
			default:
				break;
		}
	};

	const { brain, speaker } = createResidentLine({
		lead: lead ?? { agentId: p.leadId },
		key,
		sessionPreamble: buildResidentPreamble(p.displayName, invocation),
		player,
		createResource,
		onEvent,
	});
	// record the key the instant it is opened, so an assembly failure downstream
	// (later join/connect/start) can reap this brain (Codex R1 HIGH-2).
	openedResidentKeys.push(key);

	const mouth = new TextTurnMouth({
		speaker,
		onError: (err) =>
			ports.tiv.warn(`${p.displayName} 的语音合成出错:${err.message}`),
		...(ports.log ? { log: ports.log } : {}),
	});
	const driver = new ResidentLineDriver({
		brain,
		mouth,
		onSpeaking: () => huddleRef.current?.handleResidentSpeaking(p.leadId),
		onAnswer: (t) => huddleRef.current?.handleResidentAnswer(p.leadId, t),
		onError: (err) =>
			huddleRef.current?.handleResidentError(p.leadId, err.message),
		...(ports.log ? { log: ports.log } : {}),
	});

	// Gemini session for STT ONLY (§4.1-2): input transcription (role=user) feeds
	// the founder-utterance pipeline; response-started/audio/done/cancelled are
	// the DISCARDED generation and are deliberately NOT wired to any mouth.
	const currentRef: { session?: ConversationSession } = {};
	const rotator = new TalkSessionRotator({
		create: () =>
			ports.createConversation({
				brain: NOOP_BRAIN,
				voice:
					lead?.geminiVoice ??
					DEFAULT_GEMINI_VOICES[i % DEFAULT_GEMINI_VOICES.length],
				systemPreamble: RESIDENT_STT_PREAMBLE,
				systemHint: "只用于听写,尽量少说话。",
				extraTools: [],
				bargeIn: false,
			}),
		attach: (session) => {
			currentRef.session = session;
			const id = p.leadId;
			session.on("transcript", (t) =>
				huddleRef.current?.handleLineTranscript(id, t),
			);
			session.on("speech-stopped", () =>
				huddleRef.current?.handleFounderSpeechStopped(),
			);
			session.on("error", (err) => {
				ports.log?.(`[meeting] resident line ${id} STT error: ${err.message}`);
				ports.tiv.warn(`${p.displayName} 的收音线路出错:${err.message}`);
			});
		},
		// FLY-1190: her STT (ears) died — mark the truthful "line down" state so the
		// abort window is protected. The resident BRAIN turn is untouched (it lives on
		// ResidentLineDriver, not this Gemini STT session).
		onDown: () => {
			ports.log?.(
				`[meeting] resident line ${p.leadId} STT down — reconnecting`,
			);
			huddleRef.current?.handleLineDown(p.leadId);
		},
		onReconnected: (resumed) => {
			// FLY-1190: replay her buffered audio into the successor STT session so an
			// abort mid-utterance does not eat her words (mirror of the gemini leg). EARS
			// layer only — the resident answer turn is INDEPENDENT of this session, so do
			// NOT flush the resident mouth and do NOT feed.replay (the STT session is
			// NOOP_BRAIN; the resident brain context survives the flap).
			ports.log?.(
				`[meeting] resident line ${p.leadId} STT reconnected (resumed=${resumed})`,
			);
			const rec = huddleRef.current?.handleLineReconnected(p.leadId);
			if (rec?.replayed) {
				ports.tiv.warn(
					`${p.displayName} 的收音闪断了一下,已自动接回 — 你刚才说的我补听到了。`,
				);
			} else if (rec?.handoffDelivered) {
				ports.tiv.warn(
					`${p.displayName} 的收音闪断了一下,已自动接回 — 你刚才点名它的那句我转给它了。`,
				);
			}
			// FLY-1190: HuddleSession owns the presence restore (addressed-line gated,
			// and — unlike the gemini leg — SKIPPED while a resident answer is in flight,
			// so an ears-only reconnect can't stomp "speaking"→"listening"). No
			// wiring-level presence stomp here — mirror of the gemini leg.
		},
		// FLY-1190: her STT rotation is EXHAUSTED (all reconnect attempts failed) —
		// mark the ears line dead so the huddle's "recovering" state doesn't wedge and
		// no audio keeps feeding the dead rotator (mirror of the gemini leg's onError).
		// A resident BRAIN turn already in flight is untouched (it lives on
		// ResidentLineDriver) and finishes on its own mouth; handleLineFailed just
		// force-switches the router so her NEXT utterance reaches a line with live ears.
		onError: (err) => {
			ports.log?.(
				`[meeting] resident line ${p.leadId} STT reconnect FAILED: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			huddleRef.current?.handleLineFailed(p.leadId);
			ports.tiv.warn(
				`${p.displayName} 的收音线路重连失败,这条声部的耳朵本场会议不可用 — 可以点名其他人继续,或结束会议重开。`,
			);
		},
	});
	rotators.push(rotator);

	lines.push({
		leadId: p.leadId,
		displayName: p.displayName,
		session: {
			sendAudio: (f: Buffer, fmt: AudioFormat) => rotator.sendAudio(f, fmt),
			sendText: (t: string) => rotator.sendText(t),
			injectContext: (t: string) => rotator.injectContext(t),
			interrupt: () => currentRef.session?.interrupt(),
			// FLY-1190: lets the abort-window replay close a finished utterance so the
			// successor STT session VAD does not wait for silence forever.
			endUserTurn: () => rotator.endUserTurn(),
		},
		mouth: RESIDENT_NOOP_MOUTH,
		resident: {
			respond: (t) => driver.respond(t),
			bargeIn: () => driver.bargeIn(),
		},
	});

	// §4.1-4: non-addressed meeting facts → the resident's appendContext;
	// accepted:false THROWS so the feed cursor HOLDS and re-delivers once the
	// brain drains (context-drained → feed.retry, wired in onEvent above).
	feed.register(p.leadId, {
		inject: (t) => {
			const r = brain.appendContext(t);
			if (!r.accepted) {
				throw new Error("resident context buffer full — feed entry held");
			}
		},
	});
}

/** the resident brain's meeting-context preamble — persona rides its
 * identity.md; this carries who's here, the issue, and the control-tag
 * conventions HuddleSession uses ([控制] / [Annie 在点名你] / [会议记录]). */
function buildResidentPreamble(
	displayName: string,
	invocation: GlawInvocation,
): string {
	const names = invocation.participants.map((p) => p.displayName);
	const host = invocation.participants.find(
		(p) => p.leadId === invocation.hostLeadId,
	);
	return [
		`你是 ${displayName},在一场语音 huddle 里,和 founder Annie${
			names.length > 1
				? ` 以及 ${names.filter((n) => n !== displayName).join("、")}`
				: ""
		}一起开会。`,
		`主持/记录:${host?.displayName ?? displayName}。本场立项 issue:${invocation.issue.identifier}。`,
		"规则:",
		"1) 说口语短句,别用 markdown、别念列表符号;项目事实用你的只读工具(Read/Grep/Glob)查,不许编。",
		"2) 有后果的动作只口头复述确认,不执行;不可逆动作(ship/merge/关 runner)明确说要走文字审批,语音批准不算数。",
		"3) 以「[会议记录]」开头的是补给你的会议背景,记住即可,别直接回应它。",
		"4) 以「[控制]」开头的是系统指令,照做但别念出来;以「[Annie 在点名你]」开头的是 founder 刚对你说的话,直接回答她。",
	].join("\n");
}

function buildPreamble(
	displayName: string,
	invocation: GlawInvocation,
): string {
	const names = invocation.participants.map((p) => p.displayName);
	const host = invocation.participants.find(
		(p) => p.leadId === invocation.hostLeadId,
	);
	return [
		`你是 ${displayName},在 Discord #huddle 语音会议里,和 founder Annie${
			names.length > 1
				? ` 以及 ${names.filter((n) => n !== displayName).join("、")}`
				: ""
		}一起开会。`,
		`主持/记录:${host?.displayName ?? displayName}。本场立项 issue:${invocation.issue.identifier}。`,
		"规则:",
		`1) 每次开口第一句先自报身份,例:「我是 ${displayName},…」。`,
		"2) 项目事实必须用工具查(ask_lead / issue_status),不许编。",
		"3) 有后果的动作只口头复述确认,不执行;不可逆动作(ship/merge/关 runner)明确说要走文字审批,语音批准不算数。",
		"4) 以「[会议记录]」开头的内容是补给你的会议背景,记住即可,不要对它直接回应。",
		"5) 以「[控制]」开头的是系统指令,照做,不要念出来;以「[Annie 在点名你]」开头的是 founder 刚才对你说的话,直接回答她。",
	].join("\n");
}

function archiveJournal(
	feed: FeedPipeline,
	path: string,
	log?: (l: string) => void,
): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			feed
				.entries()
				.map((e) => JSON.stringify(e))
				.join("\n"),
			"utf-8",
		);
	} catch (err) {
		log?.(
			`[meeting] transcript archive failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
