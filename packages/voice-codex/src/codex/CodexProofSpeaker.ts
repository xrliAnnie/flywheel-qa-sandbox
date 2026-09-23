import { createHash } from "node:crypto";
import type {
	AudioFormat,
	SpeakReceipt,
	VoiceSpeakKind,
	VoiceSpeakOptions,
	VoiceSpeakVerification,
} from "flywheel-voice-core";
import { isFiniteSpeechEquivalent, prepareReplySpeech } from "../speech.js";

const DEFAULT_CONFIRM_TIMEOUT_MS = 30_000;

export interface CodexSpeechTransport {
	appendSpeech(text: string, generation: number): Promise<void>;
}

interface ChunkResult {
	ok: boolean;
	transport: "none" | "submitted";
	contentProof: "none" | "transcript_equivalent";
	reason?: string;
}

interface PendingChunk {
	expected: string;
	verification: VoiceSpeakVerification;
	itemId?: string;
	finalSeen: boolean;
	playbackSubmitted: boolean;
	contentProof: "none" | "transcript_equivalent";
	failure?: string;
	timer?: ReturnType<typeof setTimeout>;
	settle(result: ChunkResult): void;
	settled: boolean;
}

function defaultVerification(kind: VoiceSpeakKind): VoiceSpeakVerification {
	switch (kind) {
		case "readback":
		case "question":
		case "cue":
			return "required";
		case "brief":
			return "best_effort";
		case "heartbeat":
		case "control":
			return "none";
	}
}

function canonical(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("speech_digest_invalid");
		return value;
	}
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const item = (value as Record<string, unknown>)[key];
			if (item !== undefined) result[key] = canonical(item);
		}
		return result;
	}
	throw new Error("speech_digest_invalid");
}

function digest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}

export class CodexProofSpeaker {
	private readonly requests = new Map<
		string,
		{ requestDigest: string; promise: Promise<SpeakReceipt> }
	>();
	private readonly usedItems = new Set<string>();
	private pending?: PendingChunk;

	constructor(
		private readonly options: {
			sessionId: string;
			sessionGeneration: number;
			voice: string;
			format: AudioFormat;
			transport: CodexSpeechTransport;
			isLive(): boolean;
			confirmTimeoutMs?: number;
		},
	) {}

	speak(
		text: string,
		kind: VoiceSpeakKind,
		options: VoiceSpeakOptions,
	): Promise<SpeakReceipt> {
		const verification = options.verification ?? defaultVerification(kind);
		let requestDigest: string;
		try {
			requestDigest = digest({
				version: 1,
				sessionId: this.options.sessionId,
				sessionGeneration: this.options.sessionGeneration,
				pendingKey: options.pendingKey,
				text,
				kind,
				verification,
				voice: this.options.voice,
				format: this.options.format,
				chunkCharacters: options.chunkCharacters ?? 80,
				authorityBinding: options.authorityBinding ?? null,
			});
		} catch {
			return Promise.resolve({
				pendingKey: options.pendingKey,
				requestDigest: "0".repeat(64),
				outcome: "rejected",
				reason: "request_invalid",
				transport: "none",
				contentProof: "none",
			});
		}
		const prior = this.requests.get(options.pendingKey);
		if (prior) {
			if (prior.requestDigest === requestDigest) return prior.promise;
			return Promise.resolve({
				pendingKey: options.pendingKey,
				requestDigest,
				outcome: "rejected",
				reason: "pending_key_conflict",
				transport: "none",
				contentProof: "none",
			});
		}
		const promise = this.run({
			text,
			kind,
			verification,
			pendingKey: options.pendingKey,
			requestDigest,
			chunkCharacters: options.chunkCharacters,
		});
		this.requests.set(options.pendingKey, { requestDigest, promise });
		return promise;
	}

	observeAssistantItem(input: { generation: number; itemId: string }): void {
		const pending = this.current(input.generation);
		if (!pending || !input.itemId) return;
		if (pending.itemId) {
			if (pending.itemId !== input.itemId) return;
			this.fail(pending, "speech_duplicate_item");
			return;
		}
		if (this.usedItems.has(input.itemId)) {
			this.fail(pending, "speech_item_reused");
			return;
		}
		pending.itemId = input.itemId;
		this.usedItems.add(input.itemId);
	}

	observeTranscript(input: {
		generation: number;
		itemId?: string;
		role: "user" | "assistant";
		text: string;
		final: boolean;
	}): void {
		const pending = this.current(input.generation);
		if (
			!pending ||
			!input.final ||
			input.role !== "assistant" ||
			!input.itemId ||
			input.itemId !== pending.itemId
		)
			return;
		if (pending.finalSeen) {
			this.fail(pending, "speech_duplicate_final");
			return;
		}
		pending.finalSeen = true;
		if (isFiniteSpeechEquivalent(pending.expected, input.text)) {
			pending.contentProof = "transcript_equivalent";
			this.evaluate(pending);
		} else if (pending.verification !== "required") {
			this.evaluate(pending);
		} else {
			this.fail(pending, "speech_not_equivalent");
		}
	}

	observePlaybackSubmitted(input: {
		generation: number;
		itemId: string;
	}): void {
		const pending = this.current(input.generation);
		if (!pending || !pending.itemId || input.itemId !== pending.itemId) return;
		pending.playbackSubmitted = true;
		this.evaluate(pending);
	}

	private async run(input: {
		text: string;
		kind: VoiceSpeakKind;
		verification: VoiceSpeakVerification;
		pendingKey: string;
		requestDigest: string;
		chunkCharacters?: number;
	}): Promise<SpeakReceipt> {
		const binding = {
			pendingKey: input.pendingKey,
			requestDigest: input.requestDigest,
		};
		if (!this.options.isLive()) {
			return {
				...binding,
				outcome: "rejected",
				reason: "not_live",
				transport: "none",
				contentProof: "none",
			};
		}
		if (this.pending) {
			return {
				...binding,
				outcome: "rejected",
				reason: "busy",
				transport: "none",
				contentProof: "none",
			};
		}
		const chunks = prepareReplySpeech(input.text, input.chunkCharacters ?? 80);
		if (chunks.length === 0) {
			return {
				...binding,
				outcome: "rejected",
				reason: "empty_text",
				transport: "none",
				contentProof: "none",
			};
		}

		let allProof = true;
		let anySubmitted = false;
		for (const [index, chunk] of chunks.entries()) {
			const result = await this.runChunk(chunk.spokenText, input.verification);
			anySubmitted ||= result.transport === "submitted";
			allProof &&= result.contentProof === "transcript_equivalent";
			if (!result.ok) {
				return {
					...binding,
					outcome: "failed",
					reason: result.reason ?? "speech_failed",
					transport: anySubmitted ? "submitted" : "none",
					contentProof:
						allProof && index === chunks.length - 1
							? "transcript_equivalent"
							: "none",
				};
			}
		}

		if (input.verification === "required" && !allProof) {
			return {
				...binding,
				outcome: "failed",
				reason: "speech_proof_missing",
				transport: anySubmitted ? "submitted" : "none",
				contentProof: "none",
			};
		}
		return {
			...binding,
			outcome: "completed",
			transport: "submitted",
			contentProof: allProof ? "transcript_equivalent" : "none",
		};
	}

	private runChunk(
		expected: string,
		verification: VoiceSpeakVerification,
	): Promise<ChunkResult> {
		return new Promise<ChunkResult>((resolve) => {
			const pending: PendingChunk = {
				expected,
				verification,
				finalSeen: false,
				playbackSubmitted: false,
				contentProof: "none",
				settle: resolve,
				settled: false,
			};
			pending.timer = setTimeout(() => {
				this.settle(pending, {
					ok: verification !== "required" && pending.playbackSubmitted,
					transport: pending.playbackSubmitted ? "submitted" : "none",
					contentProof: pending.contentProof,
					...(verification === "required" || !pending.playbackSubmitted
						? { reason: "speech_proof_timeout" }
						: {}),
				});
			}, this.options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS);
			pending.timer.unref?.();
			this.pending = pending;
			void this.options.transport
				.appendSpeech(expected, this.options.sessionGeneration)
				.then(() => this.evaluate(pending))
				.catch(() =>
					this.settle(pending, {
						ok: false,
						transport: "none",
						contentProof: "none",
						reason: "speech_transport_failed",
					}),
				);
		});
	}

	private current(generation: number): PendingChunk | undefined {
		return generation === this.options.sessionGeneration
			? this.pending
			: undefined;
	}

	private fail(pending: PendingChunk, reason: string): void {
		if (pending.settled) return;
		pending.failure ??= reason;
		queueMicrotask(() => this.evaluate(pending));
	}

	private evaluate(pending: PendingChunk): void {
		if (pending.settled || this.pending !== pending) return;
		if (pending.failure) {
			this.settle(pending, {
				ok: false,
				transport: pending.playbackSubmitted ? "submitted" : "none",
				contentProof: pending.contentProof,
				reason: pending.failure,
			});
			return;
		}
		if (!pending.playbackSubmitted) return;
		if (pending.verification === "required" && pending.contentProof === "none")
			return;
		if (pending.verification === "best_effort" && !pending.finalSeen) return;
		this.settle(pending, {
			ok: true,
			transport: "submitted",
			contentProof: pending.contentProof,
		});
	}

	private settle(pending: PendingChunk, result: ChunkResult): void {
		if (pending.settled) return;
		pending.settled = true;
		if (pending.timer) clearTimeout(pending.timer);
		if (this.pending === pending) this.pending = undefined;
		pending.settle(result);
	}
}
