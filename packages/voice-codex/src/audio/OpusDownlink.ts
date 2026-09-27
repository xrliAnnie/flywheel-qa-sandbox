import { Readable } from "node:stream";

/** Discord's own 20 ms Opus silence packet (CELT FB, 20 ms). */
export const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

/** A voiced packet taken this recently still counts as audible (plan T5). */
const AUDIBLE_TAIL_MS = 300;
/** 500 ms of live backlog; FLY-2884 never exceeded 10 packets. */
const TRIM_ABOVE_PACKETS = 25;
const TRIM_TO_PACKETS = 3;

export interface OpusDownlinkPacketMeta {
	voiced: boolean;
	/** Released from the barge-in replay buffer (plan T5). */
	replay?: boolean;
	/** A silence frame standing in for a muted packet (plan T5/T5c). */
	silenceFill?: boolean;
}

export interface OpusDownlinkConsumption {
	voiced: boolean;
	replay: boolean;
	silenceFill: boolean;
	pushedAt: number;
	at: number;
}

export interface OpusDownlinkOptions {
	player: {
		play(resource: unknown): void;
		stop(): void;
		on?(event: "idle", callback: () => void): void;
	};
	createResource(source: { kind: "opus-stream"; stream: Readable }): unknown;
	assertLease?(): void;
	onError?(error: Error): void;
	onDiagnostic?(record: Record<string, unknown>): void;
	/** Every packet the player actually took, in play order. */
	onConsumed?(record: OpusDownlinkConsumption): void;
	/** Packets that were queued and will never be heard. */
	onDropped?(input: {
		reason: "cut" | "trim";
		packets: number;
		voiced: number;
	}): void;
	/** Monotonic milliseconds. */
	now?: () => number;
}

interface QueuedPacket {
	voiced: boolean;
	replay: boolean;
	silenceFill: boolean;
	pushedAt: number;
}

/**
 * The object-mode Opus stream a discord.js resource plays. For StreamType.Opus
 * the resource reads this stream directly, one packet per 20 ms cycle, so
 * overriding read() observes exactly what the player took.
 */
class OpusPacketStream extends Readable {
	retired = false;
	private internal = false;

	constructor(private readonly taken: () => void) {
		super({ objectMode: true, highWaterMark: 1 << 16 });
	}

	override _read(): void {}

	override read(size?: number): unknown {
		const packet = super.read(size);
		if (packet !== null && !this.internal && !this.retired) this.taken();
		return packet;
	}

	/** Remove the oldest packet without it counting as played. */
	discardOne(): boolean {
		this.internal = true;
		try {
			return super.read() !== null;
		} finally {
			this.internal = false;
		}
	}
}

/**
 * FLY-2885 T4: WebRTC downlink Opus straight into the Discord player. A
 * packet is pushed synchronously from the RTP callback (first frame plays on
 * the next cycle) and is never decoded or re-encoded.
 */
export class OpusDownlink {
	private stream?: OpusPacketStream;
	private readonly queue: QueuedPacket[] = [];
	/** Replay debt is digested only by playback and skipped silence. */
	private replayBacklog = false;
	private lastVoicedTakenAt?: number;
	private voicedTaken = 0;
	private trims = 0;
	private stopped = false;
	private readonly now: () => number;

	constructor(private readonly options: OpusDownlinkOptions) {
		this.now = options.now ?? (() => performance.now());
	}

	start(): void {
		if (this.stream || this.stopped) return;
		this.options.player.on?.("idle", () => {
			if (this.stopped) return;
			// The player gives up after its missed-frame limit; keep the room
			// playable for the next answer.
			this.open();
			this.options.onDiagnostic?.({ kind: "downlink_player_idle_rebuilt" });
		});
		this.open();
	}

	push(payload: Buffer, meta: OpusDownlinkPacketMeta): boolean {
		if (this.stopped || !this.stream) return false;
		try {
			this.options.assertLease?.();
		} catch (error) {
			this.cut();
			this.stop();
			this.options.onError?.(error as Error);
			return false;
		}
		this.queue.push({
			voiced: meta.voiced,
			replay: meta.replay === true,
			silenceFill: meta.silenceFill === true,
			pushedAt: this.now(),
		});
		this.replayBacklog ||= meta.replay === true;
		this.stream.push(Buffer.from(payload));
		if (this.queue.length > TRIM_ABOVE_PACKETS && !this.replayBacklog)
			this.trim();
		return true;
	}

	/**
	 * Barge-in / generation change / lease loss: nothing queued may be heard.
	 * A new resource replaces the old one; the old stream and everything in it
	 * is destroyed at once.
	 */
	cut(): number {
		if (this.stopped || !this.stream) return 0;
		const dropped = this.queue.splice(0);
		const voiced = dropped.filter((packet) => packet.voiced).length;
		this.open();
		this.options.onDiagnostic?.({
			kind: "downlink_flushed",
			droppedPackets: dropped.length,
			droppedVoiced: voiced,
		});
		if (dropped.length > 0)
			this.options.onDropped?.({
				reason: "cut",
				packets: dropped.length,
				voiced,
			});
		return dropped.length;
	}

	/** Voiced audio still waiting, or taken by the player within 300 ms. */
	audible(): boolean {
		if (this.queue.some((packet) => packet.voiced)) return true;
		return (
			this.lastVoicedTakenAt !== undefined &&
			this.now() - this.lastVoicedTakenAt <= AUDIBLE_TAIL_MS
		);
	}

	/**
	 * Counters for playback proof (plan T5b): real voiced packets the player
	 * took (substituted silence excluded) and backlog trims so far.
	 */
	stats(): { consumedVoiced: number; trims: number } {
		return { consumedVoiced: this.voicedTaken, trims: this.trims };
	}

	queued(): { total: number; voiced: number } {
		return {
			total: this.queue.length,
			voiced: this.queue.filter((packet) => packet.voiced).length,
		};
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.queue.length = 0;
		this.replayBacklog = false;
		if (this.stream) {
			this.stream.retired = true;
			this.stream.destroy();
		}
		this.stream = undefined;
		this.options.player.stop();
	}

	private open(): void {
		const previous = this.stream;
		if (previous) previous.retired = true;
		const stream = new OpusPacketStream(() => this.taken(stream));
		this.stream = stream;
		this.queue.length = 0;
		this.replayBacklog = false;
		this.options.player.play(
			this.options.createResource({ kind: "opus-stream", stream }),
		);
		previous?.destroy();
	}

	private taken(stream: OpusPacketStream): void {
		if (stream !== this.stream) return;
		const packet = this.queue.shift();
		if (!packet) return;
		if (
			this.replayBacklog &&
			!this.queue.some((queued) => queued.replay) &&
			this.queue.length < TRIM_ABOVE_PACKETS
		)
			this.replayBacklog = false;
		const at = this.now();
		if (packet.voiced && !packet.silenceFill) {
			this.lastVoicedTakenAt = at;
			this.voicedTaken += 1;
		}
		this.options.onConsumed?.({ ...packet, at });
	}

	private trim(): void {
		const stream = this.stream;
		if (!stream) return;
		const from = this.queue.length;
		this.trims += 1;
		let voiced = 0;
		while (this.queue.length > TRIM_TO_PACKETS && stream.discardOne()) {
			if (this.queue.shift()?.voiced) voiced += 1;
		}
		this.options.onDiagnostic?.({
			kind: "downlink_queue_trim",
			from,
			to: this.queue.length,
			droppedVoiced: voiced,
		});
		this.options.onDropped?.({
			reason: "trim",
			packets: from - this.queue.length,
			voiced,
		});
	}
}
