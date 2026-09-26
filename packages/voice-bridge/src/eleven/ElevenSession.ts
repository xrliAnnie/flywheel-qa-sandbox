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

export interface ElevenSessionOptions {
	sessionId: string;
	topic?: string;
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

	constructor(private readonly opts: ElevenSessionOptions) {}

	get stateName(): ElevenSessionState {
		return this.state;
	}

	async start(): Promise<void> {
		const { opts } = this;
		try {
			await opts.voice.join();
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
				onMetadata: (meta) => this.trail({ type: "metadata", meta }),
				onError: (err) => {
					this.trail({ type: "error", message: err.message });
					opts.log?.(`[eleven-session] ws error: ${err.message}`);
				},
				onClose: () => {
					if (this.state === "live") {
						opts.log?.("[eleven-session] ws closed — tearing down");
						void this.stop();
					}
				},
			});
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
			await this.stop();
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

	/** idempotent teardown — every exit path lands here exactly once. */
	async stop(): Promise<void> {
		if (this.state === "ended") return;
		this.state = "ended";
		if (this.gapTimer) clearTimeout(this.gapTimer);
		this.gapTimer = undefined;
		for (const u of this.unsubs.splice(0)) u();
		this.endWait();
		this.opts.speaker.flush();
		this.ws?.close();
		this.ws = null;
		this.opts.voice.leave();
		this.opts.slot.release(this.opts.slotMode, this.opts.sessionId);
		this.trail({
			type: "session_ended",
			droppedLateChunks: this.droppedLateChunks,
		});
		this.opts.onEnded?.();
	}

	private trail(line: Record<string, unknown>): void {
		this.opts.transcript?.({ t: (this.opts.now ?? Date.now)(), ...line });
	}
}
