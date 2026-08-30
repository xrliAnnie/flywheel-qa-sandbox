/**
 * HeadphoneTurnMachine — the §17 one-in-one-out turn state machine
 * (FLY-546 B1-3). Pure event-driven core: audio, Discord and Bridge I/O are
 * ALL injected (HeadphoneIO), timers are injected (TimerHost), so every
 * transition is deterministically testable. The PRD §17 worked example
 * replays verbatim in headphone-worked-example.test.ts — change the PRD
 * wording there FIRST, then here.
 *
 * State × event × action table (the contract, plan B1-3.1):
 *
 * | state | event | action → next |
 * |-------|-------|---------------|
 * | idle (mode ON, queue empty) | queue_pushed | speak(headline+body) → announcing; body >400 chars → speak(headline+first two sentences+「要听全文吗?」) → awaiting_detail_choice |
 * | awaiting_detail_choice | utterance∈CONFIRM | speak(full text) → announcing |
 * | awaiting_detail_choice | utterance∈SKIP/DENY / silence(15s) | skip full text → speak(「要回吗?」) → awaiting_disposition |
 * | announcing | announce_done | speak(「要回吗?」) → awaiting_disposition (ship_gate items take the SAME path — no step is ever skipped) |
 * | announcing | founder_speaking_start | stopSpeaking (<100ms barge-in) → awaiting_disposition (item context kept) |
 * | awaiting_disposition | utterance∈SKIP | finish item → next (or idle) |
 * | awaiting_disposition | utterance∈REPLY | speak(「说吧」) → dictating |
 * | awaiting_disposition | utterance∈APPROVE_INTENT ∧ kind=ship_gate | speak(readback「你确认把 {issueRef} ship 上线?」) → awaiting_approval_confirm |
 * | awaiting_disposition | utterance∈APPROVE_INTENT ∧ (kind=normal ∨ kill-switch down) | narrate「这条我这里不能批…回屏幕处理」→ finish (gate stays on the existing text/reaction paths) |
 * | awaiting_disposition | utterance∈PAUSE | speak(「好,先放回队列」) + defer → idle (mode stays ON) |
 * | awaiting_disposition | silence(15s) | speak(「先放回队尾」) + defer → next |
 * | awaiting_disposition | utterance=STOP_WORD | speak(「确认结束耳机模式?」) → confirm_exit |
 * | awaiting_disposition | anything else (unclear) | re-ask「skip 还是要回?」once; unclear again → defer → next |
 * | dictating | utterance(final) | speak(readback「我转告:{text},发吗?」) → readback |
 * | readback | utterance∈CONFIRM | sendReply → sending; done → narrate + finish → next |
 * | readback | utterance∈DENY | speak(「重说一遍?」) → dictating (once; DENY again → defer) |
 * | awaiting_approval_confirm | utterance∈CONFIRM | postReceipt → submitApproval → narrate → finish (receipt-first is a hard gate) |
 * | awaiting_approval_confirm | utterance∈DENY | NO write, narrate「不批,留在 thread」→ finish |
 * | awaiting_approval_confirm | unclear | repeat the readback verbatim once; again (or silence) → NO write, narrate → finish |
 * | awaiting_approval_confirm | utterance=STOP_WORD | discard the attempt (NO write) → speak(「确认结束耳机模式?」) → confirm_exit |
 * | awaiting_approval_confirm | silence(15s) | NO write (silence ≠ consent) → narrate → finish |
 * | confirm_exit | utterance∈CONFIRM | speak(recap) → mode OFF (spoken exit is the OPTIONAL path, Annie ④) |
 * | confirm_exit | anything else / timeout | speak(「继续。」) → previous state |
 * | any (≠sending) | queue_pushed | silently enqueue (mid-turn never interrupts) |
 * | any (≠sending) | presence(false) | stop playback → disconnect_grace, persist {previousState, currentItemId, itemPhase, promptSpoken, enteredAtMs}; from awaiting_approval_confirm the approval attempt is INVALIDATED immediately (Codex R3 #1) — the item goes back to the queue head as a fresh ship_gate turn |
 * | disconnect_grace | presence(true) ≤60s | resume the SAME item — replay the entry prompt per itemPhase; never repeat completed turns/side effects |
 * | disconnect_grace | timeout 60s | mode OFF (MAIN exit path: leaving the VC = exit, Annie ④); recap goes out via onModeOff (text to core channel — she is not in the VC to hear one); queue snapshot survives |
 * | sending | presence(false) | finish the in-flight send first, THEN enter grace (side effects never tear) |
 * | sending | any utterance | dropped (STOP_WORD included — it does not take effect mid-send) |
 */
import {
	APPROVE_INTENT,
	CONFIRM,
	DENY,
	matchPhrase,
	PAUSE,
	REPLY,
	SKIP,
	STOP_WORD,
} from "./phrases.js";
import type { HeadphoneQueue, QueueItem } from "./queue.js";

export type TurnState =
	| "off"
	| "idle"
	| "announcing"
	| "awaiting_detail_choice"
	| "awaiting_disposition"
	| "dictating"
	| "readback"
	| "sending"
	| "awaiting_approval_confirm"
	| "confirm_exit"
	| "disconnect_grace";

export type ItemPhase = "announce" | "ask" | "dictate" | "readback";

export type TurnEvent =
	| { type: "start" }
	| { type: "queue_pushed" }
	| { type: "announce_done"; token: number }
	| { type: "founder_speaking_start" }
	| { type: "utterance"; text: string }
	| { type: "timer"; tag: string }
	| { type: "presence"; inVc: boolean };

export interface HeadphoneIO {
	/** VoiceDirectory resolves the actual voice inside the adapter. */
	speak(agentId: string | "system", text: string): Promise<void>;
	stopSpeaking(): void;
	sendReply(
		item: QueueItem,
		text: string,
	): Promise<{ ok: boolean; sentMessageId?: string }>;
	postReceipt(
		item: QueueItem,
		transcript: string,
	): Promise<{ ok: boolean; receiptMessageId?: string }>;
	submitApproval(
		item: QueueItem,
		transcript: string,
		receiptMessageId: string,
	): Promise<{ ok: boolean; reason?: string; warning?: string }>;
	persist(state: unknown): void;
	now(): number;
}

export interface TimerHost {
	set(tag: string, delayMs: number, fire: () => void): void;
	clear(tag: string): void;
}

export type ModeOffReason = "spoken_exit" | "vc_exit";

export type GraceInfo = {
	previousState: TurnState;
	currentItemId?: string;
	itemPhase?: ItemPhase;
	promptSpoken?: string;
	enteredAtMs: number;
};

export type PersistedTurnState = {
	state: TurnState;
	currentItem?: QueueItem;
	processed: number;
	unclearCount: number;
	denyCount: number;
	dictated?: string;
	grace?: GraceInfo;
	confirmExitReturn?: TurnState;
};

export type Vocabulary = {
	stop: readonly string[];
	skip: readonly string[];
	reply: readonly string[];
	confirm: readonly string[];
	deny: readonly string[];
	approveIntent: readonly string[];
	pause: readonly string[];
};

export interface TurnMachineOptions {
	io: HeadphoneIO;
	queue: HeadphoneQueue;
	timers: TimerHost;
	onModeOff?: (recap: {
		processed: number;
		remaining: number;
		reason: ModeOffReason;
	}) => void;
	silenceMs?: number;
	graceMs?: number;
	longBodyChars?: number;
	vocabulary?: Partial<Vocabulary>;
	restore?: PersistedTurnState;
}

export function formatHeadline(item: QueueItem): string {
	const { agentDisplay, issueRef, issueTitle, stageHint } = item.headline;
	let s = `我是 ${agentDisplay}。`;
	if (issueRef) {
		s += issueRef;
		if (issueTitle) s += `,${issueTitle}`;
		if (stageHint) s += `——${stageHint}`;
		s += "。";
	} else if (stageHint) {
		s += `${stageHint}。`;
	}
	return s;
}

function firstTwoSentences(body: string): string {
	const parts = body.split(/(?<=[。!?!?])/u).filter((p) => p.length > 0);
	return parts.slice(0, 2).join("");
}

const SILENCE = "silence";
const CONFIRM_EXIT = "confirm_exit";
const GRACE = "grace";

export class HeadphoneTurnMachine {
	private _state: TurnState = "off";
	private current?: QueueItem;
	private processed = 0;
	private unclearCount = 0;
	private denyCount = 0;
	private dictated?: string;
	private grace?: GraceInfo;
	private confirmExitReturn?: TurnState;
	private announceToken = 0;
	private pendingGraceAfterSend = false;
	private lastPrompt?: string;
	private readonly silenceMs: number;
	private readonly graceMs: number;
	private readonly longBodyChars: number;
	private readonly vocab: Vocabulary;

	constructor(private readonly opts: TurnMachineOptions) {
		this.silenceMs = opts.silenceMs ?? 15_000;
		this.graceMs = opts.graceMs ?? 60_000;
		this.longBodyChars = opts.longBodyChars ?? 400;
		this.vocab = {
			stop: STOP_WORD,
			skip: SKIP,
			reply: REPLY,
			confirm: CONFIRM,
			deny: DENY,
			approveIntent: APPROVE_INTENT,
			pause: PAUSE,
			...opts.vocabulary,
		};
		if (opts.restore) {
			this._state = opts.restore.state;
			this.current = opts.restore.currentItem;
			this.processed = opts.restore.processed;
			this.unclearCount = opts.restore.unclearCount;
			this.denyCount = opts.restore.denyCount;
			this.dictated = opts.restore.dictated;
			this.grace = opts.restore.grace;
			this.confirmExitReturn = opts.restore.confirmExitReturn;
			if (this._state === "disconnect_grace") this.armTimer(GRACE);
		}
	}

	get state(): TurnState {
		return this._state;
	}

	handleEvent(ev: TurnEvent): void {
		switch (ev.type) {
			case "presence":
				this.onPresence(ev.inVc);
				return;
			case "queue_pushed":
				// mid-turn messages enqueue silently (§17 LOCK ②); only an idle
				// machine reacts by pulling the next item.
				if (this._state === "idle") this.nextItem();
				return;
			case "start":
				if (this._state === "off") {
					this._state = "idle";
					this.persist();
					this.nextItem();
				}
				return;
			case "announce_done":
				if (this._state === "announcing" && ev.token === this.announceToken) {
					this.askDisposition();
				}
				return;
			case "founder_speaking_start":
				if (this._state === "announcing") {
					this.opts.io.stopSpeaking();
					this.announceToken++; // the interrupted speak's done is now stale
					this.toState("awaiting_disposition");
				}
				return;
			case "utterance":
				this.onUtterance(ev.text);
				return;
			case "timer":
				this.onTimer(ev.tag);
				return;
		}
	}

	// ---------- turn flow ----------

	private nextItem(): void {
		const item = this.opts.queue.shift();
		if (!item) {
			this.toState("idle");
			return;
		}
		this.current = item;
		this.unclearCount = 0;
		this.denyCount = 0;
		this.dictated = undefined;
		this.announce(item);
	}

	private announce(item: QueueItem): void {
		const headline = formatHeadline(item);
		if (item.body.length > this.longBodyChars) {
			// §17 two-depth: long messages get headline + summary first.
			this.toState("awaiting_detail_choice");
			this.speakPrompt(
				item.agentId,
				`${headline}${firstTwoSentences(item.body)}要听全文吗?`,
			);
			return;
		}
		this.toState("announcing");
		this.speakAnnouncement(item.agentId, `${headline}${item.body}`);
	}

	private askDisposition(): void {
		this.toState("awaiting_disposition");
		this.speakPrompt(this.current?.agentId ?? "system", "要回吗?");
	}

	private finishItem(): void {
		this.processed++;
		this.current = undefined;
		this.persist();
		if (this.pendingGraceAfterSend) {
			this.pendingGraceAfterSend = false;
			this._state = "idle";
			this.enterGrace();
			return;
		}
		this.nextItem();
	}

	private deferCurrent(toFront = false): void {
		if (this.current) {
			if (toFront) this.opts.queue.deferToFront(this.current);
			else this.opts.queue.defer(this.current);
			this.current = undefined;
		}
	}

	// ---------- utterances ----------

	private onUtterance(text: string): void {
		switch (this._state) {
			case "announcing":
				// spoken input mid-announcement = barge-in carrying content
				this.opts.io.stopSpeaking();
				this.announceToken++;
				this.toState("awaiting_disposition");
				this.onDisposition(text);
				return;
			case "awaiting_detail_choice":
				this.onDetailChoice(text);
				return;
			case "awaiting_disposition":
				this.onDisposition(text);
				return;
			case "dictating":
				this.dictated = text;
				this.toState("readback");
				this.speakPrompt(
					this.current?.agentId ?? "system",
					`我转告:${text},发吗?`,
				);
				return;
			case "readback":
				this.onReadback(text);
				return;
			case "awaiting_approval_confirm":
				this.onApprovalConfirm(text);
				return;
			case "confirm_exit":
				this.onConfirmExit(text);
				return;
			case "idle":
				if (matchPhrase(text, this.vocab.stop)) this.enterConfirmExit("idle");
				return;
			default:
				// sending / disconnect_grace / off: utterances are dropped —
				// STOP_WORD explicitly does not take effect mid-send.
				return;
		}
	}

	private onDetailChoice(text: string): void {
		if (matchPhrase(text, this.vocab.stop)) {
			this.enterConfirmExit("awaiting_detail_choice");
			return;
		}
		if (matchPhrase(text, this.vocab.confirm)) {
			const item = this.current;
			if (!item) return;
			this.toState("announcing");
			this.speakAnnouncement(
				item.agentId,
				`${formatHeadline(item)}${item.body}`,
			);
			return;
		}
		// SKIP / DENY / anything else: skip the full text, go to the ask.
		this.askDisposition();
	}

	private onDisposition(text: string): void {
		const item = this.current;
		if (!item) return;
		if (matchPhrase(text, this.vocab.stop)) {
			this.enterConfirmExit("awaiting_disposition");
			return;
		}
		if (matchPhrase(text, this.vocab.skip)) {
			this.finishItem();
			return;
		}
		if (matchPhrase(text, this.vocab.reply)) {
			this.toState("dictating");
			this.speakPrompt(item.agentId, "说吧");
			return;
		}
		if (matchPhrase(text, this.vocab.pause)) {
			this.speakPrompt("system", "好,先放回队列");
			this.deferCurrent();
			this.toState("idle");
			return;
		}
		if (matchPhrase(text, this.vocab.approveIntent)) {
			if (item.kind === "ship_gate") {
				this.toState("awaiting_approval_confirm");
				const readback = `你确认把 ${item.headline.issueRef ?? item.gate?.issueId ?? "这条"} ship 上线?`;
				this.lastPrompt = readback;
				this.speakPrompt(item.agentId, readback);
				return;
			}
			this.speakPrompt(
				item.agentId,
				"这条我这里不能批,收据/原消息在 thread,回屏幕处理",
			);
			this.finishItem();
			return;
		}
		// unclear
		this.unclearCount++;
		if (this.unclearCount === 1) {
			this.toState("awaiting_disposition"); // re-arm the silence timer
			this.speakPrompt(item.agentId, "skip 还是要回?");
			return;
		}
		this.speakPrompt("system", "先放回队尾");
		this.deferCurrent();
		this.nextItem();
	}

	private onReadback(text: string): void {
		const item = this.current;
		if (!item) return;
		if (matchPhrase(text, this.vocab.confirm)) {
			const reply = this.dictated ?? "";
			this.toState("sending");
			void this.runSend(item, reply);
			return;
		}
		if (matchPhrase(text, this.vocab.deny)) {
			this.denyCount++;
			if (this.denyCount === 1) {
				this.toState("dictating");
				this.speakPrompt(item.agentId, "重说一遍?");
				return;
			}
			this.speakPrompt("system", "先放回队尾");
			this.deferCurrent();
			this.nextItem();
			return;
		}
		// unclear: repeat the readback once, then defer.
		this.unclearCount++;
		if (this.unclearCount <= 1) {
			this.speakPrompt(item.agentId, `我转告:${this.dictated},发吗?`);
			return;
		}
		this.speakPrompt("system", "先放回队尾");
		this.deferCurrent();
		this.nextItem();
	}

	private onApprovalConfirm(text: string): void {
		const item = this.current;
		if (!item) return;
		if (matchPhrase(text, this.vocab.stop)) {
			// discard the approval attempt FIRST (nothing has been written).
			this.enterConfirmExit("awaiting_disposition");
			return;
		}
		if (matchPhrase(text, this.vocab.confirm)) {
			this.toState("sending");
			void this.runApproval(item, text);
			return;
		}
		if (matchPhrase(text, this.vocab.deny)) {
			this.speakPrompt(item.agentId, "不批,留在 thread。");
			this.finishItem();
			return;
		}
		// unclear: repeat the readback VERBATIM once; again → no write.
		this.unclearCount++;
		if (this.unclearCount <= 1 && this.lastPrompt) {
			this.toState("awaiting_approval_confirm"); // re-arm silence
			this.speakPrompt(item.agentId, this.lastPrompt);
			return;
		}
		this.speakPrompt(item.agentId, "这条不批了,原消息在 thread,回屏幕处理。");
		this.finishItem();
	}

	private onConfirmExit(text: string): void {
		if (matchPhrase(text, this.vocab.confirm)) {
			this.exitMode("spoken_exit");
			return;
		}
		this.resumeFromConfirmExit();
	}

	// ---------- async side-effect runs (state: sending) ----------

	private async runSend(item: QueueItem, text: string): Promise<void> {
		const res = await this.opts.io.sendReply(item, text);
		if (res.ok && res.sentMessageId) {
			item.sideEffects = {
				...item.sideEffects,
				sentMessageId: res.sentMessageId,
			};
			this.persist();
		}
		this.speakPrompt(
			item.agentId,
			res.ok ? "发出了。" : "发送失败,原消息在 thread,回屏幕看一下。",
		);
		this.finishItem();
	}

	private async runApproval(
		item: QueueItem,
		transcript: string,
	): Promise<void> {
		// Receipt-first (§14 c: 文字是收据) — no receipt, no approval write.
		const receipt = await this.opts.io.postReceipt(item, transcript);
		if (!receipt.ok || !receipt.receiptMessageId) {
			this.speakPrompt(item.agentId, "收据没发出去,这条不批,回屏幕处理。");
			this.finishItem();
			return;
		}
		item.sideEffects = {
			...item.sideEffects,
			receiptMessageId: receipt.receiptMessageId,
		};
		this.persist();
		const res = await this.opts.io.submitApproval(
			item,
			transcript,
			receipt.receiptMessageId,
		);
		// The attempt id is recorded only AFTER the call returned (Codex R1
		// MEDIUM-3): a crash BEFORE/DURING the call leaves no attempt marker, so
		// boot recovery re-queues the item as a fresh ship_gate turn — her
		// confirmed approval is never silently lost, and a duplicate write is
		// impossible anyway (writeGateResponse is idempotent). attemptId present
		// = the Bridge answered; recovery suppresses re-submission.
		item.sideEffects = { ...item.sideEffects, approvalAttemptId: item.id };
		this.persist();
		this.speakPrompt(
			item.agentId,
			res.ok
				? (res.warning ?? "已 ship。")
				: `没批成:${res.reason ?? "未知原因"},收据在 thread,回屏幕处理。`,
		);
		this.finishItem();
	}

	// ---------- spoken exit ----------

	private enterConfirmExit(returnTo: TurnState): void {
		this.confirmExitReturn = returnTo;
		this.toState("confirm_exit");
		this.speakPrompt("system", "确认结束耳机模式?");
	}

	private resumeFromConfirmExit(): void {
		const back = this.confirmExitReturn ?? "idle";
		this.confirmExitReturn = undefined;
		this.speakPrompt("system", "继续。");
		if (back === "idle" || !this.current) {
			this.toState("idle");
			this.nextItem();
			return;
		}
		this.toState(back);
	}

	private exitMode(reason: ModeOffReason): void {
		this.deferCurrent(true);
		const remaining = this.opts.queue.size();
		if (reason === "spoken_exit") {
			this.speakPrompt(
				"system",
				`好。这次处理了 ${this.processed} 条,剩 ${remaining} 条留在 Discord。耳机模式结束。`,
			);
		}
		// vc_exit: she is no longer in the VC — the recap goes out as TEXT via
		// onModeOff (daemon posts it to the core channel).
		this.grace = undefined;
		this.confirmExitReturn = undefined;
		this.toState("off");
		this.opts.onModeOff?.({ processed: this.processed, remaining, reason });
	}

	// ---------- presence / disconnect grace (Annie ④: leaving VC = exit,
	// with a 60s reconnect debounce) ----------

	private onPresence(inVc: boolean): void {
		if (!inVc) {
			if (this._state === "off" || this._state === "disconnect_grace") {
				return;
			}
			if (this._state === "sending") {
				// never tear an in-flight side effect — grace starts after it lands.
				this.pendingGraceAfterSend = true;
				return;
			}
			this.enterGrace();
			return;
		}
		if (this._state !== "disconnect_grace") return;
		this.opts.timers.clear(GRACE);
		this.resumeFromGrace();
	}

	private enterGrace(): void {
		this.opts.io.stopSpeaking();
		this.announceToken++;
		this.opts.timers.clear(SILENCE);
		this.opts.timers.clear(CONFIRM_EXIT);
		let itemPhase: ItemPhase | undefined;
		switch (this._state) {
			case "announcing":
			case "awaiting_detail_choice":
				itemPhase = "announce";
				break;
			case "awaiting_disposition":
				itemPhase = "ask";
				break;
			case "dictating":
				itemPhase = "dictate";
				break;
			case "readback":
				itemPhase = "readback";
				break;
			case "confirm_exit":
				itemPhase = this.current ? "ask" : undefined;
				break;
			case "awaiting_approval_confirm":
				// The approval attempt is INVALIDATED the moment she leaves
				// (Codex R3 #1): the old readback can never be confirmed again.
				// The item goes back to the queue head as a brand-new ship_gate
				// turn (full APPROVE_INTENT → readback → CONFIRM required).
				this.deferCurrent(true);
				itemPhase = undefined;
				break;
			default:
				itemPhase = undefined;
		}
		this.grace = {
			previousState: this._state,
			currentItemId: this.current?.id,
			itemPhase,
			promptSpoken: this.lastPrompt,
			enteredAtMs: this.opts.io.now(),
		};
		this._state = "disconnect_grace";
		this.persist();
		this.armTimer(GRACE);
	}

	private resumeFromGrace(): void {
		const g = this.grace;
		this.grace = undefined;
		const item = this.current;
		if (!g || !item || !g.itemPhase) {
			this.toState("idle");
			this.nextItem();
			return;
		}
		switch (g.itemPhase) {
			case "announce":
				this.announce(item);
				return;
			case "ask":
				this.askDisposition();
				return;
			case "dictate":
				this.toState("dictating");
				this.speakPrompt(item.agentId, "说吧");
				return;
			case "readback":
				this.toState("readback");
				this.speakPrompt(item.agentId, `我转告:${this.dictated},发吗?`);
				return;
		}
	}

	// ---------- timers ----------

	private onTimer(tag: string): void {
		switch (tag) {
			case SILENCE:
				if (this._state === "awaiting_detail_choice") {
					this.askDisposition();
					return;
				}
				if (this._state === "awaiting_disposition") {
					this.speakPrompt("system", "先放回队尾");
					this.deferCurrent();
					this.nextItem();
					return;
				}
				if (this._state === "awaiting_approval_confirm") {
					// silence ≠ consent — never write.
					this.speakPrompt(
						this.current?.agentId ?? "system",
						"这条不批了,原消息在 thread,回屏幕处理。",
					);
					this.finishItem();
					return;
				}
				return;
			case CONFIRM_EXIT:
				if (this._state === "confirm_exit") this.resumeFromConfirmExit();
				return;
			case GRACE:
				if (this._state === "disconnect_grace") this.exitMode("vc_exit");
				return;
			default:
				return;
		}
	}

	// ---------- plumbing ----------

	private toState(s: TurnState): void {
		this.opts.timers.clear(SILENCE);
		this.opts.timers.clear(CONFIRM_EXIT);
		this._state = s;
		if (
			s === "awaiting_disposition" ||
			s === "awaiting_detail_choice" ||
			s === "awaiting_approval_confirm"
		) {
			this.armTimer(SILENCE);
		}
		if (s === "confirm_exit") this.armTimer(CONFIRM_EXIT);
		this.persist();
	}

	private armTimer(tag: string): void {
		const ms = tag === GRACE ? this.graceMs : this.silenceMs;
		this.opts.timers.set(tag, ms, () =>
			this.handleEvent({ type: "timer", tag }),
		);
	}

	private speakPrompt(agentId: string | "system", text: string): void {
		if (
			this._state === "awaiting_disposition" ||
			this._state === "dictating" ||
			this._state === "readback" ||
			this._state === "awaiting_approval_confirm"
		) {
			this.lastPrompt = text;
		}
		void this.opts.io.speak(agentId, text).catch(() => {
			/* prompt playback failure is not a state transition */
		});
	}

	private speakAnnouncement(agentId: string, text: string): void {
		const token = ++this.announceToken;
		this.lastPrompt = text;
		// announce_done is chained on the speak promise; a stale token (barge-in,
		// grace, replaced announcement) is ignored by the handler. TTS failure
		// also completes the announcement — a broken speaker must not wedge the
		// queue.
		void this.opts.io.speak(agentId, text).then(
			() => this.handleEvent({ type: "announce_done", token }),
			() => this.handleEvent({ type: "announce_done", token }),
		);
	}

	/** the same snapshot shape io.persist receives (daemon state file). */
	persistedSnapshot(): PersistedTurnState {
		return {
			state: this._state,
			currentItem: this.current,
			processed: this.processed,
			unclearCount: this.unclearCount,
			denyCount: this.denyCount,
			dictated: this.dictated,
			grace: this.grace,
			confirmExitReturn: this.confirmExitReturn,
		};
	}

	private persist(): void {
		this.opts.io.persist(this.persistedSnapshot());
	}
}
