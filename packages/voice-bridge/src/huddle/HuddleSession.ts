/**
 * HuddleSession (FLY-545 PR-2 P11′) — the meeting's state machine and the
 * conductor of the A10 multi-session engine:
 *
 *   invoked → assembling → live → concluding → landing → teardown
 *
 * One Gemini Live session per participating Lead (a LeadLine = session +
 * mouth); the founder's audio feeds ONLY the addressed line (AddressRouter,
 * sticky on the host); everyone else is caught up through the FeedPipeline's
 * silent injections. One mouth at a time: a line that starts answering
 * without holding the speaking grant is interrupted and its audio lands on a
 * closed mouth gate (FLY-968's over-answering lesson enforced at runtime).
 *
 * The wiring (cli) owns real Discord/Gemini objects and forwards their events
 * into the handle* methods here — this class holds ALL the meeting logic and
 * none of the SDKs, so the whole lifecycle is unit-testable with fakes.
 */
import type { AudioFormat } from "flywheel-voice-core";
import type { CreatedIssue } from "../linear/BridgeLinearClient.js";
import type { AddressRouter } from "./AddressRouter.js";
import type { ConfirmationLadder } from "./ConfirmationLadder.js";
import { isUnconditionalAffirm } from "./confirm-heuristics.js";
import type { FeedPipeline } from "./FeedPipeline.js";

export type HuddleState =
	| "idle"
	| "assembling"
	| "live"
	| "concluding"
	| "landing"
	| "teardown";

/** the narrow session surface a line must offer (rotator-compatible). */
export interface LineSession {
	sendAudio(frame: Buffer, format: AudioFormat): void;
	/** speech-TRIGGERING text turn (control prompts, handoff turns). */
	sendText(text: string): void;
	/** SILENT context feed. */
	injectContext(text: string): void;
	interrupt(): void;
	/** close the user's audio turn — used only by the abort-window replay
	 * (QA R5): a replayed utterance she already finished needs an explicit
	 * end or the successor session's VAD waits forever. Optional so existing
	 * fakes/adapters without it stay valid; replay simply skips the close. */
	endUserTurn?(): void;
}

export interface LineMouth {
	beginTurn(): void;
	feed(chunk: Buffer): void;
	endTurn(): void;
	flush(): void;
	noteToolCall(): void;
	noteToolResolved(): void;
}

/** FLY-1160 §4.1 resident mode: a line whose THINKING is a resident Claude brain
 * (not Gemini). When a HuddleLine carries `resident`, HuddleSession drives it
 * instead of the Gemini response flow — a founder turn becomes brain.respond(),
 * a barge-in becomes bargeIn(). The wiring forwards the driver's speaking/answer/
 * error events back into the handleResident* methods below (the parallel of the
 * Gemini response-started/done/error forwarding). */
export interface ResidentLineControl {
	/** answer a founder turn: brain.respond(text) stream → the line's text mouth. */
	respond(text: string): void;
	/** barge-in / interrupt: stop the mouth (sync) + end the in-flight turn. */
	bargeIn(): void;
}

export interface HuddleLine {
	leadId: string;
	displayName: string;
	session: LineSession;
	mouth: LineMouth;
	/** present ⇒ this line is a resident-brain line (FLY-1160 §4.1). */
	resident?: ResidentLineControl;
}

export interface HuddleTiv {
	presence(
		state: "connecting" | "listening" | "thinking" | "speaking" | "paused",
		detail?: string,
	): void;
	caption(speaker: string, text: string): void;
	warn(text: string): void;
}

export interface HuddleSessionOptions {
	issue: CreatedIssue;
	hostLeadId: string;
	lines: HuddleLine[];
	router: AddressRouter;
	feed: FeedPipeline;
	ladder: Pick<ConfirmationLadder, "notifyFounderUtterance">;
	tiv: HuddleTiv;
	conclusion: {
		land(input: {
			issue: CreatedIssue;
			confirmed: boolean;
			journalSnapshot: string;
		}): Promise<"landed" | "failed">;
		abortNoShow(issue: CreatedIssue): Promise<void>;
	};
	/** called when the meeting is over — wiring leaves VC / releases the slot. */
	onTeardown: () => Promise<void> | void;
	/** assembling window before a no-show abort; default 10min. */
	assembleTimeoutMs?: number;
	/** thinking-stall watchdog: no model progress for this long after she
	 * finished speaking → visible "it's slow, not broken" cue; default 20s. */
	thinkingWatchdogMs?: number;
	setTimeoutFn?: typeof setTimeout;
	log?: (line: string) => void;
}

const DEFAULT_ASSEMBLE_TIMEOUT_MS = 10 * 60_000;
/** speaking stopped → wait this long for straggling STT fragments before
 * committing the founder utterance (QA R2 F3). */
const FOUNDER_STT_TAIL_MS = 700;
const DEFAULT_THINKING_WATCHDOG_MS = 20_000;
/** rolling cap for the abort-window utterance buffer (QA R5): 30s of
 * 16 kHz mono pcm16 — long past any spoken huddle turn, small enough to
 * hold in memory per meeting. */
export const FOUNDER_AUDIO_BUFFER_MAX_BYTES = 16_000 * 2 * 30;
const CONCLUDE_RE = /(就这样|就先这样|结束|先到这|收工|到此为止)/;

export class HuddleSession {
	private state: HuddleState = "idle";
	private readonly lines: Map<string, HuddleLine>;
	/** the line allowed to open its mouth for the current turn. */
	private expectedSpeaker?: string;
	/** the line whose turn is actually streaming right now. */
	private currentSpeaker?: string;
	/** RESIDENT mode (Codex R2 HIGH-2): the resident line that currently owns the
	 * floor — set the instant a resident turn is KICKED OFF (host control turn OR
	 * addressed founder turn), so a barge-in in the pre-first-delta or mouth-drain
	 * window (where currentSpeaker is unset) still cuts the RIGHT line, not the
	 * router's addressed line (which a host recap does not move). */
	private residentFloor?: string;
	/** FLY-1190: per-line COUNT of resident answer turns genuinely IN FLIGHT.
	 * Incremented when a turn is kicked off (speakThrough), decremented when ONE
	 * turn settles (handleResidentAnswer clean / handleResidentError fail), zeroed
	 * when ALL turns for a line are cancelled (interruptLine barge / teardown).
	 * A COUNT — not a single marker (Codex R14) — because the ResidentLineDriver
	 * serializes turns: turn B can queue behind a still-streaming A on the SAME
	 * line, and A settling must not zero B's in-flight status. Unlike `residentFloor`
	 * (which deliberately STAYS on the last floor-holder past mouth-drain so a late
	 * barge still lands, R12), this is strictly "a turn is thinking or speaking right
	 * now" — the only correct signal for whether an ears-only STT flap must leave the
	 * turn's status/watchdog alone. */
	private readonly residentTurnsInFlight = new Map<string, number>();
	/** per-line accumulated assistant transcript for the streaming turn. */
	private readonly turnText = new Map<string, string>();
	private assembleTimer?: ReturnType<typeof setTimeout>;
	/** accumulated non-final founder transcript fragments (QA R2 F3). */
	private pendingFounderText = "";
	private founderFlushTimer?: ReturnType<typeof setTimeout>;
	/** PER-LINE debounce-committed text of that line's current user turn —
	 * the line's aggregate (final:true) dedupes against (and consumes) its
	 * OWN record instead of re-committing (Codex R17). Per-line because
	 * routing can switch between the debounce commit and the aggregate's
	 * arrival: a stale record from line A must never eat line B's turn
	 * (R19), and a record must die with its own line's aggregate or routing
	 * ping-pong (eng→joy→eng) replays the revived turn (R20). */
	private readonly founderTurnCommitted = new Map<string, string>();
	private thinkingWatchdog?: ReturnType<typeof setTimeout>;
	/** QA R4 (c): one stall-warning per wait — Annie saw the same ⚠️ twice.
	 * Cleared only by REAL model progress (or reconnect/teardown). */
	private thinkingWarned = false;
	private landed = false;
	/** QA R5 (FLY-1186): rolling audio buffer of the CURRENT founder
	 * utterance, keyed to the line it was sent to. An STT connection that
	 * dies mid-utterance (or before the turn aggregate lands) silently ate
	 * her words — on reconnect the buffered frames are re-sent so the
	 * successor session transcribes what she actually said. Cleared when the
	 * utterance commits while the line is UP (transcription trustworthy). */
	private founderAudio?: {
		leadId: string;
		format: AudioFormat;
		frames: Buffer[];
		bytes: number;
	};
	/** ears-driven utterance boundary: first frame after a speech-stop
	 * starts a NEW utterance (and a fresh buffer). */
	private founderSpeaking = false;
	/** lines currently inside a connection-death window (down → reconnected). */
	private readonly linesDown = new Set<string>();
	/** lines whose replay landed while she was STILL talking — the coming
	 * speech-stop must close the successor's audio turn (Codex R35 HIGH-2). */
	private readonly replayOpenTurns = new Set<string>();
	/** lines whose rotation is EXHAUSTED — permanently dead for this meeting
	 * (Codex R36 HIGH-2): audio must not keep feeding them, and the status
	 * must never flip back to a "thinking" lie. */
	private readonly linesFailed = new Set<string>();
	/** speech-triggering handoff turns queued for a line inside its reconnect
	 * window (Codex R38 MEDIUM-2): a sendText into the rotation gap drops
	 * silently (no session) and the feed excluded the target — delivered on
	 * that line's reconnect instead. */
	private readonly pendingHandoffs = new Map<string, string>();
	/** per-line partial transcription suppressed during a down window
	 * (Codex R36 MEDIUM-3): the replay normally supersedes it, but if the
	 * reconnect ultimately FAILS this is all that's left of her words —
	 * journaled record-only at that point, never semantically committed. */
	private readonly suppressedPartial = new Map<string, string>();
	/** observability: turns from lines that never held the grant. */
	ungrantedTurns = 0;

	constructor(private readonly opts: HuddleSessionOptions) {
		this.lines = new Map(opts.lines.map((l) => [l.leadId, l]));
		if (!this.lines.has(opts.hostLeadId)) {
			throw new Error(
				`HuddleSession: host "${opts.hostLeadId}" has no LeadLine`,
			);
		}
	}

	get currentState(): HuddleState {
		return this.state;
	}

	/** invoked → assembling (bots/lines are already up — wiring did that). */
	start(): void {
		this.state = "assembling";
		this.opts.tiv.presence("listening", "等 Annie 进来");
		const st = this.opts.setTimeoutFn ?? setTimeout;
		this.assembleTimer = st(() => {
			if (this.state !== "assembling") return;
			this.opts.log?.("[huddle] assembling timed out — no-show abort");
			this.opts.tiv.warn("这场没开成(超时没等到人)— 立项 issue 自动关闭。");
			void this.opts.conclusion
				.abortNoShow(this.opts.issue)
				.finally(() => this.teardown());
		}, this.opts.assembleTimeoutMs ?? DEFAULT_ASSEMBLE_TIMEOUT_MS);
		this.assembleTimer.unref?.();
	}

	/** founder joined/left the VC (voiceStateUpdate). */
	handleFounderVoiceState(joined: boolean): void {
		if (joined) {
			if (this.state === "assembling") {
				if (this.assembleTimer) clearTimeout(this.assembleTimer);
				this.state = "live";
				// host greets her the moment she lands (she must feel caught).
				this.grantTo(this.opts.hostLeadId);
				this.speakThrough(
					this.host,
					"[控制] founder 刚进语音频道。用一两句招呼她,报一下这场 huddle 是聊什么的(看立项标题),然后把话头交给她。",
				);
				// the ONE moment lines are live AND she is present — this is where
				// "可以说话了" belongs (Codex R13 MEDIUM: announcing it at assembly
				// end got stomped by the assembling state a tick later).
				this.opts.tiv.presence("listening", "可以说话了");
			}
			return;
		}
		if (this.state === "live") {
			// leaving IS a conclude signal (PRD §13) — degraded: no verbal confirm.
			this.opts.log?.("[huddle] founder left mid-meeting — degraded landing");
			void this.landNow(false);
		}
	}

	/** one 16k mono founder frame from the Note-taker — addressed line only. */
	handleFounderFrame(frame: Buffer, format: AudioFormat): void {
		if (this.state !== "live" && this.state !== "concluding") return;
		const addressed = this.addressedLine;
		// a permanently failed line must not eat her audio — the frames would
		// drop silently in the dead rotator (Codex R36 HIGH-2). With the
		// failure auto-switch this only holds when EVERY line is dead.
		if (this.linesFailed.has(addressed.leadId)) return;
		// QA R5: buffer the CURRENT utterance so an STT abort can replay it.
		// A first frame after speech-stop (or a routing move) starts a fresh
		// utterance — if the previous one was still unrecovered when she chose
		// to speak again, her re-speak IS the recovery; keep only the latest.
		if (
			!this.founderSpeaking ||
			this.founderAudio?.leadId !== addressed.leadId
		) {
			this.founderAudio = {
				leadId: addressed.leadId,
				format,
				frames: [],
				bytes: 0,
			};
		}
		this.founderSpeaking = true;
		const buf = this.founderAudio;
		buf.frames.push(frame);
		buf.bytes += frame.length;
		while (
			buf.bytes > FOUNDER_AUDIO_BUFFER_MAX_BYTES &&
			buf.frames.length > 1
		) {
			const dropped = buf.frames.shift();
			buf.bytes -= dropped?.length ?? 0;
		}
		addressed.session.sendAudio(frame, format);
	}

	/** speak to the founder through the HOST's mouth (ladder readbacks,
	 * narrations). Public because outside callers (ConfirmationLadder wiring)
	 * must ride the speaking grant — an un-granted host turn would be cut by
	 * the one-mouth belt like any other. */
	promptHost(text: string): void {
		this.grantTo(this.opts.hostLeadId);
		this.speakThrough(
			this.host,
			`[控制] 请照这个意思对 founder 说:「${text}」`,
		);
	}

	/** the backchannel gate fired a REAL barge-in. */
	handleBargeIn(): void {
		// interrupt whoever holds the floor: the streaming line (currentSpeaker),
		// else — RESIDENT mode — the resident line that owns the floor across the
		// pre-first-delta + mouth-drain windows (Codex R1/R2 HIGH-1/HIGH-2). A
		// Gemini line has no resident floor, so `residentFloor` is undefined there.
		const target = this.currentSpeaker ?? this.residentFloor;
		const targetLine = target ? this.lines.get(target) : undefined;
		// Codex R2 HIGH-3 / R4: outside live/concluding, a barge-in must NOT
		// interrupt the host RESIDENT's final-turn minutes (which run in "landing"
		// and end cleanly on interrupt → a truncated summary would land). This
		// no-op is scoped to a RESIDENT target ONLY — a Gemini line still
		// interrupts+flushes exactly as in 545 (e.g. founder leaves mid-response →
		// landing → barge-in), so the default path stays byte-compat.
		if (
			this.state !== "live" &&
			this.state !== "concluding" &&
			targetLine?.resident
		) {
			this.opts.tiv.presence("listening");
			return;
		}
		if (targetLine) {
			this.interruptLine(targetLine);
			this.currentSpeaker = undefined;
		}
		this.opts.tiv.presence("listening");
	}

	/** she stopped talking (EarsReceiver speaking-end) → thinking cue + arm
	 * the founder-transcript flush (QA R2 F2b/F3). The cue is what lets her
	 * tell "it's thinking" from "it's broken". */
	handleFounderSpeechStopped(): void {
		if (this.state !== "live" && this.state !== "concluding") return;
		this.founderSpeaking = false;
		// QA R5 (Codex R35 HIGH-2 / R36 HIGH-1): a reconnect replayed her
		// utterance while she was STILL talking — this speech-stop is that
		// turn's real end; close it explicitly or the successor's VAD waits
		// for silence Discord suppression never sends. Closed by the replay
		// OWNER, not the currently addressed line: the replayed aggregate may
		// have moved the routing pointer before she stopped.
		for (const id of [...this.replayOpenTurns]) {
			this.replayOpenTurns.delete(id);
			this.lines.get(id)?.session.endUserTurn?.();
		}
		// terminal failure must never flip back into a "thinking" lie
		// (Codex R36 HIGH-2) — with the auto-switch this means EVERY line died.
		if (this.linesFailed.has(this.router.addressed)) {
			this.opts.tiv.presence("paused", "语音线路重连失败 — 结束会议重开吧");
			return;
		}
		// QA R5 F2: her line is DOWN — "thinking" would be a lie (nothing is
		// processing) and the stall watchdog would cry "slow" over a broken
		// pipe. Tell the truth; the reconnect replay picks her words up.
		if (this.linesDown.has(this.router.addressed)) {
			this.opts.tiv.presence(
				"connecting",
				"线路恢复中 — 接回后我会补听你刚才说的",
			);
			this.armFounderFlush();
			return;
		}
		this.opts.tiv.presence("thinking");
		this.addressedLine.mouth.noteToolCall();
		this.armFounderFlush();
		this.armThinkingWatchdog();
	}

	/** QA R3 P1 (状态撒谎): "thinking" used to be a VAD guess that stayed up
	 * even when the pipeline was WEDGED — she couldn't tell broken from slow.
	 * Real model progress (response-started / assistant fragments) clears the
	 * watchdog; a stall past the window says so, visibly. */
	private armThinkingWatchdog(): void {
		this.clearThinkingWatchdog();
		const st = this.opts.setTimeoutFn ?? setTimeout;
		this.thinkingWatchdog = st(() => {
			this.thinkingWatchdog = undefined;
			if (this.state !== "live" && this.state !== "concluding") return;
			this.opts.tiv.presence("thinking", "等得有点久 — 后台还在处理");
			if (!this.thinkingWarned) {
				this.thinkingWarned = true;
				this.opts.tiv.warn(
					"这轮回答等得比平时久,后台还在处理;要是再没动静就是卡住了,可以再说一遍或换个问法。",
				);
			}
		}, this.opts.thinkingWatchdogMs ?? DEFAULT_THINKING_WATCHDOG_MS);
		this.thinkingWatchdog.unref?.();
	}

	private clearThinkingWatchdog(): void {
		if (this.thinkingWatchdog) {
			clearTimeout(this.thinkingWatchdog);
			this.thinkingWatchdog = undefined;
		}
	}

	/** a line's connection DIED and a reconnect rotation is starting
	 * (rotator onDown, QA R5 F2). The status must tell the truth — a
	 * "thinking" cue over a dead pipe is exactly the lie FLY-1186 died on. */
	/** FLY-1190: a resident line whose ANSWER turn is in flight (kicked off →
	 * speaking) — its status (presence + stall watchdog) belongs to that turn, NOT
	 * to an ears-only STT reconnect. An STT flap here must leave "speaking" and the
	 * watchdog alone; the resident turn lives on the brain, not this STT session. */
	private residentTurnInFlight(leadId: string): boolean {
		// A COUNT, not residentFloor (Codex R12: floor stays past mouth-drain) nor a
		// single marker (Codex R14: a queued turn B behind a settling A would be
		// under-counted). TRUE iff a resident line has ≥1 turn thinking or speaking.
		return (
			!!this.lines.get(leadId)?.resident &&
			(this.residentTurnsInFlight.get(leadId) ?? 0) > 0
		);
	}

	/** FLY-1190: settle ONE in-flight resident turn (a clean completion or a real
	 * failure — each fires exactly one driver callback). A barge-in/teardown CANCEL
	 * instead zeroes the line (it aborts the whole serial set silently), so this is
	 * only for the per-turn settle path. Floors at 0. */
	private settleResidentTurn(leadId: string): void {
		const n = this.residentTurnsInFlight.get(leadId) ?? 0;
		if (n <= 1) this.residentTurnsInFlight.delete(leadId);
		else this.residentTurnsInFlight.set(leadId, n - 1);
	}

	handleLineDown(leadId: string): void {
		this.linesDown.add(leadId);
		// a marker from a previous replay belongs to the session that just
		// died — the next reconnect re-establishes it if still needed
		// (Codex R36 HIGH-1 double-flap residue).
		this.replayOpenTurns.delete(leadId);
		if (this.state !== "live" && this.state !== "concluding") return;
		// a background line's flap must not stomp the live conversation's
		// status (Codex R35 MEDIUM-4) — the wiring's warn covers it.
		if (this.router.addressed !== leadId) return;
		// FLY-1190: don't stomp a live resident answer's "speaking" status / watchdog.
		if (this.residentTurnInFlight(leadId)) return;
		this.clearThinkingWatchdog();
		this.opts.tiv.presence("connecting", "线路闪断,正在恢复 — 稍等");
	}

	/** the line's connection rotated back up (reconnect) — its dead turn must
	 * not hold the floor: clear speaker/turn state so the NEXT turn is audible
	 * (the wiring flushes the line's mouth in the same breath). QA R3 P0. */
	handleLineReconnected(leadId: string): {
		replayed: boolean;
		handoffDelivered: boolean;
	} {
		this.linesDown.delete(leadId);
		this.linesFailed.delete(leadId);
		// FLY-1190: a resident line's ANSWER turn lives on the brain
		// (ResidentLineDriver), NOT on this Gemini STT session — an ears-only
		// reconnect must not kill an in-flight resident answer. The "dead turn"
		// cleanup (turnText + currentSpeaker) is only correct when the dying
		// session WAS the answer engine (gemini). Skip it for a resident line;
		// its audio replay + handoff below stay engine-agnostic.
		const isResident = !!this.lines.get(leadId)?.resident;
		if (!isResident) {
			this.turnText.set(leadId, "");
			if (this.currentSpeaker === leadId) this.currentSpeaker = undefined;
		}
		// state resets are ADDRESSED-scoped (Codex R36 MEDIUM-4): a background
		// line's recovery must not disarm the watchdog guarding the addressed
		// line's in-flight answer, nor announce anything.
		// FLY-1190: nor may an ears-only STT flap DURING a resident answer disarm
		// that answer's own stall watchdog — a pre-first-delta flap would silence
		// the stall warning of a resident turn that is still thinking. The resident
		// turn owns the watchdog; leave it alone while the turn is in flight.
		const isAddressed = leadId === this.router.addressed;
		if (isAddressed && !this.residentTurnInFlight(leadId)) {
			this.clearThinkingWatchdog();
			this.thinkingWarned = false;
		}
		// Codex R38 MEDIUM-2: a queued speech-triggering handoff is delivered
		// the moment the line is back — BEFORE the audio replay, keeping her
		// turns in the order she actually spoke them. Reported to the wiring
		// (Codex R39 MEDIUM-2): a delivered handoff must not be followed by a
		// contradictory '请再说一遍'.
		let handoffDelivered = false;
		const handoff = this.pendingHandoffs.get(leadId);
		if (
			handoff !== undefined &&
			(this.state === "live" || this.state === "concluding")
		) {
			this.pendingHandoffs.delete(leadId);
			// FLY-1160 §4.1 (545-fold seam): drain through speakThrough for the SAME
			// reason the queue site uses it — a resident line has no Gemini answer
			// turn, so a raw session.sendText here would silently swallow the queued
			// handoff. Gemini path is byte-identical to the previous sendText.
			const target = this.lines.get(leadId);
			if (target) this.speakThrough(target, `[Annie 在点名你] ${handoff}`);
			handoffDelivered = true;
		}
		// QA R5 P0: re-send the buffered utterance into the successor session
		// — the abort window must not eat her words. The buffer survives the
		// replay (a second flap before the commit replays again); the commit
		// that follows a successful transcription clears it. GATED on a live
		// meeting (Codex R38 HIGH-1): at landing the partial record has
		// already been journaled — a replay would destroy it and produce a
		// transcript nothing can commit.
		let replayed = false;
		const buf = this.founderAudio;
		if (
			(this.state === "live" || this.state === "concluding") &&
			buf &&
			buf.leadId === leadId &&
			buf.frames.length > 0
		) {
			const line = this.lines.get(leadId);
			if (line) {
				// the successor re-transcribes the utterance from scratch — every
				// pre-abort transcription remnant must go first, or the fresh
				// fragments double on top of them (Codex R35 HIGH-1).
				this.pendingFounderText = "";
				if (this.founderFlushTimer) {
					clearTimeout(this.founderFlushTimer);
					this.founderFlushTimer = undefined;
				}
				this.founderTurnCommitted.delete(leadId);
				// the suppressed partial is NOT cleared here (Codex R39 HIGH-1):
				// the replay only re-SENDS her audio — until the successor's
				// transcript actually commits, the partial is still the only
				// textual record. commitFounderUtterance clears it.
				for (const f of buf.frames) line.session.sendAudio(f, buf.format);
				if (this.founderSpeaking) {
					// she is still talking — live frames continue into the
					// successor; the coming speech-stop closes the turn
					// (Codex R35 HIGH-2).
					this.replayOpenTurns.add(leadId);
				} else {
					// she already finished — close the audio turn or the
					// successor's VAD waits for silence that will never come.
					this.replayOpenTurns.delete(leadId);
					line.session.endUserTurn?.();
				}
				replayed = true;
			}
		}
		// FLY-1190: don't overwrite a live resident answer's "speaking" presence
		// with "listening" on an ears-only reconnect — the answer is still going
		// out on the brain's mouth; only announce "listening" when no resident
		// turn is in flight (gemini path unchanged: no resident → guard is a noop).
		if (
			isAddressed &&
			!this.residentTurnInFlight(leadId) &&
			(this.state === "live" || this.state === "concluding")
		) {
			this.opts.tiv.presence("listening");
		}
		return { replayed, handoffDelivered };
	}

	/** rotation exhausted (rotator onError) — the line is dead for the rest
	 * of the meeting. Terminal AND persistent (Codex R35/R36 MEDIUM-4/HIGH-2):
	 * the "recovering" state must not wedge, audio must not keep feeding the
	 * dead rotator, and the status must never flip back to "thinking". When
	 * another healthy line exists the router is force-switched to it — a
	 * name-based switch can't happen because the dead line would have to
	 * transcribe the re-address itself. */
	handleLineFailed(leadId: string): void {
		this.linesDown.delete(leadId);
		this.linesFailed.add(leadId);
		this.replayOpenTurns.delete(leadId);
		this.pendingHandoffs.delete(leadId);
		this.founderTurnCommitted.delete(leadId);
		if (this.founderAudio?.leadId === leadId) this.founderAudio = undefined;
		if (this.router.addressed === leadId) {
			// the dead line's un-flushed fragments must never concatenate with
			// the NEXT line's transcript into one bogus utterance (R37 HIGH-2).
			this.pendingFounderText = "";
			if (this.founderFlushTimer) {
				clearTimeout(this.founderFlushTimer);
				this.founderFlushTimer = undefined;
			}
		}
		// Codex R36 MEDIUM-3: the suppressed partial was superseded by a replay
		// that will now never happen — journal it record-only so her words at
		// least survive in the record. NO semantic commit: half a sentence must
		// not route or drive the ladder. The incompleteness marker goes into
		// the DURABLE feed too (R37 MEDIUM-4) — the landing summary must not
		// dress half a sentence up as a complete founder quote.
		const partial = this.suppressedPartial.get(leadId);
		this.suppressedPartial.delete(leadId);
		if (this.state !== "live" && this.state !== "concluding") return;
		if (partial?.trim()) {
			const marked = `${partial}(线路中断,记录可能不完整)`;
			this.opts.tiv.caption("Annie", marked);
			this.opts.feed.append({ speaker: "Annie", text: marked, exclude: [] });
		}
		if (this.router.addressed !== leadId) return;
		this.clearThinkingWatchdog();
		// prefer a line that is actually UP; a line inside its own reconnect
		// window can hold the pointer (its replay recovers the audio) but the
		// status must stay truthful (R37 MEDIUM-3).
		const candidates = [...this.lines.keys()].filter(
			(id) => id !== leadId && !this.linesFailed.has(id),
		);
		const healthy = candidates.find((id) => !this.linesDown.has(id));
		const fallback = healthy ?? candidates[0];
		if (fallback) {
			this.router.forceSwitch(fallback);
			const from = this.lines.get(leadId)?.displayName ?? leadId;
			const to = this.lines.get(fallback)?.displayName ?? fallback;
			if (healthy) {
				this.opts.tiv.warn(
					`${from} 的线路彻底断了 — 已把你切给 ${to},直接继续说就行。`,
				);
				this.opts.tiv.presence("listening");
			} else {
				this.opts.tiv.warn(
					`${from} 的线路彻底断了 — 已把你切给 ${to},它的线路正在恢复,稍等。`,
				);
				this.opts.tiv.presence("connecting", "线路恢复中 — 稍等");
			}
		} else {
			this.opts.tiv.presence("paused", "语音线路重连失败 — 结束会议重开吧");
		}
	}

	/** a down-window replay will regenerate this line's transcription — the
	 * dying session's partial output must not reach the semantic pipeline. */
	private replayPendingFor(leadId: string): boolean {
		return (
			this.linesDown.has(leadId) &&
			this.founderAudio?.leadId === leadId &&
			this.founderAudio.frames.length > 0
		);
	}

	/** keep the most complete suppressed partial per line (the aggregate is
	 * usually a superset of the debounce fragments). */
	private noteSuppressedPartial(leadId: string, text: string): void {
		const trimmed = text.trim();
		const prev = this.suppressedPartial.get(leadId) ?? "";
		if (trimmed.length > prev.length) {
			this.suppressedPartial.set(leadId, trimmed);
		}
	}

	/** transcript event from a line (both roles ride the same event).
	 *
	 * FLY-1065 backend contract (Codex R17): fragments stream as final:false;
	 * final:true is the ONE turn-level AGGREGATE carrying the whole turn's
	 * text — it SUPERSEDES the fragments and must never be appended on top of
	 * them (that doubled every line: 「结束」→「结束结束」). */
	handleLineTranscript(
		leadId: string,
		t: { role: "user" | "assistant"; text: string; final: boolean },
	): void {
		if (t.role === "assistant") {
			if (!t.text) return;
			if (t.final) {
				// aggregate replaces the accumulated fragments (also serves
				// finals-only backends, which never sent fragments at all).
				this.turnText.set(leadId, t.text);
			} else {
				this.turnText.set(leadId, (this.turnText.get(leadId) ?? "") + t.text);
			}
			return;
		}
		// role=user — founder speech, transcribed by the ADDRESSED line only.
		// QA R2 F3: her words arrive as non-final fragments while she talks;
		// waiting for the aggregate alone stalls the caption + conclude flow
		// until the model answers (and Discord silence-suppression can starve
		// server VAD entirely), so the speaking-stopped signal (plus a short
		// STT-tail debounce) flushes fragments as ONE utterance. The aggregate
		// can then land BEFORE or AFTER that debounce — founderTurnCommitted
		// tracks what the debounce already committed this turn so the
		// aggregate only contributes the not-yet-committed remainder.
		if (!t.text.trim()) return;
		if (t.final) {
			// the aggregate is ITS line's turn boundary: reconcile (consume)
			// that line's outstanding commit record no matter who is addressed
			// — records must die with their turn, or routing ping-pong
			// (eng→joy→eng) revives a stale record's aggregate as a brand-new
			// utterance and replays it (Codex R19/R20).
			const committed = this.founderTurnCommitted.get(leadId) ?? "";
			this.founderTurnCommitted.delete(leadId);
			// QA R5 (Codex R35 HIGH-1): a final user aggregate from a line
			// inside its down window is the DYING session's partial flush.
			// With a replay pending the successor re-transcribes the FULL
			// utterance and commits it exactly once — the partial must not
			// enter the semantic pipeline (double ladder hit; worse, a routing
			// switch on the partial strands the full aggregate on the
			// non-addressed branch and her tail is lost for good). It is
			// RECORDED, not dropped (Codex R36 MEDIUM-3): if the reconnect
			// ultimately fails, this is all that's left of her words.
			if (this.replayPendingFor(leadId)) {
				this.noteSuppressedPartial(leadId, t.text);
				return;
			}
			// a non-addressed line's aggregate reconciles its own record and
			// journals any STT tail it still carried (R21: her words must not
			// vanish just because routing moved on) — but it must not touch the
			// addressed line's in-flight state, and never the semantic pipeline.
			if (leadId !== this.router.addressed) {
				if (committed) this.journalFounderTail(committed, t.text);
				return;
			}
			if (this.founderFlushTimer) {
				clearTimeout(this.founderFlushTimer);
				this.founderFlushTimer = undefined;
			}
			this.pendingFounderText = "";
			if (!committed) {
				// nothing committed yet — the aggregate IS the utterance.
				this.commitFounderUtterance(t.text);
				return;
			}
			this.journalFounderTail(committed, t.text);
			return;
		}
		// fragments: only the ADDRESSED line's transcription is her speech feed.
		if (leadId !== this.router.addressed) return;
		// QA R3 P1/P2: live recognition is VISIBLE — the 说完→字出现 gap used
		// to be dead air she read as "broken".
		if (this.state === "live" || this.state === "concluding") {
			this.opts.tiv.presence("listening", "识别中…");
		}
		this.pendingFounderText += t.text;
		// a fragment arriving during the debounce is the STT tail — extend it.
		if (this.founderFlushTimer) this.armFounderFlush();
	}

	/** flush timer: speaking stopped, wait a short STT tail, then commit. */
	private armFounderFlush(): void {
		if (this.founderFlushTimer) clearTimeout(this.founderFlushTimer);
		const st = this.opts.setTimeoutFn ?? setTimeout;
		this.founderFlushTimer = st(() => {
			this.founderFlushTimer = undefined;
			this.flushFounderUtterance();
		}, FOUNDER_STT_TAIL_MS);
		this.founderFlushTimer.unref?.();
	}

	private flushFounderUtterance(): void {
		if (this.founderFlushTimer) {
			clearTimeout(this.founderFlushTimer);
			this.founderFlushTimer = undefined;
		}
		const raw = this.pendingFounderText;
		this.pendingFounderText = "";
		if (!raw.trim()) return;
		// QA R5 (Codex R35 HIGH-1): same suppression on the debounce path —
		// pre-abort fragments are partial; the pending replay supersedes them.
		// Recorded, not dropped (Codex R36 MEDIUM-3).
		if (this.replayPendingFor(this.router.addressed)) {
			this.noteSuppressedPartial(this.router.addressed, raw);
			return;
		}
		// remember what this turn already committed — recorded under the line
		// that transcribed it (capture BEFORE the commit: routing inside the
		// commit may switch the addressed line) — so that line's later
		// turn-aggregate (final:true) dedupes instead of doubling (R17/R19).
		const addressed = this.router.addressed;
		this.founderTurnCommitted.set(
			addressed,
			(this.founderTurnCommitted.get(addressed) ?? "") + raw,
		);
		this.commitFounderUtterance(raw);
	}

	/** the ONE gate every founder-utterance commit path goes through. */
	private commitFounderUtterance(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.state !== "live" && this.state !== "concluding") return;
		// QA R5: a commit while the transcribing line is UP means her words
		// made it — drop the replay buffer AND the suppressed-partial fallback
		// (Codex R39 HIGH-1: the fallback must outlive the replay itself and
		// die only on a REAL commit, or an exit between replay and the
		// successor's transcript loses her last words). A commit DURING a down
		// window is only the pre-abort fragments (partial); keep both.
		if (this.founderAudio && !this.linesDown.has(this.founderAudio.leadId)) {
			this.suppressedPartial.delete(this.founderAudio.leadId);
			this.founderAudio = undefined;
		}
		this.handleFounderUtterance(trimmed);
	}

	/** The debounce already made the turn's SEMANTIC commit (routing / ladder /
	 * conclude-confirm). A late STT tail that only the aggregate carries is
	 * record-reconciliation ONLY: caption + journal her missing words — never
	 * a second routing, never a bogus ladder correction (Codex R18/R21).
	 * Scrub-shifted mismatch drops (no double). */
	private journalFounderTail(committed: string, aggregate: string): void {
		const remainder = aggregate.startsWith(committed)
			? aggregate.slice(committed.length).trim()
			: "";
		if (!remainder) return;
		if (this.state !== "live" && this.state !== "concluding") return;
		this.opts.tiv.caption("Annie", remainder);
		this.opts.feed.append({ speaker: "Annie", text: remainder, exclude: [] });
	}

	handleLineResponseStarted(leadId: string): void {
		const line = this.lines.get(leadId);
		if (!line) return;
		if (leadId !== this.expectedSpeaker) {
			// FLY-968's lesson as a runtime belt: an un-granted answer is cut
			// before it makes a sound (its mouth gate never opened).
			this.ungrantedTurns++;
			this.opts.log?.(
				`[huddle] un-granted turn from ${leadId} (expected ${this.expectedSpeaker ?? "nobody"}) — interrupted`,
			);
			line.session.interrupt();
			return;
		}
		this.currentSpeaker = leadId;
		this.turnText.set(leadId, "");
		this.clearThinkingWatchdog(); // real progress — the model is answering
		this.thinkingWarned = false; // a NEW stall may warn again
		line.mouth.noteToolResolved(); // answer landed — disarm the filler
		line.mouth.beginTurn();
		this.opts.tiv.presence("speaking", line.displayName);
	}

	handleLineResponseAudio(leadId: string, chunk: Buffer): void {
		if (leadId !== this.currentSpeaker) return; // gate belt (mouth also drops)
		this.lines.get(leadId)?.mouth.feed(chunk);
	}

	handleLineResponseDone(leadId: string): void {
		const line = this.lines.get(leadId);
		if (!line || leadId !== this.currentSpeaker) return;
		line.mouth.endTurn();
		this.currentSpeaker = undefined;
		const text = (this.turnText.get(leadId) ?? "").trim();
		this.turnText.set(leadId, "");
		if (text) {
			this.opts.tiv.caption(line.displayName, text);
			// its own words — everyone else gets fed.
			this.opts.feed.append({
				speaker: line.displayName,
				text,
				exclude: [leadId],
			});
		}
		this.opts.tiv.presence("listening");
	}

	handleLineResponseCancelled(leadId: string): void {
		const line = this.lines.get(leadId);
		line?.mouth.flush();
		if (leadId === this.currentSpeaker) this.currentSpeaker = undefined;
		this.turnText.set(leadId, "");
	}

	handleLineToolCall(leadId: string): void {
		if (leadId !== this.expectedSpeaker) return;
		this.lines.get(leadId)?.mouth.noteToolCall();
		this.opts.tiv.presence("thinking", "查资料");
	}

	/** Note-taker dropped (live) — visible pause; wiring drives the rejoin. */
	handleEarsPaused(paused: boolean): void {
		if (paused) this.opts.tiv.presence("paused", "收音重连中");
		else this.opts.tiv.presence("listening");
	}

	private handleFounderUtterance(text: string): void {
		this.opts.tiv.caption("Annie", text);
		this.opts.ladder.notifyFounderUtterance(text);

		if (this.state === "concluding") {
			// QA kickback R1: 「对,不过第二条改成下周三」 agrees on the first token
			// and then corrects — only a CLEAN yes may land; anything qualified
			// takes the correction path.
			if (isUnconditionalAffirm(text)) {
				void this.landNow(true);
			} else {
				// correction — journal it so the summary can quote her final word
				// (concluding utterances used to bypass the feed entirely and the
				// correction vanished from the landed artifact), then hand it back
				// to the host to re-recap the delta. Exclude BOTH first-hand
				// parties (Codex R8 MEDIUM): the addressed line transcribed her
				// correction itself, the host gets it verbatim in the control turn.
				this.opts.feed.append({
					speaker: "Annie",
					text,
					exclude: [...new Set([this.opts.hostLeadId, this.router.addressed])],
				});
				this.grantTo(this.opts.hostLeadId);
				this.speakThrough(
					this.host,
					`[控制] founder 对 recap 有更正:「${text}」。改过来,只重念改动的部分,再问一次「对吗?」`,
				);
			}
			return;
		}

		if (CONCLUDE_RE.test(text)) {
			this.startConcluding();
			return;
		}

		const route = this.opts.router.route(text);
		// Codex R37 HIGH-1: a name-switch onto a permanently FAILED line would
		// hand the meeting to a dead rotator (frames refused, terminal paused).
		// Undo the pointer move, tell her, and stay with the current line.
		if (route.switched && this.linesFailed.has(route.addressed)) {
			const deadName =
				this.lines.get(route.addressed)?.displayName ?? route.addressed;
			const from = route.switchedFrom as string;
			this.opts.router.forceSwitch(from);
			this.opts.tiv.warn(
				`${deadName} 的线路已经断线,接不进来 — 继续跟 ${
					this.lines.get(from)?.displayName ?? from
				} 说就行。`,
			);
			this.opts.feed.append({ speaker: "Annie", text, exclude: [from] });
			this.grantTo(from);
			return;
		}
		if (!route.switched) {
			// the addressed line heard the audio first-hand.
			this.opts.feed.append({
				speaker: "Annie",
				text,
				exclude: [route.addressed],
			});
			this.grantTo(route.addressed);
			// §4.1-5: a Gemini line auto-responds to the audio it just heard; a
			// resident line never heard audio, so its turn must be kicked off with
			// the founder's transcript as the prompt (speakThrough also claims the
			// resident floor — Codex R2 HIGH-2).
			const addressed = this.lines.get(route.addressed);
			if (addressed?.resident) this.speakThrough(addressed, text);
			return;
		}
		// handoff round: the OLD line consumed the audio — cut it before it
		// answers someone else's question, then replay the utterance as a
		// speech-triggering turn into the NEW line (sendText for Gemini,
		// brain.respond for a resident line — speakThrough handles both).
		const from = route.switchedFrom as string;
		const old = this.lines.get(from);
		if (old) this.interruptLine(old);
		if (this.currentSpeaker === from) this.currentSpeaker = undefined;
		// exclude BOTH sides: the old line heard the audio first-hand, the new
		// one receives the utterance as its speech-triggering turn below — a
		// silent copy on top would double-deliver it.
		this.opts.feed.append({
			speaker: "Annie",
			text,
			exclude: [from, route.addressed],
		});
		this.grantTo(route.addressed);
		// Codex R38 MEDIUM-2: a switch onto a line inside its reconnect window
		// must not sendText into the rotation gap — the rotator has no session
		// and the handoff would drop silently (and the feed excluded the
		// target, so it would never arrive at all). Queue it for delivery on
		// that line's reconnect; the pointer still moves (frames buffer +
		// replay recover her subsequent audio).
		if (this.linesDown.has(route.addressed)) {
			this.pendingHandoffs.set(route.addressed, text);
			this.opts.tiv.warn(
				`${
					this.lines.get(route.addressed)?.displayName ?? route.addressed
				} 的线路正在恢复 — 接回后我把你这句转给它,稍等。`,
			);
			this.opts.log?.(
				`[huddle] addressing ${from} → ${route.addressed} (handoff queued — line down)`,
			);
			return;
		}
		// FLY-1160 §4.1 (545-fold seam): deliver via speakThrough so a RESIDENT
		// line answers through brain.respond — a resident line has NO Gemini answer
		// turn (its Gemini session is STT-only and its response audio is discarded),
		// so a raw session.sendText would be swallowed. The gemini path stays
		// byte-identical to the previous session.sendText.
		const addressed = this.lines.get(route.addressed);
		if (addressed) this.speakThrough(addressed, `[Annie 在点名你] ${text}`);
		this.opts.log?.(`[huddle] addressing ${from} → ${route.addressed}`);
	}

	private startConcluding(): void {
		this.state = "concluding";
		this.grantTo(this.opts.hostLeadId);
		this.speakThrough(
			this.host,
			"[控制] founder 说要收尾了。请口头 recap 这场的结论和 action items(「所以:1)…2)…」),最后问「对吗?」。不要新开话题。",
		);
		this.opts.tiv.presence("thinking", "recap 中");
	}

	private async landNow(confirmed: boolean): Promise<void> {
		if (this.landed) return;
		this.landed = true;
		// Codex R13 HIGH: a pending founder fragment (she left inside the STT
		// debounce window) must reach the journal BEFORE the snapshot below,
		// or the degraded landing summarizes without her last words. Journal
		// only — the meeting is ending, no routing/confirm side effects.
		this.commitPendingFounderTextToJournal();
		this.state = "landing";
		this.opts.tiv.presence("thinking", "落地中(写 summary/建 worktree)");
		try {
			await this.opts.conclusion.land({
				issue: this.opts.issue,
				confirmed,
				journalSnapshot: this.opts.feed.transcriptSnapshot(),
			});
		} finally {
			this.teardown();
		}
	}

	/** Journal-only commit of every un-recovered founder text at a landing/
	 * teardown boundary (Codex R13 HIGH / R38 HIGH-1): the pending debounce
	 * fragment AND the down-window suppressed partials — she may leave before
	 * the reconnect outcome (FLY-1186's actual exit path), and the record is
	 * then all that's left of her words. Journal only — no routing/confirm
	 * side effects; incomplete captures carry the provenance marker. */
	private commitPendingFounderTextToJournal(): void {
		if (this.founderFlushTimer) {
			clearTimeout(this.founderFlushTimer);
			this.founderFlushTimer = undefined;
		}
		const pending = this.pendingFounderText.trim();
		this.pendingFounderText = "";
		this.founderTurnCommitted.clear();
		// a pending fragment transcribed by a DOWN/FAILED addressed line is
		// itself an incomplete capture — it gets the marker too.
		const addressed = this.router.addressed;
		const pendingIncomplete =
			this.linesDown.has(addressed) || this.linesFailed.has(addressed);
		const pieces: { text: string; incomplete: boolean }[] = [];
		if (pending) pieces.push({ text: pending, incomplete: pendingIncomplete });
		for (const partial of this.suppressedPartial.values()) {
			const t = partial.trim();
			if (t) pieces.push({ text: t, incomplete: true });
		}
		this.suppressedPartial.clear();
		// dedup by containment — the aggregate partial is usually a superset
		// of the debounce fragments; the same words must not journal twice.
		const kept = pieces.filter(
			(p, i) =>
				!pieces.some(
					(q, j) =>
						j !== i &&
						q.text.includes(p.text) &&
						(q.text.length > p.text.length || j < i),
				),
		);
		for (const p of kept) {
			const marked = p.incomplete
				? `${p.text}(线路中断,记录可能不完整)`
				: p.text;
			this.opts.tiv.caption("Annie", marked);
			this.opts.feed.append({ speaker: "Annie", text: marked, exclude: [] });
		}
	}

	private teardown(): void {
		this.state = "teardown";
		if (this.assembleTimer) clearTimeout(this.assembleTimer);
		if (this.founderFlushTimer) {
			clearTimeout(this.founderFlushTimer);
			this.founderFlushTimer = undefined;
		}
		this.pendingFounderText = "";
		this.founderTurnCommitted.clear();
		this.residentFloor = undefined;
		this.residentTurnsInFlight.clear();
		this.clearThinkingWatchdog();
		// QA R5 hygiene: abort-window recovery state dies with the meeting.
		this.linesDown.clear();
		this.linesFailed.clear();
		this.replayOpenTurns.clear();
		this.suppressedPartial.clear();
		this.pendingHandoffs.clear();
		this.founderAudio = undefined;
		// stop every mouth. A resident line ALSO interrupts its in-flight brain
		// turn (the brain PROCESS is reaped separately by manager.close in the
		// wiring); a Gemini line just flushes its audio mouth — byte-identical to
		// 545 (no session.interrupt on teardown).
		for (const line of this.lines.values()) {
			if (line.resident) line.resident.bargeIn();
			else line.mouth.flush();
		}
		void Promise.resolve(this.opts.onTeardown()).then(() => {
			this.state = "idle";
		});
	}

	// ---------------------------------------------------------------------------
	// FLY-1160 §4.1 resident mode. `speakThrough` / `interruptLine` are the two
	// seams that let one meeting drive EITHER engine: a resident line thinks via
	// brain.respond (text → its own text mouth), a Gemini line via a speech-
	// triggering text turn (session.sendText) + the response event flow. When a
	// line has no `resident` these fall through to the EXACT 545 Gemini calls, so
	// the gemini-mode path is byte-identical.
	// ---------------------------------------------------------------------------

	/** make a line say/answer `prompt`: resident → brain.respond; Gemini → a
	 * speech-triggering text turn. Control prompts ("[控制] …") and addressing
	 * turns ("[Annie 在点名你] …") ride this the same way in both engines. */
	private speakThrough(line: HuddleLine, prompt: string): void {
		if (line.resident) {
			// this line now owns the resident floor until a NEW resident turn is
			// kicked off (or teardown) — this outlives the brain stream, so a barge
			// during mouth drain still finds it (Codex R2 HIGH-2).
			this.residentFloor = line.leadId;
			// FLY-1190: one more turn is now in flight (thinking → speaking) for this
			// line; the status guard reads this COUNT, NOT the sticky residentFloor.
			// Counted (not a flag) so a queued turn survives an earlier turn settling.
			this.residentTurnsInFlight.set(
				line.leadId,
				(this.residentTurnsInFlight.get(line.leadId) ?? 0) + 1,
			);
			line.resident.respond(prompt);
		} else line.session.sendText(prompt);
	}

	/** cut a line's in-flight answer: resident → bargeIn (mouth stop + interrupt);
	 * Gemini → session.interrupt + mouth.flush. */
	private interruptLine(line: HuddleLine): void {
		if (line.resident) {
			line.resident.bargeIn();
			// FLY-1190 (Codex R13/R14): a barge-in / handoff CUT aborts the driver's
			// WHOLE serial set (streaming + queued turns) and fires NEITHER onAnswer NOR
			// onError, so no per-turn settle ever comes. Cancel ALL in-flight turns for
			// this line here, or a cancelled turn stays "in flight" forever and a later
			// idle ears flap swallows the truthful connecting/listening status.
			this.residentTurnsInFlight.delete(line.leadId);
		} else {
			line.session.interrupt();
			line.mouth.flush();
		}
	}

	/** a resident line's turn became audible (first delta) — the parallel of the
	 * Gemini response-started event: claim the speaking floor (grant belt), clear
	 * the thinking watchdog (real progress), show speaking. */
	handleResidentSpeaking(leadId: string): void {
		const line = this.lines.get(leadId);
		if (!line) return;
		if (leadId !== this.expectedSpeaker) {
			// an un-granted resident turn (should not happen — we control respond)
			// is cut before it makes a sound, same belt as the Gemini path.
			this.ungrantedTurns++;
			this.opts.log?.(
				`[huddle] un-granted resident turn from ${leadId} (expected ${this.expectedSpeaker ?? "nobody"}) — interrupted`,
			);
			this.interruptLine(line);
			return;
		}
		this.currentSpeaker = leadId;
		this.clearThinkingWatchdog();
		// real progress — mirror the Gemini handleLineResponseStarted reset so a
		// LATER resident wait can warn again (final-545 added thinkingWarned on the
		// Gemini path only; the 545-fold must wire it into this parallel entry).
		this.thinkingWarned = false;
		this.opts.tiv.presence("speaking", line.displayName);
	}

	/** a resident line finished a turn cleanly — the parallel of response-done:
	 * caption its full answer + fan it out to the other lines' feed. */
	handleResidentAnswer(leadId: string, text: string): void {
		const line = this.lines.get(leadId);
		// FLY-1190 (Codex R14): settle ONE in-flight turn — BEFORE the currentSpeaker
		// guard, so a zero-delta clean completion (never set currentSpeaker) still
		// decrements and a queued turn behind it isn't left permanently in flight.
		this.settleResidentTurn(leadId);
		if (!line || leadId !== this.currentSpeaker) return;
		this.currentSpeaker = undefined;
		const trimmed = text.trim();
		if (trimmed) {
			this.opts.tiv.caption(line.displayName, trimmed);
			this.opts.feed.append({
				speaker: line.displayName,
				text: trimmed,
				exclude: [leadId],
			});
		}
		this.opts.tiv.presence("listening");
	}

	/** §4.1-7: the host's resident brain hit its lifetime cap (default 3h) — end
	 * the meeting with a degraded (no verbal confirm) landing, same as founder
	 * exit. voice-core never lands artifacts itself; the orchestrator decides. */
	handleResidentLifetimeExpiry(): void {
		if (this.state === "live" || this.state === "concluding") {
			this.opts.tiv.warn("这场开挺久了,先把纪要落地收个尾。");
			void this.landNow(false);
		}
	}

	/** a resident line's turn FAILED (brain subprocess-failed/timeout/respawn
	 * limit) — fail-loud to the TIV, never a silent dead air (§4.1-8). */
	handleResidentError(leadId: string, message: string): void {
		const line = this.lines.get(leadId);
		if (leadId === this.currentSpeaker) this.currentSpeaker = undefined;
		this.settleResidentTurn(leadId); // FLY-1190 (Codex R14): one turn ended (failed)
		this.clearThinkingWatchdog();
		this.opts.tiv.warn(
			`${line?.displayName ?? leadId} 这轮没答上来(${message})— 可以再说一遍。`,
		);
		if (this.state === "live" || this.state === "concluding") {
			this.opts.tiv.presence("listening");
		}
	}

	private grantTo(leadId: string): void {
		this.expectedSpeaker = leadId;
	}

	private get host(): HuddleLine {
		return this.lines.get(this.opts.hostLeadId) as HuddleLine;
	}

	private get addressedLine(): HuddleLine {
		return this.lines.get(this.router.addressed) ?? this.host;
	}

	private get router(): AddressRouter {
		return this.opts.router;
	}
}
