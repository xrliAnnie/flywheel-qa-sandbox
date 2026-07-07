/**
 * AssistantSession (FLY-967 P6b) — the /live lifecycle:
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
import type { BriefingResult } from "./BriefingEngine.js";
import type { LandingResult } from "./AssistantLanding.js";
import type { SessionSlot } from "../SessionSlot.js";

/** the conversation surface the session drives (rotator-compatible). */
export interface ConversationLike {
	sendText(text: string): void;
	sendAudio(frame: Buffer, format: unknown): void;
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
	createConversation(systemPreamble: string): Promise<ConversationLike>;
	speaker: SpeakerLike;
	voice: VoicePresence;
	ears: EarsFeed;
	tiv: TivSurface;
	landing: {
		run(input: {
			issueId: string;
			sessionId: string;
			recapText: string;
			quotes: { ts: string; text: string }[];
			confirmed: boolean;
		}): Promise<LandingResult>;
	};
	/** the "meeting never happened" path (10-min no-show). */
	linearAbort: {
		comment(issueId: string, body: string): Promise<unknown>;
		closeIssue(issueId: string): Promise<void>;
	};
	timeouts?: {
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

const DEFAULT_FOUNDER_JOIN_MS = 600_000;
const DEFAULT_EARS_DOWN_MS = 60_000;
const DEFAULT_RECAP_WAIT_MS = 300_000;

export class AssistantSession {
	private _state: AssistantSessionState = "idle";
	private conv: ConversationLike | null = null;
	private readonly unsubs: (() => void)[] = [];
	private readonly quotes: { ts: string; text: string }[] = [];
	private recapText = "";
	private awaitingConfirm = false;
	private joinTimer: ReturnType<typeof setTimeout> | undefined;
	private earsTimer: ReturnType<typeof setTimeout> | undefined;
	private recapTimer: ReturnType<typeof setTimeout> | undefined;
	private done = false;

	constructor(private readonly opts: AssistantSessionOptions) {}

	get state(): AssistantSessionState {
		return this._state;
	}

	async start(): Promise<void> {
		this._state = "invoked";
		this.opts.tiv.status("🎙 正在进场…");
		await this.opts.voice.join();
		const brief = this.opts.briefing.compose(this.opts.topic);
		if (brief.stale) {
			this.opts.tiv.status(
				"⚠️ 简报可能滞后(缓存超龄)——事实问题请让助理用工具现查。",
			);
		}
		this.conv = await this.opts.createConversation(brief.text);
		this.wireConversation(this.conv);
		this.wireEars(this.conv);
		this.unsubs.push(
			this.opts.voice.onFounderLeave(() => {
				if (this._state === "live" || this._state === "concluding") {
					void this.toLanding(false);
				}
			}),
		);
		if (this.opts.voice.founderPresent()) {
			this.enterLive();
		} else {
			this.unsubs.push(
				this.opts.voice.onFounderJoin(() => {
					if (this._state === "invoked") {
						this.clearTimer("join");
						this.enterLive();
					}
				}),
			);
			this.joinTimer = setTimeout(
				() => void this.abortNoShow(),
				this.opts.timeouts?.founderJoinMs ?? DEFAULT_FOUNDER_JOIN_MS,
			);
			this.joinTimer.unref?.();
		}
	}

	/** external stop (daemon shutdown) — degrade honestly, release the room. */
	async stop(): Promise<void> {
		if (this._state === "live" || this._state === "concluding") {
			await this.toLanding(false);
		} else if (!this.done) {
			await this.teardown();
		}
	}

	private enterLive(): void {
		this._state = "live";
		this.opts.tiv.status("🎙 listening");
		this.conv?.sendText(OPENING_PROMPT);
	}

	private wireEars(conv: ConversationLike): void {
		this.unsubs.push(
			this.opts.ears.onFrame((frame, format) => {
				if (this._state === "live" || this._state === "concluding") {
					conv.sendAudio(frame, format);
				}
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
				this.opts.speaker.beginTurn();
				this.opts.tiv.status("💬 speaking");
			}),
			on("response-audio", (...a) => {
				this.opts.speaker.noteToolResolved();
				this.opts.speaker.feed(a[0] as Buffer);
			}),
			on("response-done", () => {
				this.opts.speaker.endTurn();
				this.opts.tiv.status("🎙 listening");
			}),
			on("response-cancelled", () => {
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
				};
				if (!t.final) return;
				this.opts.tiv.caption(t.role, t.text);
				if (t.role === "user") this.onFounderLine(t.text);
				else if (this._state === "concluding") {
					// the recap the model actually spoke IS the summary body
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
			this.conv?.sendText(RECAP_PROMPT);
			this.enterConcluding(false);
			return;
		}
		if (
			this._state === "concluding" &&
			this.awaitingConfirm &&
			AFFIRMATIVES.test(text.trim())
		) {
			void this.toLanding(true);
		}
		// anything non-affirmative during concluding = a correction — the model
		// re-recaps naturally; we simply keep waiting for the clear yes.
	}

	private enterConcluding(earsLost: boolean): void {
		this._state = "concluding";
		this.awaitingConfirm = !earsLost; // she can't be heard once ears are gone
		this.opts.tiv.status("📝 收尾 recap 中…");
		this.recapTimer = setTimeout(() => {
			if (this._state === "concluding") void this.toLanding(false);
		}, this.opts.timeouts?.recapWaitMs ?? DEFAULT_RECAP_WAIT_MS);
		this.recapTimer.unref?.();
	}

	private async toLanding(confirmed: boolean): Promise<void> {
		if (this._state === "landing" || this.done) return;
		this._state = "landing";
		this.clearTimer("recap");
		this.opts.tiv.status("🛬 正在落纪要…");
		try {
			const r = await this.opts.landing.run({
				issueId: this.opts.issueId,
				sessionId: this.opts.sessionId,
				recapText: this.recapText || "(无 recap——会议在收尾前结束)",
				quotes: this.quotes,
				confirmed,
			});
			if (r.ok) {
				this.opts.tiv.card(
					`✅ /live 纪要已落 ${this.opts.issueId}${r.commentUrl ? `\n${r.commentUrl}` : ""}${confirmed ? "" : "\n(未经口头确认,见 issue 标注)"}`,
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

	private async abortNoShow(): Promise<void> {
		if (this._state !== "invoked" || this.done) return;
		try {
			await this.opts.linearAbort.comment(
				this.opts.issueId,
				"/live 会议没开成——发起后 10 分钟内没有人进语音频道,自动关闭。",
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
		this.opts.slot.release("live", this.opts.issueId);
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
