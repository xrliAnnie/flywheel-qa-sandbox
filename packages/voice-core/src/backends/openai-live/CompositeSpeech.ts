import { randomUUID } from "node:crypto";
import { speakRequestDigest } from "../../headphone/speak-request.js";
import type { RoomIO } from "../../room-io.js";
import type {
	SpeakKind,
	SpeakReceipt,
	SpeakVerification,
	StreamingTtsChunk,
	StreamingTtsEngine,
	VoiceRef,
} from "../../types.js";

export interface CompositeSpeechOptions {
	sessionId: string;
	generation: number;
	room: Pick<
		RoomIO,
		"startSpeech" | "writeSpeech" | "endSpeech" | "localPlaybackCancel"
	>;
	tts: StreamingTtsEngine;
	voice: VoiceRef;
	/** Retire/fence the Live face before the deterministic announcer owns output. */
	beforeSpeak(): Promise<void>;
	/** Optional encoded-to-PCM streaming transform. */
	decode?(
		source: AsyncIterable<StreamingTtsChunk>,
		opts: { signal: AbortSignal },
	): AsyncIterable<StreamingTtsChunk>;
	nextSpeechId?: () => string;
}

interface ActiveSpeech {
	speechId: string;
	abort: AbortController;
	reason?: string;
	submitted: boolean;
}

function errorReason(error: unknown): string {
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code) return code;
	}
	return error instanceof Error ? error.message : String(error);
}

/** Deterministic V1 speak face: incremental TTS → PCM → RoomIO with bounded
 * cancellation and pending-key idempotency. It never routes Lead text through
 * the Live model, so a successful receipt proves the supplied text was the TTS
 * input rather than a model rewrite. */
export class CompositeSpeech {
	private readonly pending = new Map<
		string,
		{ digest: string; promise: Promise<SpeakReceipt> }
	>();
	private active?: ActiveSpeech;

	constructor(private readonly options: CompositeSpeechOptions) {
		if (
			!options.sessionId ||
			!Number.isSafeInteger(options.generation) ||
			options.generation < 1
		) {
			throw new Error("composite_speech_identity_invalid");
		}
	}

	speak(
		text: string,
		kind: SpeakKind,
		opts: { pendingKey: string; verification: SpeakVerification },
	): Promise<SpeakReceipt> {
		const digest = speakRequestDigest({
			sessionId: this.options.sessionId,
			generation: this.options.generation,
			text,
			kind,
			verification: opts.verification,
		});
		const prior = this.pending.get(opts.pendingKey);
		if (prior) {
			if (prior.digest === digest) return prior.promise;
			return Promise.resolve({
				pendingKey: opts.pendingKey,
				requestDigest: digest,
				outcome: "rejected",
				reason: "pending_key_conflict",
				transport: "none",
				contentProof: "none",
			});
		}
		const promise = this.run(text, opts.pendingKey, digest);
		this.pending.set(opts.pendingKey, { digest, promise });
		return promise;
	}

	cancel(reason: string): void {
		const active = this.active;
		if (!active || active.reason) return;
		active.reason = reason || "cancelled";
		active.abort.abort();
		this.options.room.localPlaybackCancel(
			active.speechId,
			this.options.generation,
		);
	}

	private async run(
		text: string,
		pendingKey: string,
		requestDigest: string,
	): Promise<SpeakReceipt> {
		if (!text.trim()) {
			return {
				pendingKey,
				requestDigest,
				outcome: "rejected",
				reason: "empty_text",
				transport: "none",
				contentProof: "none",
			};
		}
		if (this.active) {
			return {
				pendingKey,
				requestDigest,
				outcome: "rejected",
				reason: "speech_busy",
				transport: "none",
				contentProof: "none",
			};
		}

		const active: ActiveSpeech = {
			speechId: this.options.nextSpeechId?.() ?? randomUUID(),
			abort: new AbortController(),
			submitted: false,
		};
		this.active = active;
		let started = false;
		try {
			await this.options.beforeSpeak();
			if (active.reason)
				return this.cancelledReceipt(active, pendingKey, requestDigest);
			const encoded = this.options.tts.synthesizeStream(
				text,
				this.options.voice,
				{ signal: active.abort.signal },
			);
			const source = this.options.decode
				? this.options.decode(encoded, { signal: active.abort.signal })
				: encoded;
			let sequence = 0;
			for await (const chunk of source) {
				if (active.reason)
					return this.cancelledReceipt(active, pendingKey, requestDigest);
				if (
					chunk.audio.length === 0 ||
					chunk.audio.length % 2 !== 0 ||
					chunk.format.encoding !== "pcm16" ||
					chunk.format.sampleRateHz !== 24_000 ||
					chunk.format.channels !== 1
				) {
					throw new Error("announcer_pcm16_24khz_mono_required");
				}
				if (!started) {
					const receipt = this.options.room.startSpeech({
						speechId: active.speechId,
						generation: this.options.generation,
						format: chunk.format,
					});
					if (receipt.outcome === "rejected") throw new Error(receipt.reason);
					started = true;
				}
				const receipt = await this.options.room.writeSpeech({
					speechId: active.speechId,
					generation: this.options.generation,
					sequence: ++sequence,
					pcm: chunk.audio,
				});
				if (receipt.outcome === "rejected") throw new Error(receipt.reason);
				active.submitted = true;
				if (active.reason)
					return this.cancelledReceipt(active, pendingKey, requestDigest);
			}
			if (!started) throw new Error("announcer_produced_no_pcm");
			const ended = await this.options.room.endSpeech(
				active.speechId,
				this.options.generation,
			);
			if (active.reason)
				return this.cancelledReceipt(active, pendingKey, requestDigest);
			if (ended.outcome === "rejected") throw new Error(ended.reason);
			return {
				pendingKey,
				requestDigest,
				outcome: "completed",
				transport: "submitted",
				contentProof: "deterministic_tts",
			};
		} catch (error) {
			if (started && !active.reason) {
				this.options.room.localPlaybackCancel(
					active.speechId,
					this.options.generation,
				);
			}
			return {
				pendingKey,
				requestDigest,
				outcome: "failed",
				reason: active.reason ?? errorReason(error),
				transport: active.submitted ? "submitted" : "none",
				contentProof: "none",
			};
		} finally {
			if (this.active === active) this.active = undefined;
		}
	}

	private cancelledReceipt(
		active: ActiveSpeech,
		pendingKey: string,
		requestDigest: string,
	): SpeakReceipt {
		return {
			pendingKey,
			requestDigest,
			outcome: "failed",
			reason: active.reason ?? "cancelled",
			transport: active.submitted ? "submitted" : "none",
			contentProof: "none",
		};
	}
}
