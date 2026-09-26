/**
 * AssistantSpeaker (FLY-967 P3) — the /gemini assistant's mouth on the
 * orchestrator bot. Unlike LeadSpeaker's discrete utterance queue, a model
 * turn here is a CONTINUOUS response-audio chunk stream:
 *
 *   beginTurn() → feed(24k mono chunk)* → endTurn()
 *
 * The first feed of a turn opens ONE PassThrough → createResource(stream) →
 * player.play (never a resource per chunk — that pops). flush() is the
 * barge-in fast path: destroy the stream + player.stop() synchronously, and
 * gate any late chunks of the dead turn out (belt-and-braces on top of the
 * voice-core turn suppression). Earcon/filler are pre-synthesized files —
 * sync function calling leaves the model silent while a tool runs, so the
 * earcon plays on tool-call and the filler fires if no answer lands within
 * fillerDelayMs; neither may ever cut a live turn stream.
 */
import { PassThrough } from "node:stream";
import type { PlayerLike, ResourceSource } from "./../audio/LeadSpeaker.js";
import { upsample24kMonoTo48kStereo } from "../audio/resample.js";

export interface AssistantSpeakerOptions {
	player: PlayerLike;
	/** wrap a source into a backend AudioResource (real: createAudioResource
	 * with StreamType.Raw for streams — 48k s16le stereo). */
	createResource: (src: ResourceSource) => unknown;
	/** 24k mono → 48k stereo; injectable for tests. */
	upsample?: (chunk: Buffer) => Buffer;
	/** PassThrough buffer cap; exceeding it logs a backpressure warning. */
	highWaterMark?: number;
	/** pre-synthesized tool-call earcon (file path). */
	earconPath?: string;
	/** pre-synthesized "我查一下" clip (file path). */
	fillerPath?: string;
	/** tool silence → filler delay; default 2000ms. */
	fillerDelayMs?: number;
	log?: (line: string) => void;
}

const DEFAULT_FILLER_DELAY_MS = 2000;
const DEFAULT_HWM = 1 << 20; // 1 MiB ≈ 5.5s of 48k stereo s16le

export class AssistantSpeaker {
	private stream: PassThrough | null = null;
	private active = false;
	private warnedBackpressure = false;
	private fillerTimer: ReturnType<typeof setTimeout> | undefined;
	/** observability: late chunks dropped by the turn gate. */
	droppedChunks = 0;
	private chunksThisTurn = 0;
	private bytesThisTurn = 0;

	constructor(private readonly opts: AssistantSpeakerOptions) {}

	/** a fresh assistant turn is about to stream (response-started). */
	beginTurn(): void {
		this.active = true;
		this.warnedBackpressure = false;
		this.chunksThisTurn = 0;
		this.bytesThisTurn = 0;
		this.opts.log?.("[assistant-speaker] turn begin");
	}

	/** one response-audio chunk (24k mono s16le) of the current turn. */
	feed(chunk: Buffer): void {
		if (!this.active) {
			this.droppedChunks++;
			return;
		}
		this.chunksThisTurn++;
		this.bytesThisTurn += chunk.length;
		if (this.chunksThisTurn === 1) {
			this.opts.log?.(
				`[assistant-speaker] first audio chunk (${chunk.length} bytes, 24k mono)`,
			);
		}
		if (!this.stream) {
			this.stream = new PassThrough({
				highWaterMark: this.opts.highWaterMark ?? DEFAULT_HWM,
			});
			this.opts.player.play(
				this.opts.createResource({ kind: "stream", stream: this.stream }),
			);
			this.opts.log?.("[assistant-speaker] playing turn stream on the player");
		}
		const upsample = this.opts.upsample ?? upsample24kMonoTo48kStereo;
		const ok = this.stream.write(upsample(chunk));
		if (!ok && !this.warnedBackpressure) {
			this.warnedBackpressure = true;
			this.opts.log?.(
				"[assistant-speaker] stream backpressure — model audio outrunning playback beyond highWaterMark",
			);
		}
	}

	/** the turn finished cleanly (response-done) — let the tail play out. */
	endTurn(): void {
		this.active = false;
		this.opts.log?.(
			`[assistant-speaker] turn end — chunks=${this.chunksThisTurn} bytes=${this.bytesThisTurn} dropped=${this.droppedChunks}`,
		);
		this.stream?.end();
		this.stream = null;
	}

	/** barge-in / response-cancelled: stop sound NOW and kill the dead turn. */
	flush(): void {
		this.active = false;
		this.clearFiller();
		if (this.stream) {
			this.stream.destroy();
			this.stream = null;
		}
		this.opts.player.stop();
	}

	/** tool-call landed: earcon right away, filler armed for a silent tool. */
	noteToolCall(): void {
		this.playClip(this.opts.earconPath, "earcon");
		this.clearFiller();
		if (this.opts.fillerPath) {
			this.fillerTimer = setTimeout(() => {
				this.playClip(this.opts.fillerPath, "filler");
			}, this.opts.fillerDelayMs ?? DEFAULT_FILLER_DELAY_MS);
			this.fillerTimer.unref?.();
		}
	}

	/** the tool answered — no filler needed. */
	noteToolResolved(): void {
		this.clearFiller();
	}

	private clearFiller(): void {
		if (this.fillerTimer) clearTimeout(this.fillerTimer);
		this.fillerTimer = undefined;
	}

	private playClip(path: string | undefined, kind: string): void {
		if (!path) return;
		if (this.stream) {
			// a clip must never cut live turn audio — skip, loudly.
			this.opts.log?.(
				`[assistant-speaker] ${kind} skipped — a turn stream is live on the player`,
			);
			return;
		}
		this.opts.player.play(this.opts.createResource({ kind: "file", path }));
	}
}
