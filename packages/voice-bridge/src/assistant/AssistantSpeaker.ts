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
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { RoomIO } from "flywheel-voice-core";
import type { PlayerLike, ResourceSource } from "./../audio/LeadSpeaker.js";
import { upsample24kMonoTo48kStereo } from "../audio/resample.js";

export interface AssistantSpeakerOptions {
	player?: PlayerLike;
	/** wrap a source into a backend AudioResource (real: createAudioResource
	 * with StreamType.Raw for streams — 48k s16le stereo). */
	createResource?: (src: ResourceSource) => unknown;
	/** Canonical production path. Legacy tests may keep the player adapter. */
	roomIO?: () => RoomIO | undefined;
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
	private roomSpeechId?: string;
	/** Completed RoomIO speech ids whose estimated audible tail can still play. */
	private readonly endedRoomSpeechIds = new Set<string>();
	private roomSequence = 0;
	private roomCommands: Promise<void> = Promise.resolve();
	private readonly cancelledRoomSpeech = new Set<string>();

	constructor(private readonly opts: AssistantSpeakerOptions) {
		if (!opts.roomIO && (!opts.player || !opts.createResource))
			throw new Error("assistant_speaker_output_required");
	}

	/** a fresh assistant turn is about to stream (response-started). */
	beginTurn(): void {
		this.active = true;
		this.warnedBackpressure = false;
		this.chunksThisTurn = 0;
		this.bytesThisTurn = 0;
		if (this.opts.roomIO) {
			const room = this.opts.roomIO();
			// Retire completed ids once RoomIO's estimated audible tail is drained.
			if (room?.audibleTail().drained) this.endedRoomSpeechIds.clear();
			const speechId = `assistant:${randomUUID()}`;
			this.roomSpeechId = speechId;
			this.roomSequence = 0;
			this.roomCommands = this.roomCommands.then(() => {
				if (this.cancelledRoomSpeech.has(speechId)) return;
				const room = this.opts.roomIO?.();
				if (!room) throw new Error("assistant_room_io_unavailable");
				const receipt = room.startSpeech({
					speechId,
					generation: room.identity.generation,
					format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
				});
				if (receipt.outcome === "rejected") throw new Error(receipt.reason);
			});
			this.observeRoomCommands();
		}
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
		if (this.opts.roomIO) {
			const speechId = this.roomSpeechId;
			if (!speechId) {
				this.droppedChunks++;
				return;
			}
			const sequence = this.roomSequence++;
			const pcm = Buffer.from(chunk);
			this.roomCommands = this.roomCommands.then(async () => {
				if (this.cancelledRoomSpeech.has(speechId)) return;
				const room = this.opts.roomIO?.();
				if (!room) throw new Error("assistant_room_io_unavailable");
				const receipt = await room.writeSpeech({
					speechId,
					generation: room.identity.generation,
					sequence,
					pcm,
				});
				if (receipt.outcome === "rejected") throw new Error(receipt.reason);
			});
			this.observeRoomCommands();
			return;
		}
		if (!this.stream) {
			this.stream = new PassThrough({
				highWaterMark: this.opts.highWaterMark ?? DEFAULT_HWM,
			});
			this.opts.player!.play(
				// raw-stream: headerless 48k s16le stereo PCM — the explicit kind
				// keeps the Raw tag after the 545/967 createResource reconciliation
				// (plain "stream" now takes the ffmpeg probe path for TTS output).
				this.opts.createResource!({ kind: "raw-stream", stream: this.stream }),
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
		if (this.opts.roomIO) {
			const speechId = this.roomSpeechId;
			this.roomSpeechId = undefined;
			if (speechId) {
				this.endedRoomSpeechIds.add(speechId);
				this.roomCommands = this.roomCommands.then(async () => {
					if (this.cancelledRoomSpeech.delete(speechId)) return;
					const room = this.opts.roomIO?.();
					if (!room) throw new Error("assistant_room_io_unavailable");
					const receipt = await room.endSpeech(
						speechId,
						room.identity.generation,
					);
					if (receipt.outcome === "rejected") throw new Error(receipt.reason);
				});
				this.observeRoomCommands();
			}
			return;
		}
		this.stream?.end();
		this.stream = null;
	}

	/** Whether RoomIO still reports an estimated audible tail for this mouth. */
	hasEstimatedAudibleTail(): boolean {
		const room = this.opts.roomIO?.();
		return Boolean(room && !room.audibleTail().drained);
	}

	/** barge-in / response-cancelled: stop sound NOW and kill the dead turn. */
	flush(): void {
		this.active = false;
		this.clearFiller();
		if (this.opts.roomIO) {
			const speechIds = new Set(this.endedRoomSpeechIds);
			if (this.roomSpeechId) speechIds.add(this.roomSpeechId);
			this.roomSpeechId = undefined;
			this.endedRoomSpeechIds.clear();
			if (speechIds.size > 0) {
				const room = this.opts.roomIO();
				for (const speechId of speechIds) {
					this.cancelledRoomSpeech.add(speechId);
					if (room)
						room.localPlaybackCancel(speechId, room.identity.generation);
				}
				this.roomCommands = this.roomCommands.then(() => {
					for (const speechId of speechIds)
						this.cancelledRoomSpeech.delete(speechId);
				});
				this.observeRoomCommands();
			}
			return;
		}
		if (this.stream) {
			this.stream.destroy();
			this.stream = null;
		}
		this.opts.player!.stop();
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
		if (this.stream || this.roomSpeechId) {
			// a clip must never cut live turn audio — skip, loudly.
			this.opts.log?.(
				`[assistant-speaker] ${kind} skipped — a turn stream is live on the player`,
			);
			return;
		}
		if (this.opts.roomIO) {
			const speechId = `${kind}:${randomUUID()}`;
			this.roomCommands = this.roomCommands.then(async () => {
				const room = this.opts.roomIO?.();
				if (!room) throw new Error("assistant_room_io_unavailable");
				const receipt = await room.playClip({
					speechId,
					generation: room.identity.generation,
					source: { kind: "file", path },
					priority: "cue",
				});
				if (receipt.outcome === "rejected") throw new Error(receipt.reason);
			});
			this.observeRoomCommands();
			return;
		}
		this.opts.player!.play(this.opts.createResource!({ kind: "file", path }));
	}

	private observeRoomCommands(): void {
		this.roomCommands = this.roomCommands.catch((error) => {
			this.opts.log?.(
				`[assistant-speaker] RoomIO output failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}
}
