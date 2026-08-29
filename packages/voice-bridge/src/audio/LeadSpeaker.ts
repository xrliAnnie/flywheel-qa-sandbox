/**
 * LeadSpeaker — one Lead bot's mouth (FLY-545 P4).
 *
 * A serial utterance queue over a resident AudioPlayer:
 *   - file sources   → pre-synthesized earcon/filler (zero synth wait).
 *   - audio buffers  → already-synthesized media (edge-tts mp3, PCM).
 *   - text           → injected TtsEngine (voice-core EdgeTts — text travels
 *                      via its 0600 temp file, never argv).
 *
 * stop() is the barge-in fast path: it clears the queue and calls
 * player.stop() SYNCHRONOUSLY (the PRD <100ms budget is a local call).
 * Cancelled utterances RESOLVE with `cancelled: true` (stop is a normal
 * outcome of a live meeting, not an error); real failures (TTS/subprocess/
 * player) reject explicitly and the queue moves on.
 *
 * All Discord/player specifics are injected seams (voice-core pattern): the
 * real adapter maps @discordjs/voice AudioPlayerStatus onto "playing"/"idle".
 */
import { Readable } from "node:stream";
import type { TtsEngine } from "flywheel-voice-core";

export interface PlayerLike {
	play(resource: unknown): void;
	stop(): void;
	on(event: "playing" | "idle" | "error", cb: (err?: Error) => void): void;
}

export type SpeakSource =
	| { kind: "file"; path: string }
	| { kind: "audio"; audio: Buffer }
	| { kind: "text"; text: string };

export type ResourceSource =
	| { kind: "file"; path: string }
	| { kind: "stream"; stream: Readable };

export interface LeadSpeakerResult {
	/** synth wait for text sources; 0 for pre-synthesized file/audio. */
	ttsFirstByteMs: number;
	/** item-processing start → player actually Playing (honest anchor). */
	playbackStartMs: number;
	/** Playing → Idle. */
	durationMs: number;
	/** true when stop() cut this utterance (queued or mid-play). */
	cancelled: boolean;
}

export interface LeadSpeakerOptions {
	player: PlayerLike;
	/** wrap a source into a backend AudioResource (real: createAudioResource). */
	createResource: (src: ResourceSource) => unknown;
	/** required only for text sources. */
	tts?: TtsEngine;
	/** edge-tts voice id for text sources (leads[].voice). */
	voice?: string;
	now?: () => number;
}

const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

interface QueueItem {
	source: SpeakSource;
	resolve: (r: LeadSpeakerResult) => void;
	reject: (err: Error) => void;
	abort: AbortController;
	cancelled: boolean;
}

/** timestamped at push time — consuming on a later microtask must not skew
 * the honest playbackStart/duration measurements. */
type PlayerEvent = {
	type: "playing" | "idle" | "error";
	err?: Error;
	at: number;
};

export class LeadSpeaker {
	private readonly queue: QueueItem[] = [];
	private current: QueueItem | null = null;
	private readonly now: () => number;
	/**
	 * Player events are BUFFERED, never handled by re-registered one-shot
	 * callbacks: a short resource can transition Playing→Idle inside the
	 * microtask gap between two awaits, and a dropped Idle would hang the
	 * queue forever. run() drains this buffer.
	 */
	private pendingEvents: PlayerEvent[] = [];
	private wakeWaiter: (() => void) | null = null;

	constructor(private readonly opts: LeadSpeakerOptions) {
		this.now = opts.now ?? Date.now;
		opts.player.on("playing", () =>
			this.pushEvent({ type: "playing", at: this.now() }),
		);
		opts.player.on("idle", () =>
			this.pushEvent({ type: "idle", at: this.now() }),
		);
		opts.player.on("error", (err) =>
			this.pushEvent({
				type: "error",
				err: err ?? new Error("player error"),
				at: this.now(),
			}),
		);
	}

	private pushEvent(e: PlayerEvent): void {
		this.pendingEvents.push(e);
		this.wakeWaiter?.();
	}

	private async nextEvent(): Promise<PlayerEvent> {
		while (this.pendingEvents.length === 0) {
			await new Promise<void>((resolve) => {
				this.wakeWaiter = resolve;
			});
			this.wakeWaiter = null;
		}
		// non-null: loop guarantees at least one buffered event
		return this.pendingEvents.shift() as PlayerEvent;
	}

	speak(source: SpeakSource): Promise<LeadSpeakerResult> {
		return new Promise<LeadSpeakerResult>((resolve, reject) => {
			this.queue.push({
				source,
				resolve,
				reject,
				abort: new AbortController(),
				cancelled: false,
			});
			this.pump();
		});
	}

	/** barge-in fast path: clear queue + stop the player, synchronously. */
	stop(): void {
		for (const item of this.queue.splice(0)) {
			item.cancelled = true;
			item.resolve(cancelledResult());
		}
		if (this.current) {
			this.current.cancelled = true;
			this.current.abort.abort();
		}
		// player.stop() → Idle; the in-flight run() observes `cancelled`.
		this.opts.player.stop();
	}

	private pump(): void {
		if (this.current || this.queue.length === 0) return;
		const item = this.queue.shift();
		if (!item) return;
		this.current = item;
		void this.run(item).finally(() => {
			this.current = null;
			this.pump();
		});
	}

	private async run(item: QueueItem): Promise<void> {
		const start = this.now();
		let resource: unknown;
		let ttsFirstByteMs = 0;
		try {
			if (item.source.kind === "text") {
				if (!this.opts.tts) {
					throw new Error(
						"LeadSpeaker: a text utterance needs an injected TTS engine (tts option)",
					);
				}
				const synth = await this.opts.tts.synthesize(
					item.source.text,
					this.opts.voice ?? DEFAULT_VOICE,
					{ signal: item.abort.signal },
				);
				ttsFirstByteMs = synth.ttsFirstByteMs;
				if (item.cancelled) {
					item.resolve(cancelledResult(ttsFirstByteMs));
					return;
				}
				resource = this.opts.createResource({
					kind: "stream",
					stream: Readable.from(synth.audio),
				});
			} else if (item.source.kind === "audio") {
				resource = this.opts.createResource({
					kind: "stream",
					stream: Readable.from(item.source.audio),
				});
			} else {
				resource = this.opts.createResource({
					kind: "file",
					path: item.source.path,
				});
			}
		} catch (err) {
			if (item.cancelled) {
				// stop() aborted the synth — a normal live-meeting outcome.
				item.resolve(cancelledResult(ttsFirstByteMs));
				return;
			}
			item.reject(asError(err));
			return;
		}
		if (item.cancelled) {
			item.resolve(cancelledResult(ttsFirstByteMs));
			return;
		}

		try {
			// stale events from a previous item (e.g. the Idle a stop() forced)
			// must not be attributed to this one.
			this.pendingEvents.length = 0;
			this.opts.player.play(resource);

			// phase 1: wait for Playing (or a stop-forced Idle, or an error).
			let playbackStartMs: number;
			let playingAt: number;
			for (;;) {
				const e = await this.nextEvent();
				if (e.type === "error") throw e.err ?? new Error("player error");
				if (e.type === "playing") {
					playbackStartMs = e.at - start;
					playingAt = e.at;
					break;
				}
				// idle before Playing: a stop() cut us; anything else is a player
				// fault that must not resolve as success.
				if (item.cancelled) {
					item.resolve(cancelledResult(ttsFirstByteMs));
					return;
				}
				throw new Error(
					"player went idle before playback started (resource failed?)",
				);
			}

			// phase 2: wait for Idle (repeated Playing = buffer-underrun resume).
			let idleAt: number;
			for (;;) {
				const e = await this.nextEvent();
				if (e.type === "error") throw e.err ?? new Error("player error");
				if (e.type === "idle") {
					idleAt = e.at;
					break;
				}
			}
			const durationMs = idleAt - playingAt;
			item.resolve({
				ttsFirstByteMs,
				playbackStartMs,
				durationMs,
				cancelled: item.cancelled,
			});
		} catch (err) {
			if (item.cancelled) {
				item.resolve(cancelledResult(ttsFirstByteMs));
				return;
			}
			item.reject(asError(err));
		}
	}
}

function cancelledResult(
	ttsFirstByteMs = 0,
	playbackStartMs = 0,
): LeadSpeakerResult {
	return { ttsFirstByteMs, playbackStartMs, durationMs: 0, cancelled: true };
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
