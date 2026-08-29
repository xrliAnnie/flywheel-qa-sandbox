/**
 * AssistantSession (FLY-967 P6b) — the /gemini assistant lifecycle:
 *
 *   invoked → live → concluding → landing → teardown → idle
 *
 * The command layer acquires the SessionSlot and creates the kickoff issue
 * BEFORE constructing this; the session owns everything after — briefing
 * injection, the opening/recap control prompts (systemInstruction alone
 * never makes the model speak first — Codex R1 #1), speaker wiring, the
 * founder no-show abort, both concluding entries (end-word / she leaves),
 * the ears-drop degradation, landing, and the guaranteed slot release.
 *
 * All Discord/Gemini/Linear specifics are injected seams (chassis pattern),
 * so every path is fake-timer testable.
 */

import type { SessionSlot } from "../SessionSlot.js";
import type { LandingResult } from "./AssistantLanding.js";
import type { BriefingResult } from "./BriefingEngine.js";
import { ASSISTANT_SLOT_MODE } from "./config.js";

/** the conversation surface the session drives (rotator-compatible). */
export interface ConversationLike {
	sendText(text: string): void;
	sendAudio(frame: Buffer, format: unknown): void;
	/** FLY-967 round-6: commit the user's turn (they stopped speaking). */
	endUserTurn(): void;
	on(event: string, h: (...args: never[]) => void): () => void;
	close(): Promise<unknown>;
}

export interface SpeakerLike {
	beginTurn(): void;
	feed(chunk: Buffer): void;
	endTurn(): void;
	flush(): void;
	noteToolCall(): void;
	noteToolResolved(): void;
}

export interface VoicePresence {
	join(): Promise<void>;
	leave(): void;
	founderPresent(): boolean;
	onFounderJoin(cb: () => void): () => void;
	onFounderLeave(cb: () => void): () => void;
}

export interface EarsFeed {
	onFrame(cb: (frame: Buffer, format: unknown) => void): () => void;
	/** FLY-967 round-6: the founder stopped speaking (Discord speaking-end). */
	onSpeakingEnd(cb: () => void): () => void;
	onDown(cb: () => void): () => void;
	onUp(cb: () => void): () => void;
}

export interface TivSurface {
	status(line: string): void;
	caption(role: "user" | "assistant", text: string): void;
	card(text: string): void;
	error(text: string): void;
}

export interface AssistantSessionOptions {
	issueId: string;
	sessionId: string;
	topic?: string;
	slot: SessionSlot;
	briefing: { compose(topic?: string): BriefingResult };
	/** FLY-1065: receives the assistant sessionId so the transcript sink lands
	 * where the landing reads (assistantTranscriptPath alignment contract). */
	createConversation(
		systemPreamble: string,
		opts: { sessionId: string },
	): Promise<ConversationLike>;
	speaker: SpeakerLike;
	voice: VoicePresence;
	ears: EarsFeed;
	tiv: TivSurface;
	landing: {
		run(
			input: {
				issueId: string;
				sessionId: string;
				recapText: string;
				quotes: { ts: string; text: string }[];
				confirmed: boolean;
			},
			/** FLY-1160 §3.3 Phase 2: shutdown deadline — once aborted, no
			 * further external write and never a success report. */
			runOpts?: { signal?: AbortSignal },
		): Promise<LandingResult>;
	};
	/** the "meeting never happened" path (10-min no-show). */
	linearAbort: {
		comment(issueId: string, body: string): Promise<unknown>;
		closeIssue(issueId: string): Promise<void>;
	};
	timeouts?: {
		connectMs?: number;
		founderJoinMs?: number;
		earsDownMs?: number;
		recapWaitMs?: number;
	};
	log?: (line: string) => void;
}

export type AssistantSessionState =
	| "idle"
	| "invoked"
	| "live"
	| "concluding"
	| "landing";

const OPENING_PROMPT =
	"控制提示(她听不到):请用一两句话开场,报出简报生成时间,然后问她想聊什么。";
const RECAP_PROMPT =
	"控制提示(她听不到):她说结束了。请口头 recap 今天聊清的要点,逐条,最后问她「对吗?」等她确认。";
const EARS_LOST_PROMPT =
	"控制提示(她听不到):收音出问题了,你听不到她了。请口播说明收音故障,并做一个简短收尾 recap。";

const END_WORDS = /结束|就这样|收尾|到这里/;
const AFFIRMATIVES = /^(对|没问题|可以|好的|嗯,?对|OK|ok|确认)/;

const DEFAULT_CONNECT_MS = 30_000;
const DEFAULT_FOUNDER_JOIN_MS = 600_000;
const DEFAULT_EARS_DOWN_MS = 60_000;
const DEFAULT_RECAP_WAIT_MS = 300_000;

/** bound a promise; the timer never keeps the process alive. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error(`${what} timed out after ${ms}ms`)),
			ms,
		);
		(t as NodeJS.Timeout).unref?.();
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

export class AssistantSession {
	private _state: AssistantSessionState = "idle";
	private conv: ConversationLike | null = null;
	private readonly unsubs: (() => void)[] = [];
	private readonly quotes: { ts: string; text: string }[] = [];
	private recapText = "";
	private awaitingConfirm = false;
	/** FLY-1065 (Codex R2 guardrail): landing was entered FROM concluding — the
	 * close-flush assistant finals arriving while state is already "landing"
	 * still belong to the spoken recap and must keep accumulating. */
	private closingFromConcluding = false;
	private joinTimer: ReturnType<typeof setTimeout> | undefined;
	private earsTimer: ReturnType<typeof setTimeout> | undefined;
	private recapTimer: ReturnType<typeof setTimeout> | undefined;
	private done = false;
	/** FLY-1160 §3.3 Phase 2: ONE shared abort for THE landing — a shutdown
	 * deadline must reach a landing that is ALREADY in flight (natural
	 * conclusion racing the daemon shutdown), not just one stop() starts. */
	private readonly landingAbort = new AbortController();
	private landingPromise?: Promise<void>;
	private firstFrameLogged = false;
	private firstAudioLogged = false;
	/** live-chain observability (round-5b): both directions counted. */
	private earsFramesForwarded = 0;
	private audioChunksTotal = 0;
	private audioChunksThisTurn = 0;
	private framesThisUtterance = 0;

	constructor(private readonly opts: AssistantSessionOptions) {}

	get state(): AssistantSessionState {
		return this._state;
	}

	async start(): Promise<void> {
		this._state = "invoked";
		this.log("state -> invoked");
		this.opts.tiv.status("🎙 正在进场…");
		let connectPromise: Promise<ConversationLike> | null = null;
		// round-5 (Annie re-verification FAIL): everything before the presence
		// subscription must be BOUNDED and LOGGED. The Gemini connect used to be
		// awaited unbounded — a hanging connect left the session in `invoked`
		// forever with zero log lines (onFounderJoin never registered, wireEars
		// never ran) and, on the throw path, a zombie orchestrator in the VC.
		try {
			await this.opts.voice.join();
			this.log("voice joined — orchestrator in the VC");
			const brief = this.opts.briefing.compose(this.opts.topic);
			this.log(
				`briefing composed (${brief.text.length} chars, stale=${brief.stale})`,
			);
			if (brief.stale) {
				this.opts.tiv.status(
					"⚠️ 简报可能滞后(缓存超龄)——事实问题请让助理用工具现查。",
				);
			}
			this.log("connecting Gemini Live…");
			connectPromise = this.opts.createConversation(brief.text, {
				sessionId: this.opts.sessionId,
			});
			this.conv = await withTimeout(
				connectPromise,
				this.opts.timeouts?.connectMs ?? DEFAULT_CONNECT_MS,
				"Gemini Live connect",
			);
			this.log("conversation ready");
		} catch (err) {
			// a conversation fulfilling AFTER the timeout must not leak (R17)
			connectPromise?.then(
				(c) => void c.close().catch(() => {}),
				() => {},
			);
			const issueClosed = await this.abortStartFailure(
				String((err as Error).message ?? err),
			);
			// the command layer sends the founder-facing failure reply; tell it
			// whether the kickoff issue was already closed so the wording is true
			throw Object.assign(err as Error, { issueClosed });
		}
		if (this.done) {
			// stop() raced the connect (R17): the runtime is already torn down —
			// do NOT resurrect; close the late conversation and stay idle.
			this.log("session stopped during connect — closing late conversation");
			const late = this.conv;
			this.conv = null;
			await late?.close().catch(() => {});
			return;
		}
		this.wireConversation(this.conv);
		this.wireEars(this.conv);
		this.unsubs.push(
			this.opts.voice.onFounderLeave(() => {
				this.log(`founder-leave signal received (state=${this._state})`);
				if (this._state === "live" || this._state === "concluding") {
					void this.toLanding(false, "founder-leave");
				}
			}),
		);
		const present = this.opts.voice.founderPresent();
		this.log(`founderPresent()=${present} at post-connect check`);
		if (present) {
			this.enterLive("initial-check");
		} else {
			this.unsubs.push(
				this.opts.voice.onFounderJoin(() => {
					this.log(`founder-join signal received (state=${this._state})`);
					if (this._state === "invoked") {
						this.clearTimer("join");
						this.enterLive("founder-join");
					}
				}),
			);
			const joinMs =
				this.opts.timeouts?.founderJoinMs ?? DEFAULT_FOUNDER_JOIN_MS;
			this.joinTimer = setTimeout(() => void this.abortNoShow(), joinMs);
			this.joinTimer.unref?.();
			this.log(`no-show timer armed (${joinMs}ms)`);
		}
	}

	/** external stop (daemon shutdown) — degrade honestly, release the room.
	 * FLY-1160 §3.3 Phase 2: the shutdown landing budget's signal — once
	 * aborted, the landing stops before its NEXT external write and never
	 * reports success (receipt keeps the resume cursor). */
	async stop(opts?: { signal?: AbortSignal }): Promise<void> {
		const sig = opts?.signal;
		if (sig) {
			// bridge the budget signal onto the SHARED landing controller so it
			// also reaches a landing already in flight.
			if (sig.aborted) this.landingAbort.abort();
			else
				sig.addEventListener("abort", () => this.landingAbort.abort(), {
					once: true,
				});
		}
		if (this._state === "live" || this._state === "concluding") {
			await this.toLanding(false, "external-stop");
		} else if (this.landingPromise) {
			// a landing is already running — JOIN it (abortable via the shared
			// controller); tearing down here would race the landing (Codex #550 R3).
			await this.landingPromise;
		} else if (!this.done) {
			await this.teardown();
		}
	}

	private enterLive(source: string): void {
		this._state = "live";
		this.log(`state -> live (${source})`);
		this.opts.tiv.status("🎙 listening");
		this.conv?.sendText(OPENING_PROMPT);
		this.log("OPENING prompt sent to Gemini");
	}

	private log(line: string): void {
		this.opts.log?.(`[assistant-session][${this.opts.sessionId}] ${line}`);
	}

	private wireEars(conv: ConversationLike): void {
		this.unsubs.push(
			this.opts.ears.onFrame((frame, format) => {
				if (this._state === "live" || this._state === "concluding") {
					this.earsFramesForwarded++;
					this.framesThisUtterance++;
					if (!this.firstFrameLogged) {
						this.firstFrameLogged = true;
						this.log(
							`first ears frame forwarded to Gemini (${frame.length} bytes)`,
						);
					} else if (this.earsFramesForwarded % 250 === 0) {
						this.log(`ears frames forwarded: ${this.earsFramesForwarded}`);
					}
					conv.sendAudio(frame, format);
				}
			}),
			// FLY-967 round-6: Discord silence-suppression ends her audio stream
			// abruptly when she stops — with no trailing silence the server VAD
			// never commits end-of-speech and the model never replies (reproduced:
			// abrupt audio = NO_RESPONSE). On speaking-end, if she actually sent
			// audio this utterance, commit the turn so Gemini responds.
			this.opts.ears.onSpeakingEnd(() => {
				if (this._state !== "live" && this._state !== "concluding") return;
				if (this.framesThisUtterance === 0) return; // backchannel/noise
				this.log(
					`founder speaking-end — committing turn (${this.framesThisUtterance} frames this utterance)`,
				);
				this.framesThisUtterance = 0;
				conv.endUserTurn();
			}),
			this.opts.ears.onDown(() => {
				if (this._state !== "live") return;
				this.opts.tiv.status("⏸ 收音断了,自动重连中…");
				this.earsTimer = setTimeout(() => {
					if (this._state === "live") {
						conv.sendText(EARS_LOST_PROMPT);
						this.enterConcluding(/* earsLost */ true);
					}
				}, this.opts.timeouts?.earsDownMs ?? DEFAULT_EARS_DOWN_MS);
				this.earsTimer.unref?.();
			}),
			this.opts.ears.onUp(() => {
				this.clearTimer("ears");
				if (this._state === "live") this.opts.tiv.status("🎙 listening");
			}),
		);
	}

	private wireConversation(conv: ConversationLike): void {
		const on = conv.on.bind(conv) as (
			e: string,
			h: (...args: unknown[]) => void,
		) => () => void;
		this.unsubs.push(
			on("response-started", () => {
				this.audioChunksThisTurn = 0;
				this.log(
					`response started (ears frames forwarded so far: ${this.earsFramesForwarded})`,
				);
				this.opts.speaker.beginTurn();
				this.opts.tiv.status("💬 speaking");
			}),
			on("response-audio", (...a) => {
				this.audioChunksTotal++;
				this.audioChunksThisTurn++;
				if (!this.firstAudioLogged) {
					this.firstAudioLogged = true;
					this.log("first response audio from Gemini");
				}
				this.opts.speaker.noteToolResolved();
				this.opts.speaker.feed(a[0] as Buffer);
			}),
			on("response-done", () => {
				this.log(
					`response done (audio chunks this turn: ${this.audioChunksThisTurn}, total: ${this.audioChunksTotal})`,
				);
				this.opts.speaker.endTurn();
				this.opts.tiv.status("🎙 listening");
			}),
			on("response-cancelled", () => {
				this.log("response cancelled (barge-in) — flushing speaker");
				this.opts.speaker.flush();
			}),
			on("tool-call", () => {
				this.opts.speaker.noteToolCall();
				this.opts.tiv.status("🧠 thinking");
			}),
			on("transcript", (...a) => {
				const t = a[0] as {
					role: "user" | "assistant";
					text: string;
					final: boolean;
					interrupted?: boolean;
				};
				if (!t.final) return;
				// FLY-1065: the tail note is composed HERE — the TivSurface signature
				// stays four plain methods; the presenter never learns the semantics.
				this.opts.tiv.caption(
					t.role,
					t.interrupted ? `${t.text} (被打断)` : t.text,
				);
				if (t.role === "user") this.onFounderLine(t.text);
				else if (
					this._state === "concluding" ||
					(this._state === "landing" && this.closingFromConcluding)
				) {
					// the recap the model actually spoke IS the summary body; a half
					// recap she cut off is not the record (interrupted stays out), and
					// the close-flush tail arriving after the state flipped to landing
					// still counts (closingFromConcluding).
					if (t.interrupted) return;
					this.recapText += (this.recapText ? "\n" : "") + t.text;
				}
			}),
			on("error", (...a) => {
				this.opts.tiv.error(`语音会话错误:${(a[0] as Error).message}`);
			}),
		);
	}

	private onFounderLine(text: string): void {
		const ts = new Date().toISOString();
		this.quotes.push({ ts, text });
		if (this._state === "live" && END_WORDS.test(text)) {
			this.log(`end-word detected in founder line — sending RECAP prompt`);
			this.conv?.sendText(RECAP_PROMPT);
			this.enterConcluding(false);
			return;
		}
		if (
			this._state === "concluding" &&
			this.awaitingConfirm &&
			AFFIRMATIVES.test(text.trim())
		) {
			void this.toLanding(true, "recap-confirmed");
		}
		// anything non-affirmative during concluding = a correction — the model
		// re-recaps naturally; we simply keep waiting for the clear yes.
	}

	private enterConcluding(earsLost: boolean): void {
		this._state = "concluding";
		this.log(`state -> concluding (${earsLost ? "ears-lost" : "end-word"})`);
		this.awaitingConfirm = !earsLost; // she can't be heard once ears are gone
		this.opts.tiv.status("📝 收尾 recap 中…");
		this.recapTimer = setTimeout(() => {
			if (this._state === "concluding")
				void this.toLanding(false, "recap-timeout");
		}, this.opts.timeouts?.recapWaitMs ?? DEFAULT_RECAP_WAIT_MS);
		this.recapTimer.unref?.();
	}

	private async toLanding(confirmed: boolean, trigger: string): Promise<void> {
		if (this._state === "landing" || this.done) return;
		const work = this.runLanding(confirmed, trigger);
		// exposed so a later stop() can JOIN this exact landing instead of
		// racing a teardown against it.
		this.landingPromise = work;
		await work;
	}

	private async runLanding(confirmed: boolean, trigger: string): Promise<void> {
		this.closingFromConcluding = this._state === "concluding";
		this._state = "landing";
		this.log(
			`state -> landing (trigger=${trigger} confirmed=${confirmed}; ears frames forwarded=${this.earsFramesForwarded}, assistant audio chunks=${this.audioChunksTotal})`,
		);
		// stop new input: all three timers off; ears frame routing stops by the
		// state guard (onFrame only forwards in live/concluding).
		this.clearTimer("join");
		this.clearTimer("ears");
		this.clearTimer("recap");
		this.opts.tiv.status("🛬 正在落纪要…");
		// FLY-1065 P5 (Codex R1 #1): close the conversation BEFORE landing.run —
		// the close-flush residuals (final transcripts incl. the rotator tail)
		// must be in the JSONL before the landing reads it. The transcript
		// handler is still subscribed, so those finals also reach caption /
		// quotes / recap on the way out.
		const conv = this.conv;
		this.conv = null; // teardown must not close a second time
		try {
			await conv?.close();
		} catch (err) {
			this.log(
				`conversation close before landing failed: ${String((err as Error).message ?? err)}`,
			);
		}
		try {
			const r = await this.opts.landing.run(
				{
					issueId: this.opts.issueId,
					sessionId: this.opts.sessionId,
					recapText: this.recapText || "(无 recap——会议在收尾前结束)",
					quotes: this.quotes,
					confirmed,
				},
				{ signal: this.landingAbort.signal },
			);
			if (r.ok) {
				// never claim a verbatim record that didn't land (0 chunks = 0-turn
				// meeting or feature-skipped) — fall back to the summary-only wording.
				const head =
					(r.transcriptChunks ?? 0) > 0
						? `✅ 会议纪要 + 📝 逐字对话记录已落 ${this.opts.issueId}`
						: `✅ 会议纪要已落 ${this.opts.issueId}`;
				this.opts.tiv.card(
					`${head}${r.commentUrl ? `\n${r.commentUrl}` : ""}${confirmed ? "" : "\n(未经口头确认,见 issue 标注)"}`,
				);
			} else {
				this.opts.tiv.error(r.message);
			}
		} catch (err) {
			this.opts.tiv.error(
				`落地失败:${String((err as Error).message ?? err)}——transcript 兜底在,issue 未关,可重跑。`,
			);
		}
		await this.teardown();
	}

	/** start() failed before live (connect hang/refusal etc.) — degrade
	 * honestly: LOUD log, close the kickoff issue, free the room. Returns
	 * whether the issue actually got closed (the failure reply must not lie). */
	private async abortStartFailure(reason: string): Promise<boolean> {
		if (this.done) return false;
		this.log(`FATAL — session start failed before live: ${reason}`);
		let issueClosed = false;
		try {
			await this.opts.linearAbort.comment(
				this.opts.issueId,
				`语音会议没起来——助理启动失败(${reason})。issue 自动关闭,重新发起即可再试。`,
			);
			await this.opts.linearAbort.closeIssue(this.opts.issueId);
			issueClosed = true;
			this.opts.tiv.status(`会没起来(${reason}),立项 issue 已关。`);
		} catch (err) {
			this.opts.tiv.error(
				`启动失败的收尾也失败:${String((err as Error).message ?? err)}——请人工处理 ${this.opts.issueId}。`,
			);
		}
		await this.teardown();
		return issueClosed;
	}

	private async abortNoShow(): Promise<void> {
		if (this._state !== "invoked" || this.done) return;
		try {
			await this.opts.linearAbort.comment(
				this.opts.issueId,
				"语音会议没开成——发起后 10 分钟内没有人进语音频道,自动关闭。",
			);
			await this.opts.linearAbort.closeIssue(this.opts.issueId);
			this.opts.tiv.status("会没开成(10 分钟无人进场),立项 issue 已关。");
		} catch (err) {
			this.opts.tiv.error(
				`没开成的收尾失败:${String((err as Error).message ?? err)}——请人工处理 ${this.opts.issueId}。`,
			);
		}
		await this.teardown();
	}

	private async teardown(): Promise<void> {
		if (this.done) return;
		this.done = true;
		this.clearTimer("join");
		this.clearTimer("ears");
		this.clearTimer("recap");
		for (const u of this.unsubs.splice(0)) u();
		this.opts.speaker.flush();
		try {
			await this.conv?.close();
		} catch (err) {
			this.opts.log?.(
				`[assistant-session] conversation close failed: ${String((err as Error).message ?? err)}`,
			);
		}
		this.conv = null;
		this.opts.voice.leave();
		this.opts.slot.release(ASSISTANT_SLOT_MODE, this.opts.sessionId);
		this._state = "idle";
	}

	private clearTimer(which: "join" | "ears" | "recap"): void {
		const t =
			which === "join"
				? this.joinTimer
				: which === "ears"
					? this.earsTimer
					: this.recapTimer;
		if (t) clearTimeout(t);
		if (which === "join") this.joinTimer = undefined;
		else if (which === "ears") this.earsTimer = undefined;
		else this.recapTimer = undefined;
	}
}
