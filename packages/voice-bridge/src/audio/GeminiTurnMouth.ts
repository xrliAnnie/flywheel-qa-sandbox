/**
 * GeminiTurnMouth (FLY-545 PR-2 P9′) — one Lead's mouth for the huddle's
 * gated multi-session engine. Each participating Lead runs its own Gemini
 * Live session whose response audio is a CONTINUOUS 24k mono chunk stream:
 *
 *   beginTurn() → feed(24k mono chunk)* → endTurn()
 *
 * The first feed of a turn opens ONE PassThrough → createResource(stream) →
 * player.play (never a resource per chunk — that pops). flush() is the
 * barge-in fast path: destroy the stream + player.stop() synchronously, and
 * gate any late chunks of the dead turn out. The gate doubles as the huddle's
 * one-mouth-at-a-time discipline: HuddleSession only beginTurn()s the
 * speaking-token holder, so audio from a session that was never granted the
 * token lands on a closed gate and is counted, not played (FLY-968's
 * interruption lesson as a runtime belt). Earcon/filler are pre-synthesized
 * files and must never cut a live turn stream.
 *
 * Same contract as FLY-967's assistant/AssistantSpeaker (single-bot form) —
 * kept as separate per-branch modules by the first-to-land boundary ruling;
 * fold into one shared module after both land.
 */
import { PassThrough } from "node:stream";
import type { PlayerLike, ResourceSource } from "./LeadSpeaker.js";
import { upsample24kMonoTo48kStereo } from "./resample.js";

export interface GeminiTurnMouthOptions {
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

export class GeminiTurnMouth {
	private stream: PassThrough | null = null;
	private active = false;
	private warnedBackpressure = false;
	private fillerTimer: ReturnType<typeof setTimeout> | undefined;
	/** observability: late/ungranted chunks dropped by the turn gate. */
	droppedChunks = 0;

	constructor(private readonly opts: GeminiTurnMouthOptions) {}

	/** a fresh model turn is about to stream (response-started, token held). */
	beginTurn(): void {
		// QA R3 P0: a connection that died MID-TURN never sent response-done,
		// leaving a zombie stream whose player resource may be dead — every
		// later turn then writes into a stream nobody plays (silence + the
		// backpressure warnings Annie's log showed). A new turn always starts
		// on a FRESH stream.
		if (this.stream) {
			this.stream.destroy();
			this.stream = null;
			this.opts.player.stop();
		}
		this.active = true;
		this.warnedBackpressure = false;
	}

	/** one response-audio chunk (24k mono s16le) of the current turn. */
	feed(chunk: Buffer): void {
		if (!this.active) {
			this.droppedChunks++;
			return;
		}
		if (!this.stream) {
			this.stream = new PassThrough({
				highWaterMark: this.opts.highWaterMark ?? DEFAULT_HWM,
			});
			this.opts.player.play(
				this.opts.createResource({ kind: "raw-stream", stream: this.stream }),
			);
		}
		const upsample = this.opts.upsample ?? upsample24kMonoTo48kStereo;
		const ok = this.stream.write(upsample(chunk));
		if (!ok && !this.warnedBackpressure) {
			this.warnedBackpressure = true;
			this.opts.log?.(
				"[turn-mouth] stream backpressure — model audio outrunning playback beyond highWaterMark",
			);
		}
	}

	/** the turn finished cleanly (response-done) — let the tail play out. */
	endTurn(): void {
		this.active = false;
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
				`[turn-mouth] ${kind} skipped — a turn stream is live on the player`,
			);
			return;
		}
		this.opts.player.play(this.opts.createResource({ kind: "file", path }));
	}
}
