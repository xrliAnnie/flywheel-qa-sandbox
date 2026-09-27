import {
	OPUS_SILENCE_FRAME,
	type OpusDownlinkPacketMeta,
} from "../audio/OpusDownlink.js";

/** The player-side half of the downlink (OpusDownlink). */
export interface DownlinkSink {
	push(payload: Buffer, meta: OpusDownlinkPacketMeta): boolean;
	cut(): number;
	audible(): boolean;
	queued(): { total: number; voiced: number };
	stats(): { consumedVoiced: number; trims: number };
}

export type DownlinkState =
	| "playing"
	| "muted"
	| "deciding"
	| "waitGap"
	| "discard";

const PACKET_MS = 20;
/** 1.5 s of packets kept while muted (plan T5). */
const REPLAY_BUFFER_PACKETS = 75;
/** A gap of ≥240 ms of downlink silence marks a turn boundary (2884 s3: 15/19). */
const QUALIFYING_GAP_PACKETS = 12;
/** Without any user-turn evidence, resume 3 s after the cut… */
const FALLBACK_AFTER_CUT_MS = 3_000;
/** …once the founder's gate has been closed for 1.5 s. */
const FALLBACK_GATE_CLOSED_MS = 1_500;
/** WaitGap gives up and releases live 2 s after deciding began. */
const WAIT_GAP_DEADLINE_MS = 2_000;
/** Replay backlog: silence is dropped while more than this is queued. */
const BACKLOG_PACKETS = 3;
/** T5c: without a done, this much silence means the turn cannot be resumed. */
const DISCARD_SILENCE_WITHOUT_DONE_PACKETS = 75;
/** T5c: absolute limit of the discard state. */
const DISCARD_DEADLINE_MS = 15_000;

interface BufferedPacket {
	index: number;
	payload: Buffer;
	voiced: boolean;
}

interface Gap {
	start: number;
	/** First packet after the gap (a voiced one). */
	end: number;
}

export interface DownlinkControllerOptions {
	sink(): DownlinkSink | undefined;
	now(): number;
	evidence(record: Record<string, unknown>): void;
	/** T5c: the overrun turn cannot be resumed on this generation. */
	forceReconnect(reason: "silence_without_done" | "deadline"): void;
}

/**
 * FLY-2885 T5/T5c: decides, packet by packet, what of the WebRTC downlink the
 * room hears.
 *
 * Barge-in (T5): the founder's first gated speech cuts the player at once and
 * mutes the downlink (silence frames keep the player fed) while recent
 * packets go into a 1.5 s buffer. Events arrive later than audio and at no
 * fixed offset, so the new answer's start can only be estimated: the longest
 * ≥240 ms downlink silence after the cut. Every path ends: without evidence a
 * 3 s fallback applies, and without a qualifying gap a 2 s deadline releases
 * live. Each resumption is recorded for QA.
 *
 * Overrun discard (T5c): a read-aloud turn that goes past its line is muted
 * until its done plus 240 ms of silence; without a done it is never resumed —
 * 1.5 s of silence or 15 s in total forces a new generation instead.
 */
export class DownlinkController {
	private current: DownlinkState = "playing";
	private buffer: BufferedPacket[] = [];
	private gaps: Gap[] = [];
	private index = 0;
	private silenceRun = 0;
	private cutAt = 0;
	private decidingAt = 0;
	private evidenceAt?: number;
	private gateOpen = false;
	private gateClosedAt = 0;
	private discardAt = 0;
	private discardDone = false;
	private silenceSinceDone = 0;
	private discardForced = false;
	private interferenceCount = 0;
	/** Lead readback is terminal when cut; ordinary conversation may replay. */
	private replayBuffered = true;

	constructor(private readonly options: DownlinkControllerOptions) {}

	get state(): DownlinkState {
		return this.current;
	}

	get discarding(): boolean {
		return this.current === "discard";
	}

	/** Muted, deciding, waiting for a gap, or discarding. */
	get blocking(): boolean {
		return this.current !== "playing";
	}

	/** Bumped by every client-side cut, trim-free silence substitution or drop. */
	get interference(): number {
		return this.interferenceCount;
	}

	audible(): boolean {
		return this.options.sink()?.audible() ?? false;
	}

	packet(input: { payload: Buffer; voiced: boolean }): void {
		switch (this.current) {
			case "playing":
				this.play(input);
				return;
			case "discard":
				this.discardPacket(input);
				return;
			default:
				this.mutedPacket(input);
		}
	}

	/** The founder's gated speech reached the uplink while audio was audible. */
	bargeIn(options: { replayBuffered?: boolean } = {}): void {
		const wasBargeIn =
			this.current === "muted" ||
			this.current === "deciding" ||
			this.current === "waitGap";
		const requestedReplay = options.replayBuffered ?? true;
		// Repeated room-level cuts during one founder utterance must not turn a
		// terminal readback cut back into the generic replay policy.
		this.replayBuffered = wasBargeIn
			? this.replayBuffered && requestedReplay
			: requestedReplay;
		this.cut();
		const now = this.options.now();
		this.current = "muted";
		this.cutAt = now;
		this.evidenceAt = undefined;
		this.buffer = [];
		this.gaps = [];
		this.index = 0;
		this.silenceRun = 0;
		this.discardForced = false;
		this.options.evidence({ kind: "codex_barge_in_local_cut", cutAt: now });
	}

	/** A user turn started after the cut (turn.created{user} or a user delta). */
	userTurnEvidence(): void {
		if (this.current === "playing" || this.current === "discard") return;
		this.evidenceAt ??= this.options.now();
		this.evaluate();
	}

	founderSpeaking(speaking: boolean): void {
		if (speaking === this.gateOpen) return;
		this.gateOpen = speaking;
		if (!speaking) this.gateClosedAt = this.options.now();
		if (
			speaking &&
			(this.current === "deciding" || this.current === "waitGap")
		) {
			this.current = "muted";
			return;
		}
		this.evaluate();
	}

	/** T5c: the read-aloud turn went past its line. */
	overrunDiscard(): void {
		if (this.current !== "playing" && this.current !== "discard") return;
		this.cut();
		this.current = "discard";
		this.discardAt = this.options.now();
		this.discardDone = false;
		this.silenceSinceDone = 0;
		this.silenceRun = 0;
		this.discardForced = false;
	}

	/** T5c: the overrunning turn's turn.done arrived. */
	overrunTurnDone(): void {
		if (this.current !== "discard") return;
		this.discardDone = true;
		this.silenceSinceDone = 0;
	}

	/** A generation change or close: nothing of before may be heard. */
	reset(): void {
		this.cut();
		this.current = "playing";
		this.buffer = [];
		this.gaps = [];
		this.silenceRun = 0;
		this.evidenceAt = undefined;
		this.discardForced = false;
		this.replayBuffered = true;
	}

	private play(input: { payload: Buffer; voiced: boolean }): void {
		const sink = this.options.sink();
		if (!sink) return;
		if (!input.voiced && sink.queued().total > BACKLOG_PACKETS) {
			// A replay backlog is digested in pauses: only silence is skipped.
			this.interferenceCount += 1;
			return;
		}
		sink.push(input.payload, { voiced: input.voiced });
	}

	private mutedPacket(input: { payload: Buffer; voiced: boolean }): void {
		this.fill();
		const index = this.index++;
		this.buffer.push({ index, payload: input.payload, voiced: input.voiced });
		if (this.buffer.length > REPLAY_BUFFER_PACKETS) this.buffer.shift();
		if (input.voiced) {
			if (this.silenceRun >= QUALIFYING_GAP_PACKETS)
				this.gaps.push({ start: index - this.silenceRun, end: index });
			if (
				this.current === "waitGap" &&
				this.silenceRun >= QUALIFYING_GAP_PACKETS
			) {
				const gapPackets = this.silenceRun;
				this.silenceRun = 0;
				this.resume("live", gapPackets, 0, [input]);
				return;
			}
			this.silenceRun = 0;
		} else {
			this.silenceRun += 1;
		}
		this.evaluate();
	}

	private evaluate(): void {
		const now = this.options.now();
		if (this.current === "muted") {
			if (this.gateOpen) return;
			const evidence =
				this.evidenceAt !== undefined && this.evidenceAt >= this.cutAt;
			const fallback =
				!evidence &&
				now - this.cutAt >= FALLBACK_AFTER_CUT_MS &&
				now - this.gateClosedAt >= FALLBACK_GATE_CLOSED_MS;
			if (!evidence && !fallback) return;
			this.current = "deciding";
			this.decidingAt = now;
		}
		if (this.current === "deciding") {
			const gap = this.longestGap();
			if (gap) {
				if (!this.replayBuffered) {
					// A cut Lead readback is abandoned, never reconstructed from
					// packets collected while the founder was speaking. Live packets
					// after this boundary still pass normally.
					this.resume("live", gap.end - gap.start, 0, []);
					return;
				}
				const first = this.buffer[0]?.index ?? this.index;
				if (gap.end < first) {
					this.resume("head_lost", gap.end - gap.start, 0, []);
					return;
				}
				const replay = this.buffer.filter((packet) => packet.index >= gap.end);
				this.resume(
					"replay",
					gap.end - gap.start,
					replay.length * PACKET_MS,
					replay,
					true,
				);
				return;
			}
			this.current = "waitGap";
		}
		if (
			this.current === "waitGap" &&
			now - this.decidingAt >= WAIT_GAP_DEADLINE_MS
		) {
			this.resume("boundary_unknown", 0, 0, []);
		}
	}

	/** Longest qualifying gap after the cut; ties go to the last. */
	private longestGap(): Gap | undefined {
		let best: Gap | undefined;
		for (const gap of this.gaps) {
			if (!best || gap.end - gap.start >= best.end - best.start) best = gap;
		}
		return best;
	}

	private resume(
		boundary: "replay" | "live" | "head_lost" | "boundary_unknown",
		gapPackets: number,
		replayMs: number,
		packets: Array<{ payload: Buffer; voiced: boolean }>,
		replay = false,
	): void {
		const now = this.options.now();
		const trigger =
			this.evidenceAt !== undefined && this.evidenceAt >= this.cutAt
				? "user_turn"
				: "unconfirmed";
		this.current = "playing";
		this.buffer = [];
		this.gaps = [];
		const sink = this.options.sink();
		for (const packet of packets)
			sink?.push(packet.payload, { voiced: packet.voiced, replay });
		this.options.evidence({
			kind: "codex_barge_in_resumed",
			trigger,
			boundary,
			gapMs: gapPackets * PACKET_MS,
			replayMs,
			mutedMs: Math.round(now - this.cutAt),
		});
	}

	private discardPacket(input: { voiced: boolean }): void {
		this.fill();
		if (this.discardForced) return;
		if (input.voiced) {
			this.silenceRun = 0;
			this.silenceSinceDone = 0;
		} else {
			this.silenceRun += 1;
			if (this.discardDone) this.silenceSinceDone += 1;
		}
		if (this.discardDone && this.silenceSinceDone >= QUALIFYING_GAP_PACKETS) {
			this.current = "playing";
			this.silenceRun = 0;
			this.options.evidence({
				kind: "codex_speech_overrun_resumed",
				discardMs: Math.round(this.options.now() - this.discardAt),
			});
			return;
		}
		const reason = !this.discardDone
			? this.silenceRun >= DISCARD_SILENCE_WITHOUT_DONE_PACKETS
				? "silence_without_done"
				: undefined
			: undefined;
		const deadline =
			this.options.now() - this.discardAt >= DISCARD_DEADLINE_MS
				? "deadline"
				: undefined;
		const forced = reason ?? deadline;
		if (!forced) return;
		this.discardForced = true;
		this.options.evidence({
			kind: "codex_speech_overrun_forced_restart",
			reason: forced,
		});
		this.options.forceReconnect(forced);
	}

	private fill(): void {
		this.interferenceCount += 1;
		this.options
			.sink()
			?.push(OPUS_SILENCE_FRAME, { voiced: false, silenceFill: true });
	}

	private cut(): void {
		this.interferenceCount += 1;
		this.options.sink()?.cut();
	}
}
