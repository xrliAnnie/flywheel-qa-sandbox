import { createHash } from "node:crypto";
import type {
	AudioFormat,
	SpeakReceipt,
	VoiceSpeakKind,
	VoiceSpeakOptions,
	VoiceSpeakVerification,
} from "flywheel-voice-core";
import { isFiniteSpeechEquivalent, prepareReplySpeech } from "../speech.js";
import { speechAlignment, unalignedText } from "./SpeechOverrun.js";

/** No turn.created/turn.done within this long: binding is unknown (T5b ⑥). */
const DEFAULT_CONFIRM_TIMEOUT_MS = 30_000;
/** Idle admission waits this long before giving up (T5b ①). */
const DEFAULT_ADMISSION_TIMEOUT_MS = 10_000;
const DEFAULT_ADMISSION_POLL_MS = 50;
/** A done with nothing played is re-checked this much later (T5c ④). */
const DEFAULT_SILENCE_CONFIRM_MS = 600;
/**
 * T5c ①: the data-channel turn.done comes before the app-server final
 * (probe-run2: ~12 ms). The final is the overrun input, so a done waits this
 * long for it before settling on the done transcript alone.
 */
const DEFAULT_FINAL_WAIT_MS = 2_000;
/** How long after an overrun the stop latency is measured. */
const OVERRUN_STOP_WINDOW_MS = 500;
/** A truncation marker waits this long for its late final (T5c ③). */
const TRUNCATION_MARKER_MS = 30_000;
export const SPEECH_TRUNCATED_NOTE = "（已截断越界内容）";

export interface CodexSpeechTransport {
	appendSpeech(text: string, generation: number): Promise<void>;
}

/** What the speaker needs from the session; all of it is current-generation. */
export interface CodexSpeakerHost {
	sessionId: string;
	voice: string;
	format: AudioFormat;
	sessionGeneration(): number;
	transport(): CodexSpeechTransport;
	isLive(): boolean;
	/** Monotonic milliseconds. */
	now(): number;
	/**
	 * Plan T5b ①–⑤: why the room is not idle enough to read aloud (an open
	 * assistant turn, audible audio, the founder speaking or an unanswered user
	 * turn, a barge-in in progress, an overrun discard), or undefined.
	 */
	busyReason(): string | undefined;
	/** Real voiced packets the player has taken so far (monotonic counter). */
	consumedVoiced(): number;
	/** Voiced packets still queued for the player. */
	queuedVoiced(): number;
	/** Client-side cuts, silence substitutions, drops and trims so far. */
	interference(): number;
	/** Backlog trims so far. */
	trims(): number;
	/**
	 * T5c: mute the overrunning turn (session-level discard state). The turn id
	 * is known when the chunk was already bound, else its turn.created follows.
	 */
	overrun(turnId: string | undefined): void;
	evidence(record: Record<string, unknown>): void;
	confirmTimeoutMs?: number;
	admissionTimeoutMs?: number;
	admissionPollMs?: number;
	silenceConfirmMs?: number;
	finalWaitMs?: number;
}

interface ChunkResult {
	ok: boolean;
	transport: "none" | "submitted";
	contentProof: "none" | "transcript_equivalent";
	reason?: string;
	/** Admission never succeeded: nothing was sent for this chunk. */
	notSent?: boolean;
	/** Confirmed silent: may be retried once (T5c ④). */
	silent?: boolean;
}

interface PendingChunk {
	pendingKey: string;
	generation: number;
	expected: string;
	verification: VoiceSpeakVerification;
	sent: boolean;
	sentAt: number;
	consumedAtSend: number;
	interferenceAtSend: number;
	trimsAtSend: number;
	boundTurnId?: string;
	done: boolean;
	doneTranscript?: string;
	finalText?: string;
	/** The wait for the app-server final after done has run out. */
	finalWaited: boolean;
	finalWaitArmed?: boolean;
	accumulated: string;
	silenceCheck?: boolean;
	timers: Array<ReturnType<typeof setTimeout>>;
	settled: boolean;
	settle(result: ChunkResult): void;
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

/**
 * Proof-bound read-aloud on Codex realtime v3 (FLY-2885 T5b/T5c).
 *
 * v3 has no assistant item ids and appendSpeech only queues the text, so a
 * chunk is sent only when the room is idle, and is then bound to the first
 * assistant turn the data channel reports after it. Playback proof is what the
 * player actually consumed. A chunk whose transcript runs past its line is
 * cut, its tail muted and its mirror truncated; a confirmed-silent chunk is
 * retried once; anything that cannot be bound is reported honestly and never
 * retried (it may already have been heard).
 */
export class CodexProofSpeaker {
	private readonly requests = new Map<
		string,
		{ requestDigest: string; promise: Promise<SpeakReceipt> }
	>();
	private readonly ended = new Set<string>();
	private pending?: PendingChunk;
	private truncation?: { expected: string; until: number };
	/**
	 * T5c ③: a sent chunk that settled before its app-server final. That
	 * final is still checked when it lands (up to 30 s), and no other chunk is
	 * sent meanwhile, so it can never be taken for the next chunk's final. Any
	 * new user or assistant turn ends the watch: finals carry no turn id, so
	 * after that the next final may be the new turn's own.
	 */
	private finalWatch?: {
		expected: string;
		turnId?: string;
		pendingKey: string;
		sentAt: number;
		until: number;
	};

	constructor(private readonly host: CodexSpeakerHost) {}

	speak(
		text: string,
		kind: VoiceSpeakKind,
		options: VoiceSpeakOptions,
	): Promise<SpeakReceipt> {
		const verification = options.verification ?? defaultVerification(kind);
		const sessionGeneration = this.host.sessionGeneration();
		let requestDigest: string;
		try {
			requestDigest = digest({
				version: 1,
				sessionId: this.host.sessionId,
				sessionGeneration,
				pendingKey: options.pendingKey,
				text,
				kind,
				verification,
				voice: this.host.voice,
				format: this.host.format,
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
			verification,
			pendingKey: options.pendingKey,
			requestDigest,
			sessionGeneration,
			chunkCharacters: options.chunkCharacters,
		});
		this.requests.set(options.pendingKey, { requestDigest, promise });
		return promise;
	}

	/** Data channel turn.created of the current generation. */
	turnCreated(input: { turnId: string; role: "user" | "assistant" }): void {
		// Finals carry no turn id: once another turn starts, the next final
		// may be its own, so a late chunk's final is no longer attributable.
		if (this.finalWatch && input.turnId !== this.finalWatch.turnId)
			this.finalWatch = undefined;
		if (input.role === "user") {
			this.userEvidence();
			return;
		}
		const pending = this.pending;
		if (!pending?.sent || pending.boundTurnId || this.ended.has(input.turnId))
			return;
		pending.boundTurnId = input.turnId;
	}

	/** Data channel turn.done of the current generation. */
	turnDone(input: {
		turnId: string;
		role: "user" | "assistant";
		transcript: string | null;
	}): void {
		if (input.role !== "assistant") return;
		this.ended.add(input.turnId);
		const pending = this.pending;
		if (!pending || pending.boundTurnId !== input.turnId || pending.done)
			return;
		pending.done = true;
		if (input.transcript !== null) pending.doneTranscript = input.transcript;
		this.evaluate(pending);
	}

	/** New user speech (turn.created{user} or a user transcript delta). */
	userEvidence(): void {
		this.finalWatch = undefined;
		const pending = this.pending;
		if (!pending?.sent || pending.boundTurnId) return;
		this.fail(pending, "speech_preempted");
	}

	/**
	 * app-server assistant transcript (the only overrun input, T5c ①). Every
	 * delta after the chunk was sent belongs to it; the final is checked again
	 * before anything is persisted or mirrored.
	 */
	assistantTranscript(input: { text: string; final: boolean }): void {
		const pending = this.pending;
		if (!pending?.sent || pending.settled) {
			if (input.final) this.checkLateFinal(input.text);
			return;
		}
		if (input.final) pending.finalText = input.text;
		else pending.accumulated += input.text;
		const observed = input.final ? input.text : pending.accumulated;
		const alignment = speechAlignment(pending.expected, observed);
		if (alignment.overrun) {
			this.overrun(pending, observed, alignment);
			return;
		}
		// A done that was waiting for this final can settle now.
		if (input.final) this.evaluate(pending);
	}

	/** The player took more audio; a done waiting for playback re-evaluates. */
	playbackProgress(): void {
		const pending = this.pending;
		if (pending?.done && !pending.settled) this.evaluate(pending);
	}

	interrupt(reason = "speech_interrupted"): void {
		// A new generation or a closed session never sees the old turn's final.
		if (reason === "generation_changed" || reason === "session_closed")
			this.finalWatch = undefined;
		const pending = this.pending;
		if (!pending || pending.settled) return;
		this.settle(pending, {
			ok: false,
			transport: this.consumedSince(pending) > 0 ? "submitted" : "none",
			contentProof: "none",
			reason,
			...(pending.sent ? {} : { notSent: true }),
		});
	}

	/**
	 * T5c ③: an assistant final that belongs to an overrun chunk is persisted
	 * and mirrored only up to the line it was asked to read.
	 */
	truncateAssistantFinal(text: string): string {
		const marker = this.truncation;
		if (!marker) return text;
		this.truncation = undefined;
		if (this.host.now() > marker.until) return text;
		return `${marker.expected}${SPEECH_TRUNCATED_NOTE}`;
	}

	private async run(input: {
		text: string;
		verification: VoiceSpeakVerification;
		pendingKey: string;
		requestDigest: string;
		sessionGeneration: number;
		chunkCharacters?: number;
	}): Promise<SpeakReceipt> {
		const binding = {
			pendingKey: input.pendingKey,
			requestDigest: input.requestDigest,
		};
		if (
			!this.host.isLive() ||
			input.sessionGeneration !== this.host.sessionGeneration()
		) {
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
			let result = await this.runChunk(
				input.pendingKey,
				chunk.spokenText,
				input.verification,
				input.sessionGeneration,
			);
			if (result.silent) {
				this.host.evidence({
					kind: "codex_speech_silent_retry",
					pendingKey: input.pendingKey,
					chunk: index,
				});
				result = await this.runChunk(
					input.pendingKey,
					chunk.spokenText,
					input.verification,
					input.sessionGeneration,
				);
			}
			anySubmitted ||= result.transport === "submitted";
			allProof &&= result.contentProof === "transcript_equivalent";
			if (!result.ok) {
				if (result.notSent && !anySubmitted && index === 0) {
					return {
						...binding,
						outcome: "rejected",
						reason: result.reason ?? "busy_conversation",
						transport: "none",
						contentProof: "none",
					};
				}
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
		pendingKey: string,
		expected: string,
		verification: VoiceSpeakVerification,
		generation: number,
	): Promise<ChunkResult> {
		return new Promise<ChunkResult>((resolve) => {
			const pending: PendingChunk = {
				pendingKey,
				generation,
				expected,
				verification,
				sent: false,
				sentAt: 0,
				consumedAtSend: 0,
				interferenceAtSend: 0,
				trimsAtSend: 0,
				done: false,
				finalWaited: false,
				accumulated: "",
				timers: [],
				settled: false,
				settle: resolve,
			};
			this.pending = pending;
			this.admit(pending, this.host.now());
		});
	}

	/** T5b ①: send only into an idle room; give up after 10 s. */
	private admit(pending: PendingChunk, startedAt: number): void {
		if (pending.settled) return;
		if (
			!this.host.isLive() ||
			pending.generation !== this.host.sessionGeneration()
		) {
			this.settle(pending, {
				ok: false,
				transport: "none",
				contentProof: "none",
				reason: "generation_changed",
				notSent: true,
			});
			return;
		}
		const busy = this.host.busyReason() ?? this.awaitingFinal();
		if (busy === undefined) {
			this.send(pending);
			return;
		}
		if (
			this.host.now() - startedAt >=
			(this.host.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS)
		) {
			this.host.evidence({
				kind: "codex_speech_admission_timeout",
				pendingKey: pending.pendingKey,
				busy,
			});
			this.settle(pending, {
				ok: false,
				transport: "none",
				contentProof: "none",
				reason: "busy_conversation",
				notSent: true,
			});
			return;
		}
		const timer = setTimeout(
			() => this.admit(pending, startedAt),
			this.host.admissionPollMs ?? DEFAULT_ADMISSION_POLL_MS,
		);
		timer.unref?.();
		pending.timers.push(timer);
	}

	private send(pending: PendingChunk): void {
		pending.sent = true;
		pending.sentAt = this.host.now();
		pending.consumedAtSend = this.host.consumedVoiced();
		pending.interferenceAtSend = this.host.interference();
		pending.trimsAtSend = this.host.trims();
		const timer = setTimeout(() => {
			if (pending.settled) return;
			this.settle(pending, {
				ok: false,
				transport: this.consumedSince(pending) > 0 ? "submitted" : "none",
				contentProof: "none",
				reason: "speech_binding_unavailable",
			});
		}, this.host.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS);
		timer.unref?.();
		pending.timers.push(timer);
		void this.host
			.transport()
			.appendSpeech(pending.expected, pending.generation)
			.catch(() =>
				this.settle(pending, {
					ok: false,
					transport: "none",
					contentProof: "none",
					reason: "speech_transport_failed",
				}),
			);
	}

	private evaluate(pending: PendingChunk): void {
		if (pending.settled || !pending.done) return;
		if (pending.finalText === undefined && !pending.finalWaited) {
			this.awaitFinal(pending);
			return;
		}
		if (this.host.trims() !== pending.trimsAtSend) {
			this.settle(pending, {
				ok: false,
				transport: "submitted",
				contentProof: "none",
				reason: "playback_trimmed",
			});
			return;
		}
		const consumed = this.consumedSince(pending);
		if (consumed === 0) {
			// Done can arrive before its audio is played: wait for the queue.
			if (this.host.queuedVoiced() > 0) return;
			this.checkSilent(pending);
			return;
		}
		const transcript = pending.doneTranscript ?? pending.finalText;
		const equivalent =
			transcript !== undefined &&
			isFiniteSpeechEquivalent(pending.expected, transcript);
		if (!equivalent && pending.verification === "required") {
			this.settle(pending, {
				ok: false,
				transport: "submitted",
				contentProof: "none",
				reason: "speech_not_equivalent",
			});
			return;
		}
		this.settle(pending, {
			ok: true,
			transport: "submitted",
			contentProof: equivalent ? "transcript_equivalent" : "none",
		});
	}

	/** An earlier chunk's final is still owed (T5c ③). */
	private awaitingFinal(): string | undefined {
		const watch = this.finalWatch;
		if (!watch) return undefined;
		if (this.host.now() <= watch.until) return "awaiting_final";
		this.finalWatch = undefined;
		return undefined;
	}

	/** The final of a chunk that settled first: check it like any other. */
	private checkLateFinal(text: string): void {
		const watch = this.finalWatch;
		if (!watch) return;
		this.finalWatch = undefined;
		const now = this.host.now();
		if (now > watch.until) return;
		const alignment = speechAlignment(watch.expected, text);
		if (!alignment.overrun) return;
		this.host.overrun(watch.turnId);
		this.truncation = {
			expected: watch.expected,
			until: now + TRUNCATION_MARKER_MS,
		};
		this.host.evidence({
			kind: "codex_speech_overrun",
			pendingKey: watch.pendingKey,
			turnId: watch.turnId ?? null,
			expectedChars: alignment.expectedChars,
			unalignedChars: alignment.unaligned,
			extraTextSha256: createHash("sha256")
				.update(unalignedText(watch.expected, text))
				.digest("hex"),
			detectedAtMs: Math.round(now - watch.sentAt),
			late: true,
		});
	}

	private awaitFinal(pending: PendingChunk): void {
		if (pending.finalWaitArmed) return;
		pending.finalWaitArmed = true;
		const timer = setTimeout(() => {
			pending.finalWaited = true;
			this.evaluate(pending);
		}, this.host.finalWaitMs ?? DEFAULT_FINAL_WAIT_MS);
		timer.unref?.();
		pending.timers.push(timer);
	}

	/**
	 * T5c ④: done, nothing played and nothing queued. Silent only if that is
	 * still true 600 ms later and the client never cut or substituted audio in
	 * the meantime; otherwise the outcome is unknown and is not retried.
	 */
	private checkSilent(pending: PendingChunk): void {
		if (pending.silenceCheck) return;
		pending.silenceCheck = true;
		const timer = setTimeout(() => {
			if (pending.settled) return;
			if (this.consumedSince(pending) > 0 || this.host.queuedVoiced() > 0) {
				this.evaluate(pending);
				return;
			}
			if (this.host.interference() !== pending.interferenceAtSend) {
				this.settle(pending, {
					ok: false,
					transport: "none",
					contentProof: "none",
					reason: "speech_binding_unavailable",
				});
				return;
			}
			this.settle(pending, {
				ok: false,
				transport: "none",
				contentProof: "none",
				reason: "speech_silent",
				silent: true,
			});
		}, this.host.silenceConfirmMs ?? DEFAULT_SILENCE_CONFIRM_MS);
		timer.unref?.();
		pending.timers.push(timer);
	}

	private overrun(
		pending: PendingChunk,
		observed: string,
		alignment: ReturnType<typeof speechAlignment>,
	): void {
		const detectedAt = this.host.now();
		const consumedAtDetection = this.host.consumedVoiced();
		this.host.overrun(pending.boundTurnId);
		this.truncation = {
			expected: pending.expected,
			until: detectedAt + TRUNCATION_MARKER_MS,
		};
		const extra = unalignedText(pending.expected, observed);
		const record = {
			kind: "codex_speech_overrun",
			pendingKey: pending.pendingKey,
			turnId: pending.boundTurnId ?? null,
			expectedChars: alignment.expectedChars,
			unalignedChars: alignment.unaligned,
			extraTextSha256: createHash("sha256").update(extra).digest("hex"),
			detectedAtMs: Math.round(detectedAt - pending.sentAt),
		};
		const timer = setTimeout(() => {
			// Real audio the player still took after the cut (its look-ahead).
			const lateVoiced = this.host.consumedVoiced() - consumedAtDetection;
			this.host.evidence({
				...record,
				stopLatencyMs: lateVoiced * 20,
			});
		}, OVERRUN_STOP_WINDOW_MS);
		timer.unref?.();
		this.settle(pending, {
			ok: false,
			transport: "submitted",
			contentProof: "none",
			reason: "speech_overrun",
		});
	}

	private consumedSince(pending: PendingChunk): number {
		return pending.sent
			? this.host.consumedVoiced() - pending.consumedAtSend
			: 0;
	}

	private fail(pending: PendingChunk, reason: string): void {
		this.settle(pending, {
			ok: false,
			transport: this.consumedSince(pending) > 0 ? "submitted" : "none",
			contentProof: "none",
			reason,
		});
	}

	private settle(pending: PendingChunk, result: ChunkResult): void {
		if (pending.settled) return;
		pending.settled = true;
		for (const timer of pending.timers) clearTimeout(timer);
		pending.timers.length = 0;
		if (pending.boundTurnId) this.ended.add(pending.boundTurnId);
		if (this.pending === pending) this.pending = undefined;
		// Settled before its app-server final: keep that final on the check.
		// An overrun already truncates; a silent chunk's retry reads the same
		// line; a new generation or close never delivers the old final.
		if (
			pending.sent &&
			pending.finalText === undefined &&
			!result.silent &&
			result.reason !== "speech_overrun" &&
			result.reason !== "generation_changed" &&
			result.reason !== "session_closed"
		)
			this.finalWatch = {
				expected: pending.expected,
				turnId: pending.boundTurnId,
				pendingKey: pending.pendingKey,
				sentAt: pending.sentAt,
				until: this.host.now() + TRUNCATION_MARKER_MS,
			};
		pending.settle(result);
	}
}
