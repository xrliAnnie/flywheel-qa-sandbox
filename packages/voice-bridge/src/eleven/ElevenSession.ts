/**
 * ElevenSession (FLY-1006 S7) — the /eleven meeting's thin state machine:
 * invoked → live → teardown. Much thinner than AssistantSession because the
 * platform owns STT, turn-taking, TTS and interruption detection; this class
 * only moves audio, maps platform events onto the streaming mouth's turn
 * model, and keeps the metrics/transcript trail.
 *
 * Event → turn mapping (plan §S7):
 *   first audio_event of a response  → beginTurn (waiting cue stops here)
 *   subsequent audio_events          → feed (same one raw PCM stream)
 *   audio gap > turnGapMs (1.5s)     → endTurn (platform sends no explicit
 *                                      response-complete on this tier)
 *   interruption / local barge-in    → flush + turn closed + SUPPRESS: late
 *                                      chunks of the dead turn are dropped
 *                                      and counted until the founder's next
 *                                      user_transcript opens a fresh response.
 *
 * Local barge-in is turn-state-aware (QA FLY-1006 round-3 ①): it is a real
 * interruption ONLY while a turn is open (the agent is audibly speaking).
 * Idle (no open turn) it merely ends the wait state — it must NEVER set
 * `suppressed`, or a pre-answer breath silently drops the whole upcoming
 * answer (Annie P6: 8+ idle barge-ins per utterance thrashing state).
 *
 * TIV (QA round-3 ②③, the /glaw F2 unified transparency standard): the
 * founder must always be able to tell "broken" from "thinking" — status
 * lines (🎙 在听 / 🧠 正在处理… / 💬 回话中) plus both sides' transcript as
 * text, posted to the voice channel's text area by the wiring.
 */
import type { SessionSlot } from "../SessionSlot.js";

/** the streaming mouth — AssistantSpeaker satisfies this as-is. */
export interface ElevenSpeakerLike {
	beginTurn(): void;
	feed(chunk: Buffer): void;
	endTurn(): void;
	flush(): void;
}

/** the live WS surface the session drives (ElevenWs satisfies this). */
export interface ElevenWsLike {
	sendAudio(frame16k: Buffer): void;
	flushAudio(): void;
	close(): void;
}

export interface ElevenWsHandlers {
	onAudio: (chunk: Buffer) => void;
	onInterruption: () => void;
	onUserTranscript?: (text: string) => void;
	onAgentResponse?: (text: string) => void;
	onMetadata?: (meta: unknown) => void;
	onError: (err: Error) => void;
	onClose?: (code: number) => void;
}

/** room ears surface (VoiceRoomRuntime satisfies this). */
export interface ElevenEars {
	onFrame(cb: (frame: Buffer, format: unknown) => void): () => void;
	onSpeakingStart(cb: () => void): () => void;
	onSpeakingEnd(cb: () => void): () => void;
	onBargeIn(cb: () => void): () => void;
}

export type ElevenSessionState = "invoked" | "live" | "ended";

/** the text-in-voice surface (assistant TivSurface's shape, /eleven subset).
 * /eleven gets ONE user_transcript + ONE agent_response per round from the
 * platform — captions are per-turn, not streaming, so posting each one does
 * not flood the channel (unlike the /gemini per-delta caption stream). */
export interface ElevenTiv {
	status(line: string): void;
	caption(role: "user" | "assistant", text: string): void;
}

const STATUS_LISTENING = "🎙 在听";
const STATUS_THINKING = "🧠 正在处理…";
const STATUS_SPEAKING = "💬 回话中";
/** the 🧠 status posts only after the wait SURVIVES this long — natural
 * mid-utterance pauses (she resumes and speaking-start ends the wait) must
 * not spam the text channel with 在听/🧠 flips. MUST be ≥ the ears
 * bargeInHoldoffMs (the wiring passes the configured value): any pause the
 * ears still treat as the SAME utterance must post nothing (Codex R3-fix-3).
 * A real wait is ≥1.5s (fastest observed answer onset), so it always shows. */
const DEFAULT_STATUS_DEBOUNCE_MS = 1000;

/** FLY-1160 §4.2-4: the minutes the resident brain's final turn produces
 * (null = brain failed → the finalizer lands a degraded record from the
 * journal trail instead). */
export interface ElevenMinutes {
	recapText: string;
	quotes: { ts: string; text: string }[];
	/** brain unavailable → landed from the journal, loudly labeled. */
	degraded?: boolean;
}

/** the landing face the finalizer drives (ElevenLanding satisfies it). */
export interface ElevenLandingLike {
	land(
		input: {
			issueId: string;
			sessionId: string;
			recapText: string;
			quotes: { ts: string; text: string }[];
			confirmed: boolean;
		},
		opts?: { signal?: AbortSignal },
	): Promise<{ ok: boolean; message?: string }>;
}

/** FLY-1160 §4.2-4: the exactly-once finalizer's five convergent reasons. */
export type ElevenStopReason =
	| "manual" // /eleven stop
	| "ws-error" // platform WS closed / errored mid-meeting
	| "start-failure" // start() threw before live — NO minutes, abort-close the issue
	| "shutdown" // daemon shutting down
	| "no-show"; // founder never joined within the assemble window

export interface ElevenSessionOptions {
	sessionId: string;
	topic?: string;
	/** FLY-1160: the kickoff issue minutes land on (undefined = the pre-1160
	 * bare product-test surface, no landing). */
	issueId?: string;
	/** the shared room slot — the command acquired it; every exit path here
	 * releases it (mirror of the Gemini ownership handoff). */
	slot: SessionSlot;
	slotMode: string;
	ears: ElevenEars;
	/** connects the platform WS with this session's handlers (real impl:
	 * ElevenWs; injected offline in tests). */
	connect(handlers: ElevenWsHandlers): Promise<ElevenWsLike>;
	speaker: ElevenSpeakerLike;
	voice: { join(): Promise<void>; leave(): void };
	/** M2 追加要求②: the audible "thinking" cue between founder speech-end
	 * and the first audio frame. Optional and off when absent. */
	cue?: { start(): void; stop(): void };
	/** QA round-3 ②③: text visibility (status + captions). Optional. */
	tiv?: ElevenTiv;
	/** wait-survival time before the 🧠 status posts (anti-spam). Keep aligned
	 * with the ears bargeInHoldoffMs — default 1000ms. */
	statusDebounceMs?: number;
	turnGapMs?: number;
	/** jsonl trail (metrics + transcripts); caller owns the file. */
	transcript?: (line: Record<string, unknown>) => void;
	log?: (line: string) => void;
	onEnded?: () => void;
	now?: () => number;
	// ---- FLY-1160 §4.2-4 finalizer seams (all optional; absent = no landing) ----
	/** drive the resident brain's FINAL turn to produce the minutes; null =
	 * brain failed (the finalizer lands a degraded record from the journal).
	 * The shutdown deadline signal cancels the turn (§3.3 Phase 2). */
	generateMinutes?: (signal?: AbortSignal) => Promise<ElevenMinutes | null>;
	/** the landing (ElevenLanding). Absent = no issue landing (pre-1160). */
	landing?: ElevenLandingLike;
	/** degraded minutes source when the brain is unavailable — the founder's
	 * verbatim user_transcript lines from the trail. */
	journalQuotes?: () => { ts: string; text: string }[];
	/** the "meeting never happened" path (start-failure / no-show): comment +
	 * close the kickoff issue without minutes (GeminiCommand abort shape). The
	 * shutdown signal is TRUE cancellation — it reaches the underlying fetch so
	 * an in-flight mutation is aborted, not merely un-chained (Codex #552 R4). */
	linearAbort?: {
		comment(
			issueId: string,
			body: string,
			opts?: { signal?: AbortSignal },
		): Promise<unknown>;
		closeIssue(issueId: string, opts?: { signal?: AbortSignal }): Promise<void>;
	};
	/** FLY-1160 §4.2-4 ④ (Codex #552 R1 HIGH-5): interrupt the in-flight
	 * resident brain turn and AWAIT its barrier before the minutes turn — a
	 * closed platform WS does NOT prove the custom-LLM HTTP turn is cancelled. */
	brainInterrupt?: () => Promise<void>;
	/** FLY-1160 §4.2-4 ② (Codex #552 R1 HIGH-5): stop the BrainPort from serving
	 * NEW shim turns for this key while the finalizer runs the minutes turn (so
	 * a late shim turn cannot supersede the minutes turn). */
	suspendBrain?: () => void;
	/** FLY-1160 §4.2-3 (Codex #552 R1 HIGH-4): pre-heat the resident brain
	 * BEFORE the WS connects — a throw here is a start-failure (abort-close). */
	preheat?: () => void | Promise<void>;
}

const DEFAULT_TURN_GAP_MS = 1500;

export class ElevenSession {
	private state: ElevenSessionState = "invoked";
	private ws: ElevenWsLike | null = null;
	private unsubs: (() => void)[] = [];
	private turnOpen = false;
	private suppressed = false;
	/** the wait state is ON (speech-end seen, answer not yet started). Its own
	 * flag on purpose (QA FLY-1006 B1): `suppressed` means "drop the dead
	 * turn's late chunks" — it must never gate the founder's wait feedback.
	 * Gates BOTH halves of the wait UI: the cue clip and the 🧠 status. */
	private waitOn = false;
	/** last TIV status posted — dedupes repeats so state churn (e.g. an idle
	 * barge-in storm) can never spam the text channel (Codex R3-fix-1). */
	private lastStatus: string | null = null;
	private statusTimer: ReturnType<typeof setTimeout> | undefined;
	private gapTimer: ReturnType<typeof setTimeout> | undefined;
	private speechEndAt: number | null = null;
	/** observability: late chunks dropped after an interruption. */
	droppedLateChunks = 0;
	/** FLY-1160 §4.2-4: the exactly-once finalizer — CAS into finalizing so
	 * the five convergent reasons collapse to one landing (repeat stop returns
	 * the SAME promise). */
	private finalizePromise: Promise<void> | null = null;
	/** FLY-1160 §3.3 Phase 2 (Codex #552 R2 HIGH-1): the finalizer's minutes
	 * turn + landing observe THIS shared controller. Every stop({signal})
	 * bridges its signal into it, so a shutdown deadline that arrives AFTER a
	 * manual/WS/no-show finalizer already started still cancels the in-flight
	 * writes (an AssistantSession-style shared abort). */
	private readonly finalizeAbort = new AbortController();
	/** set by abortClose() when it CONFIRMS the kickoff issue closed — the
	 * start-failure reply must not claim a close that failed (Codex #552 M9). */
	private issueClosedByAbort = false;

	constructor(private readonly opts: ElevenSessionOptions) {}

	get stateName(): ElevenSessionState {
		return this.state;
	}

	/** read the state without flow-narrowing — a startup await may have set it
	 * to "ended" via an out-of-band finalizer (Codex #552 R3 HIGH-1). */
	private isEnded(): boolean {
		return this.state === "ended";
	}

	async start(): Promise<void> {
		const { opts } = this;
		try {
			// FLY-1160 §4.2-3 (Codex #552 R1 HIGH-4): pre-heat the resident brain
			// BEFORE the WS connects — key eleven:<sessionId> must exist or every
			// shim turn 404s. A preheat FAILURE is a start-failure: the catch
			// below abort-closes the kickoff issue (no dead meeting), never a
			// silent mid-meeting degrade.
			await opts.preheat?.();
			// Codex #552 R3 HIGH-1: a no-show/shutdown finalizer can fire DURING
			// start() (preheat/join/connect can outrun the assemble deadline).
			// After every startup await, bail if the session already ended and
			// close any resource this await acquired — NEVER revive to "live"
			// (the AssistantSession R17 pattern).
			if (this.isEnded()) return;
			await opts.voice.join();
			if (this.isEnded()) {
				this.opts.voice.leave();
				return;
			}
			this.ws = await opts.connect({
				onAudio: (chunk) => this.onAudio(chunk),
				onInterruption: () => this.interrupt("platform"),
				onUserTranscript: (text) => {
					// the founder spoke again — the next response is fresh, stop
					// suppressing (plan §S7 late-chunk boundary).
					this.suppressed = false;
					this.trail({ type: "user_transcript", text });
					this.opts.tiv?.caption("user", text);
				},
				onAgentResponse: (text) => {
					this.trail({ type: "agent_response", text });
					this.opts.tiv?.caption("assistant", text);
				},
				onMetadata: (meta) => {
					this.trail({ type: "metadata", meta });
					// The platform mints its own conversation_id (conv_…) and reports
					// it here; it NEVER echoes custom_llm_extra_body.conversation_id
					// (real-platform behavior, FLY-1006 预跑 + 4 prior real sessions).
					// Daemon-UUID↔brain consistency is enforced at the boundary that
					// actually routes turns: the platform forwards extra_body verbatim
					// to the shim, and BrainPort 404s any key the daemon didn't open
					// (fail-closed). The platform id is recorded above for forensics.
					const platformId = (meta as { conversationId?: string })
						?.conversationId;
					opts.log?.(
						`[eleven-session] platform conversation_id=${platformId || "(missing)"} (daemon session ${this.opts.sessionId})`,
					);
				},
				onError: (err) => {
					this.trail({ type: "error", message: err.message });
					opts.log?.(`[eleven-session] ws error: ${err.message}`);
				},
				onClose: () => {
					if (this.state === "live") {
						opts.log?.("[eleven-session] ws closed — tearing down");
						void this.stop("ws-error");
					}
				},
			});
			// Codex #552 R3 HIGH-1: the finalizer may have run while connect() was
			// awaiting — close the just-opened WS and bail, never go live.
			if (this.isEnded()) {
				this.ws?.close();
				this.ws = null;
				this.opts.voice.leave();
				return;
			}
			// FLY-1160 §4.2-4 (Codex #552 R2 HIGH-3): the no-show path is driven
			// by the WIRING from Discord PRESENCE (occupancy probe + voice-state
			// join), NOT from audio here — a founder who joined but stayed silent
			// is present, not a no-show. The wiring calls stop("no-show").
			this.unsubs.push(
				opts.ears.onFrame((frame) => this.ws?.sendAudio(frame)),
				opts.ears.onSpeakingStart(() => {
					// she resumed speaking. The barge-in holdoff deliberately stays
					// silent for in-utterance resumes (Codex R3-fix-2), so the wait
					// UI must end HERE or it lies (cue playing + 🧠 while she talks).
					// Her next speech-end re-opens the wait. Turn open → leave it to
					// the barge-in gate (a brief backchannel must not flip the UI).
					if (this.state !== "live" || this.turnOpen) return;
					this.endWait();
					this.setStatus(STATUS_LISTENING);
				}),
				opts.ears.onSpeakingEnd(() => {
					this.ws?.flushAudio();
					this.speechEndAt = (opts.now ?? Date.now)();
					this.trail({ type: "speech_end" });
					if (!this.turnOpen) this.beginWait();
				}),
				opts.ears.onBargeIn(() => this.onLocalBargeIn()),
			);
			this.state = "live";
			this.trail({ type: "session_live", sessionId: opts.sessionId });
			this.setStatus(STATUS_LISTENING);
		} catch (err) {
			// start-failure: the finalizer abort-closes the kickoff issue (no
			// minutes) — flag the REAL close result so the command's founder-
			// facing reply never claims a close that failed (Codex #552 M9).
			await this.stop("start-failure");
			(err as { issueClosed?: boolean }).issueClosed = this.opts.issueId
				? this.issueClosedByAbort
				: undefined;
			throw err;
		}
	}

	/** wait begin/end are stateful halves (QA FLY-1006 B2): the cue and the
	 * mouth share ONE player, so stop() may touch the player ONLY while the
	 * wait itself is on — an unguarded stop() cuts the live turn stream. The
	 * 🧠 status posts once per wait regardless of whether a cue clip exists. */
	private setStatus(line: string): void {
		if (this.lastStatus === line) return;
		this.lastStatus = line;
		this.opts.tiv?.status(line);
	}

	private beginWait(): void {
		if (this.waitOn) return;
		this.waitOn = true;
		this.statusTimer = setTimeout(() => {
			this.statusTimer = undefined;
			if (this.waitOn) this.setStatus(STATUS_THINKING);
		}, this.opts.statusDebounceMs ?? DEFAULT_STATUS_DEBOUNCE_MS);
		this.statusTimer.unref?.();
		// the cue clip stays immediate (plan §4: 说完 → 立即响) — only the
		// text status is debounced.
		if (this.opts.cue) {
			this.trail({ type: "cue_start" });
			this.opts.cue.start();
		}
	}

	private endWait(): void {
		if (!this.waitOn) return;
		this.waitOn = false;
		if (this.statusTimer) {
			clearTimeout(this.statusTimer);
			this.statusTimer = undefined;
		}
		if (this.opts.cue) {
			this.trail({ type: "cue_stop" });
			this.opts.cue.stop();
		}
	}

	/** local barge-in (EarsReceiver's gate) — turn-state-aware (QA R3 ①):
	 * only an OPEN turn can be interrupted. Idle, her speech is just speech:
	 * end the wait (she is talking again, the wait UI would lie) but do NOT
	 * suppress — the upcoming answer must still play. */
	private onLocalBargeIn(): void {
		if (this.state !== "live") return;
		if (this.turnOpen) {
			this.interrupt("local");
			return;
		}
		this.endWait();
		this.setStatus(STATUS_LISTENING); // she's talking — the UI must not lie
		this.trail({ type: "barge_in_idle" });
	}

	private onAudio(chunk: Buffer): void {
		if (this.state !== "live") return;
		if (this.suppressed) {
			this.droppedLateChunks++;
			return;
		}
		if (!this.turnOpen) {
			this.endWait();
			this.opts.speaker.beginTurn();
			this.turnOpen = true;
			this.setStatus(STATUS_SPEAKING);
			if (this.speechEndAt !== null) {
				this.trail({
					type: "first_audio",
					sinceSpeechEndMs: (this.opts.now ?? Date.now)() - this.speechEndAt,
				});
				this.speechEndAt = null;
			}
		}
		this.opts.speaker.feed(chunk);
		this.armGapTimer();
	}

	private armGapTimer(): void {
		if (this.gapTimer) clearTimeout(this.gapTimer);
		this.gapTimer = setTimeout(() => {
			this.gapTimer = undefined;
			if (this.turnOpen) {
				this.opts.speaker.endTurn();
				this.turnOpen = false;
				this.trail({ type: "turn_end", reason: "gap" });
				this.setStatus(STATUS_LISTENING);
			}
		}, this.opts.turnGapMs ?? DEFAULT_TURN_GAP_MS);
		this.gapTimer.unref?.();
	}

	private interrupt(source: "platform" | "local"): void {
		if (this.state !== "live") return;
		this.endWait();
		if (this.gapTimer) {
			clearTimeout(this.gapTimer);
			this.gapTimer = undefined;
		}
		this.opts.speaker.flush();
		this.turnOpen = false;
		this.suppressed = true;
		this.trail({ type: "interruption", source });
		// the mouth just stopped — a stale 🧠/💬 status would lie (Codex R3-fix-1)
		this.setStatus(STATUS_LISTENING);
	}

	/**
	 * FLY-1160 §4.2-4: the exactly-once finalizer. Five reasons (manual / WS
	 * error / start-failure / shutdown / no-show) converge to ONE landing.
	 * Strict order (Codex R2 #3 — silence the live links BEFORE the minutes
	 * turn, else the old turn's disconnect-interrupt cancels the minutes turn):
	 *   ① CAS finalizing (repeat stop returns the same promise) →
	 *   ② stop new input: unsubscribe ears + close WS + SUSPEND the brain key
	 *      (BrainPort 404s new shim turns) →
	 *   ③ mouth/cue synchronously stop →
	 *   ④ interrupt the in-flight brain turn + AWAIT its barrier (Codex #552
	 *      R1 HIGH-5 — a closed WS does not prove the custom-LLM HTTP turn is
	 *      cancelled) →
	 *   ⑤ freeze + timestamp the journal →
	 *   ⑥ reason branch: start-failure/no-show → abort-close (NO minutes);
	 *      else → resident final-turn minutes (brain failed → degraded journal
	 *      record) → landing →
	 *   ⑦ finally: slot release, always.
	 * The shutdown deadline signal (§3.3 Phase 2) is TRUE cancellation: it
	 * reaches the minutes brain turn and landing.land — once aborted, no
	 * further external write happens.
	 */
	async stop(
		reason: ElevenStopReason = "manual",
		opts: { signal?: AbortSignal } = {},
	): Promise<void> {
		// bridge the incoming deadline signal into the shared controller FIRST —
		// this must happen even for a repeat stop(), so a shutdown that races an
		// already-running finalizer still cancels its writes (Codex #552 R2 H1).
		if (opts.signal) {
			if (opts.signal.aborted) this.finalizeAbort.abort();
			else
				opts.signal.addEventListener("abort", () => this.finalizeAbort.abort());
		}
		if (this.finalizePromise) return this.finalizePromise;
		this.finalizePromise = this.finalize(reason);
		return this.finalizePromise;
	}

	private async finalize(reason: ElevenStopReason): Promise<void> {
		const signal = this.finalizeAbort.signal;
		// ② stop new input: unsubscribe ears + close WS + suspend brain key so
		// BrainPort refuses new shim turns while the minutes turn runs.
		this.state = "ended";
		if (this.gapTimer) clearTimeout(this.gapTimer);
		this.gapTimer = undefined;
		for (const u of this.unsubs.splice(0)) u();
		this.opts.suspendBrain?.();
		// ③ mouth/cue synchronously stop
		this.endWait();
		this.opts.speaker.flush();
		this.ws?.close();
		this.ws = null;
		this.opts.voice.leave();

		// ④ interrupt the in-flight brain turn and AWAIT its barrier before the
		// minutes turn (a real meeting only — start-failure never had a turn).
		// Codex #552 R3 MEDIUM-4: a barrier FAILURE cannot prove the old turn
		// stopped, so the resident minutes turn is UNSAFE — skip it and land a
		// journal-degraded record instead (never a silent skip).
		let barrierFailed = false;
		if (reason !== "start-failure") {
			try {
				await this.opts.brainInterrupt?.();
			} catch (err) {
				barrierFailed = true;
				this.opts.log?.(
					`[eleven-session] brain interrupt barrier failed (${reason}) — skipping the resident minutes turn, journal-degrading: ${String((err as Error).message ?? err)}`,
				);
			}
		}

		// ⑤ freeze the journal with a timestamp before any landing reads it
		this.trail({
			type: "session_ended",
			reason,
			droppedLateChunks: this.droppedLateChunks,
		});

		try {
			// ⑥ reason branch
			if (this.opts.issueId) {
				if (reason === "start-failure" || reason === "no-show") {
					await this.abortClose(reason, signal);
				} else {
					await this.landMinutes(reason, signal, barrierFailed);
				}
			}
		} catch (err) {
			this.opts.log?.(
				`[eleven-session] finalize landing failed (${reason}): ${String((err as Error).message ?? err)}`,
			);
		} finally {
			// ⑦ slot release ALWAYS — the meeting is over regardless of landing
			this.opts.slot.release(this.opts.slotMode, this.opts.sessionId);
			this.opts.onEnded?.();
		}
	}

	/** the resident final-turn minutes → landing. Brain failure degrades to a
	 * journal-only record, loudly labeled, never a silent skip. The shutdown
	 * deadline signal reaches BOTH the minutes turn and landing.land. */
	private async landMinutes(
		reason: ElevenStopReason,
		signal?: AbortSignal,
		barrierFailed = false,
	): Promise<void> {
		const issueId = this.opts.issueId as string;
		if (!this.opts.landing) return; // pre-1160 bare surface
		this.opts.tiv?.status("🛬 正在落纪要…");
		let minutes: ElevenMinutes | null = null;
		// Codex #552 R3 MEDIUM-4: an unproven barrier means the resident brain
		// may still be mid-turn — NEVER drive a second (minutes) turn onto it;
		// degrade straight to the journal record.
		if (barrierFailed) {
			this.opts.log?.(
				`[eleven-session] barrier unproven (${reason}) — journal-degraded record, no resident minutes turn`,
			);
		} else {
			try {
				minutes = (await this.opts.generateMinutes?.(signal)) ?? null;
			} catch (err) {
				this.opts.log?.(
					`[eleven-session] minutes generation threw (${reason}) — degrading to journal: ${String((err as Error).message ?? err)}`,
				);
			}
		}
		const degraded = !minutes || minutes.degraded === true;
		const input = {
			issueId,
			sessionId: this.opts.sessionId,
			recapText:
				minutes?.recapText || "(脑不可用——本纪要由 journal 兜底,未经模型整理)",
			quotes: minutes?.quotes ?? this.opts.journalQuotes?.() ?? [],
			// a degraded (brain-failed) landing is never "confirmed" minutes
			confirmed: !degraded,
		};
		this.trail({ type: "landing_start", degraded });
		const r = await this.opts.landing.land(input, signal ? { signal } : {});
		if (r.ok) {
			this.opts.tiv?.status(`✅ 会议纪要已落 ${issueId}`);
		} else {
			this.opts.tiv?.status(
				r.message ?? `落地未完成——${issueId} 保持打开,可重跑。`,
			);
		}
	}

	/** the "meeting never happened" path (start-failure / no-show): comment +
	 * close the kickoff issue without minutes (GeminiCommand abort shape).
	 * Returns whether the issue was actually closed (Codex #552 R1 MEDIUM-9:
	 * the founder-facing reply must not claim a close that failed). */
	private async abortClose(
		reason: ElevenStopReason,
		signal?: AbortSignal,
	): Promise<boolean> {
		const issueId = this.opts.issueId as string;
		if (!this.opts.linearAbort) return false;
		// Codex #552 R3 HIGH-2: the shutdown deadline reaches abort-close too —
		// gate each write both BEFORE (skip) and AFTER (don't chain the next
		// mutation) so an aborted comment cannot trigger a deadline-crossing
		// close.
		const aborted = (): boolean => {
			if (signal?.aborted) {
				this.trail({ type: "abort_close", reason, aborted: true });
				this.opts.log?.(
					`[eleven-session] abort-close cut by the shutdown deadline (${reason}) — no further mutation`,
				);
				return true;
			}
			return false;
		};
		const note =
			reason === "no-show"
				? "本次 /eleven 没开成——founder 未加入语音频道(no-show)。"
				: "本次 /eleven 没开成——会话启动失败(start-failure)。";
		const sigOpts = signal ? { signal } : {};
		try {
			if (aborted()) return false;
			// TRUE cancellation: the signal reaches the underlying fetch (Codex
			// #552 R4 HIGH) — an in-flight comment/close is aborted, not merely
			// left un-chained. The post-await gate still stops the close from
			// chaining after a slow comment that did commit.
			await this.opts.linearAbort.comment(issueId, note, sigOpts);
			if (aborted()) return false; // deadline hit mid-comment — do NOT close
			await this.opts.linearAbort.closeIssue(issueId, sigOpts);
			if (signal?.aborted) {
				// close committed but the deadline passed — report honestly
				this.trail({ type: "abort_close", reason, issueClosed: true });
				return false;
			}
			this.trail({ type: "abort_close", reason, issueClosed: true });
			this.issueClosedByAbort = true;
			return true;
		} catch (err) {
			this.trail({ type: "abort_close", reason, issueClosed: false });
			this.opts.log?.(
				`[eleven-session] abort-close failed (${reason}): ${String((err as Error).message ?? err)}`,
			);
			return false;
		}
	}

	private trail(line: Record<string, unknown>): void {
		this.opts.transcript?.({ t: (this.opts.now ?? Date.now)(), ...line });
	}
}
