import { createHash } from "node:crypto";
import type {
	AudioFormat,
	SpeakReceipt,
	VoiceSpeakKind,
	VoiceSpeakOptions,
	VoiceSpeakVerification,
} from "flywheel-voice-core";
import { isFiniteSpeechEquivalent, prepareReplySpeech } from "../speech.js";
import {
	opensWith,
	type SpokenPrefix,
	speechAlignment,
	spokenPrefix,
	unalignedText,
} from "./SpeechOverrun.js";

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
/**
 * FLY-2885 founder rework B: a Lead reply waits for the conversation instead
 * of for a fixed count. It gives up once the room has been quiet this long
 * (nobody speaking, nothing audible) and still cannot be read into — the
 * busy state is then stuck, not a conversation…
 */
const DEFAULT_READBACK_QUIET_MS = 8_000;
/** …or once it has waited this long in all. */
const DEFAULT_READBACK_CEILING_MS = 120_000;
/** Heard, only not proven: a Lead reply moves on to its next chunk. */
const HEARD_BUT_UNPROVEN = new Set([
	"speech_not_equivalent",
	"playback_trimmed",
	"speech_binding_unavailable",
]);

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
	 * Founder rework B: someone is speaking or the model's audio is still
	 * flowing (audible, muted by a barge-in, or under overrun discard). While
	 * this holds, a waiting Lead reply keeps waiting.
	 */
	roomActive?(): boolean;
	/**
	 * The generation is being replaced (T7) and the session is not closing: a
	 * waiting Lead reply waits for the new one instead of giving up.
	 */
	recovering?(): boolean;
	/**
	 * QA@2: a Lead-reply chunk that was sent on `generation` (so it sits in the
	 * model's context as speakable text) was cut by her barge-in or preempt.
	 * The model must be told not to finish it in its next answer.
	 */
	abandoned?(text: string, generation: number): void;
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
	readbackQuietMs?: number;
	readbackCeilingMs?: number;
}

export interface ReadReplyLimits {
	ceilingMs?: number;
	/**
	 * QA@2: tell the model not to finish a chunk she cuts into. Only the Lead's
	 * own text; the remainder notice is not steered.
	 */
	noteOnAbandon?: boolean;
}

/** A Lead reply read aloud: its receipt, and what of it was never read. */
export interface ReadReplyResult {
	receipt: SpeakReceipt;
	/** Chunks (or the rest of one) that were never read; 0 when complete. */
	unreadChunks: number;
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
	/** Overrun of a Lead-reply chunk: which of its sentences were read. */
	prefix?: SpokenPrefix;
	/** The generation the chunk was sent on. */
	generation?: number;
}

interface OwedFinal {
	expected: string;
	turnId?: string;
	pendingKey: string;
	sentAt: number;
	until: number;
	/**
	 * Cut by an overrun before its final came (review R1, founder rework): the
	 * final is still this chunk's, so it fences the next chunk and takes the
	 * truncation marker, but is not checked again.
	 */
	overran?: boolean;
	/**
	 * Everything the overrun chunk's deltas showed up to the cut, the invented
	 * part included. Its own final opens with it; a final that does not is a
	 * later turn's, so the claim is dropped and that final left alone (review
	 * R2/R3).
	 */
	heard?: string;
}

interface PendingChunk {
	pendingKey: string;
	generation: number;
	expected: string;
	/** A Lead-reply chunk: an overrun resumes after its last read sentence. */
	readback: boolean;
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
 *
 * A Lead reply (`readback`, founder rework 2026-09-26) is read to the end: it
 * waits for the conversation to pause, and an overrun resumes from the first
 * sentence not yet read (readReply).
 */
export class CodexProofSpeaker {
	private readonly requests = new Map<
		string,
		{
			requestDigest: string;
			receipt: Promise<SpeakReceipt>;
			result: Promise<ReadReplyResult>;
		}
	>();
	/** A Lead reply is being read (between chunks it holds no pending chunk). */
	private replyActive = false;
	/**
	 * An overrun cut a Lead-reply chunk and its unread rest is not sent yet:
	 * that rest is still speakable context on `generation`.
	 */
	private overrunCut?: { text: string; generation: number; note: boolean };
	/** Why the waiting reply must stop (her barge-in in an overrun gap). */
	private replyStop?: string;
	private readonly ended = new Set<string>();
	private pending?: PendingChunk;
	/** Bound to the chunk whose final it truncates (none: this very final). */
	private truncation?: { expected: string; until: number; owner?: OwedFinal };
	/** The owed chunk the final being handled now belongs to. */
	private finalOwner?: OwedFinal;
	/**
	 * T5c ③: sent chunks that settled before their app-server final, oldest
	 * first. v3 finals carry no turn id but arrive in turn order, so the next
	 * final belongs to the oldest owed chunk and is checked against that
	 * chunk's own line (for up to 30 s). No chunk with a different line is sent
	 * while one is owed. A new user turn, or another assistant turn, makes the
	 * next final possibly that turn's own, so it ends the attribution.
	 */
	private owed: OwedFinal[] = [];

	constructor(private readonly host: CodexSpeakerHost) {}

	speak(
		text: string,
		kind: VoiceSpeakKind,
		options: VoiceSpeakOptions,
	): Promise<SpeakReceipt> {
		return this.request(text, kind, options).receipt;
	}

	/**
	 * FLY-2885 founder rework: a Lead reply, read to the end. It waits for the
	 * conversation to pause (a time limit, not a count), resumes after an
	 * overrun from the first unread sentence, and says how much was left unread
	 * when it truly could not go on.
	 */
	readReply(
		text: string,
		options: VoiceSpeakOptions,
		limits: ReadReplyLimits = {},
	): Promise<ReadReplyResult> {
		return this.request(text, "readback", options, limits).result;
	}

	private request(
		text: string,
		kind: VoiceSpeakKind,
		options: VoiceSpeakOptions,
		limits: ReadReplyLimits = {},
	): { receipt: Promise<SpeakReceipt>; result: Promise<ReadReplyResult> } {
		const settled = (receipt: SpeakReceipt) => ({
			receipt: Promise.resolve(receipt),
			result: Promise.resolve({ receipt, unreadChunks: 0 }),
		});
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
			return settled({
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
			if (prior.requestDigest === requestDigest) return prior;
			return settled({
				pendingKey: options.pendingKey,
				requestDigest,
				outcome: "rejected",
				reason: "pending_key_conflict",
				transport: "none",
				contentProof: "none",
			});
		}
		const result = this.run({
			text,
			kind,
			verification,
			pendingKey: options.pendingKey,
			requestDigest,
			sessionGeneration,
			chunkCharacters: options.chunkCharacters,
			ceilingMs: limits.ceilingMs,
			noteOnAbandon: limits.noteOnAbandon ?? true,
		});
		const entry = {
			requestDigest,
			result,
			receipt: result.then((value) => value.receipt),
		};
		this.requests.set(options.pendingKey, entry);
		return entry;
	}

	/** Data channel turn.created of the current generation. */
	turnCreated(input: { turnId: string; role: "user" | "assistant" }): void {
		if (input.role === "user") {
			this.userEvidence();
			return;
		}
		const pending = this.pending;
		const pendingBinds =
			pending?.sent &&
			!pending.settled &&
			!pending.boundTurnId &&
			!this.ended.has(input.turnId);
		// An owed chunk that settled before its turn.created (audio can come
		// first) adopts that turn when no live chunk is waiting for one.
		const adopter =
			pendingBinds || this.ended.has(input.turnId)
				? undefined
				: this.owed.find((owed) => owed.turnId === undefined);
		if (adopter) adopter.turnId = input.turnId;
		// Another turn: its final may come next, so older owed finals are no
		// longer attributable. A retry of the same line keeps them: whichever
		// attempt a final belongs to, it is checked against that line. An
		// overrun chunk's turn came first, so its final still comes first (and
		// must open with what it showed, see assistantTranscript).
		this.keepOwed(
			(owed) =>
				owed.overran === true ||
				owed.turnId === input.turnId ||
				(pendingBinds === true && owed.expected === pending?.expected),
		);
		if (pendingBinds) pending.boundTurnId = input.turnId;
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
		const pending = this.pending;
		if (pending?.sent && !pending.boundTurnId)
			this.fail(pending, "speech_preempted");
		// The founder spoke: the next final may be her answer's own — unless an
		// overrun chunk still owes one, whose turn (and final) came before hers;
		// that claim holds only for a final opening with what it showed (R2/R3).
		this.keepOwed((owed) => owed.overran === true);
	}

	/**
	 * app-server assistant transcript (the only overrun input, T5c ①). Every
	 * delta after the chunk was sent belongs to it; the final is checked again
	 * before anything is persisted or mirrored.
	 */
	assistantTranscript(input: { text: string; final: boolean }): void {
		this.expireOwed();
		if (input.final) this.finalOwner = undefined;
		// Review R2/R3: an overrun chunk whose final was lost must not take a
		// later turn's (her answer's). Its final opens with what its deltas
		// showed; one that does not is someone else's: the claim is given up,
		// and that final stays unowned (nothing is sent while the claim stands).
		const head = this.owed[0];
		if (
			input.final &&
			head?.overran &&
			!opensWith(head.heard ?? "", input.text)
		) {
			this.keepOwed((entry) => entry !== head);
			return;
		}
		const owed = this.owed[0];
		if (owed) {
			// Finals arrive in turn order: this one is the oldest owed chunk's.
			if (input.final) {
				this.owed.shift();
				this.finalOwner = owed;
				// An overrun chunk was already cut; its final only takes the marker.
				if (!owed.overran) this.checkLateFinal(owed, input.text);
			}
			return;
		}
		const pending = this.pending;
		if (!pending?.sent || pending.settled) return;
		if (input.final) pending.finalText = input.text;
		else pending.accumulated += input.text;
		const observed = input.final ? input.text : pending.accumulated;
		const alignment = speechAlignment(pending.expected, observed);
		if (alignment.overrun) {
			this.overrun(pending, observed, alignment, input.final);
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
		// A new generation or a closed session never sees the old turn's final,
		// and holds none of the old speakable text (review R2).
		if (reason === "generation_changed" || reason === "session_closed") {
			this.keepOwed(() => false);
			this.overrunCut = undefined;
		}
		// Review (QA@2 rework): she barged in after an overrun cut a Lead-reply
		// chunk and before its rest went out. The rest is still speakable
		// context: steer the model off it and stop the reply here.
		const cut = this.overrunCut;
		if (
			reason === "speech_interrupted" &&
			cut &&
			this.replyActive &&
			cut.generation === this.host.sessionGeneration()
		) {
			this.overrunCut = undefined;
			this.replyStop = reason;
			if (cut.note) this.host.abandoned?.(cut.text, cut.generation);
		}
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
		// A marker waiting for its own chunk's final never takes another's.
		if (marker.owner && marker.owner !== this.finalOwner) return text;
		this.truncation = undefined;
		if (this.host.now() > marker.until) return text;
		return `${marker.expected}${SPEECH_TRUNCATED_NOTE}`;
	}

	private async run(input: {
		text: string;
		kind: VoiceSpeakKind;
		verification: VoiceSpeakVerification;
		pendingKey: string;
		requestDigest: string;
		sessionGeneration: number;
		chunkCharacters?: number;
		ceilingMs?: number;
		noteOnAbandon: boolean;
	}): Promise<ReadReplyResult> {
		const binding = {
			pendingKey: input.pendingKey,
			requestDigest: input.requestDigest,
		};
		const rejected = (reason: string, unreadChunks = 0): ReadReplyResult => ({
			receipt: {
				...binding,
				outcome: "rejected",
				reason,
				transport: "none",
				contentProof: "none",
			},
			unreadChunks,
		});
		const live =
			this.host.isLive() &&
			input.sessionGeneration === this.host.sessionGeneration();
		const chunks = prepareReplySpeech(input.text, input.chunkCharacters ?? 80);
		if (input.kind !== "readback") {
			if (!live) return rejected("not_live");
			if (this.pending) return rejected("busy");
			if (chunks.length === 0) return rejected("empty_text");
			return {
				receipt: await this.speakChunks(input, binding, chunks),
				unreadChunks: 0,
			};
		}
		// A Lead reply waits out a reconnect and a cue in progress; only a
		// closed session or another reply turns it away, and then it is unread.
		if (!live && !this.host.recovering?.())
			return rejected("not_live", chunks.length);
		if (this.replyActive) return rejected("busy", chunks.length);
		if (chunks.length === 0) return rejected("empty_text");
		this.replyActive = true;
		try {
			return await this.readChunks(
				input,
				binding,
				chunks.map((chunk) => chunk.spokenText),
			);
		} finally {
			this.replyActive = false;
			this.overrunCut = undefined;
			this.replyStop = undefined;
		}
	}

	/** Every kind but a Lead reply: each chunk once, stop at the first failure. */
	private async speakChunks(
		input: {
			verification: VoiceSpeakVerification;
			pendingKey: string;
			sessionGeneration: number;
		},
		binding: { pendingKey: string; requestDigest: string },
		chunks: Array<{ spokenText: string }>,
	): Promise<SpeakReceipt> {
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

	/**
	 * Founder rework A–C: a Lead reply goes on until every sentence was read.
	 * Each chunk waits for a pause in the conversation. A chunk that was heard
	 * but not proven moves on, as the reply loop always did; an overrun resumes
	 * after its last read sentence. Whatever left a chunk unheard — no pause in
	 * time, her barge-in or preempt, silence, a new generation, a closed
	 * session — stops the reply, and the unread count goes back to the caller.
	 */
	private async readChunks(
		input: {
			verification: VoiceSpeakVerification;
			pendingKey: string;
			sessionGeneration: number;
			ceilingMs?: number;
			noteOnAbandon: boolean;
		},
		binding: { pendingKey: string; requestDigest: string },
		chunks: string[],
	): Promise<ReadReplyResult> {
		let allProof = true;
		let anySubmitted = false;
		let firstFailure: string | undefined;
		let stopReason: string | undefined;
		let index = 0;
		let text = chunks[0]!;
		/** An overrun that read none of its chunk earns one more try. */
		let stalled = false;
		const next = (): void => {
			index += 1;
			text = chunks[index] ?? "";
			stalled = false;
		};
		while (index < chunks.length) {
			let result = await this.readChunk(input, text);
			if (result.silent) {
				this.host.evidence({
					kind: "codex_speech_silent_retry",
					pendingKey: input.pendingKey,
					chunk: index,
				});
				result = await this.readChunk(input, text);
			}
			anySubmitted ||= result.transport === "submitted";
			if (result.ok) {
				allProof &&= result.contentProof === "transcript_equivalent";
				next();
				continue;
			}
			allProof = false;
			const reason = result.reason ?? "speech_failed";
			firstFailure ??= reason;
			// She cut in: what the model was given to read stays in its context,
			// and its next answer would finish it first (QA@2, probe 8).
			if (
				input.noteOnAbandon &&
				!result.notSent &&
				result.generation !== undefined &&
				(reason === "speech_interrupted" || reason === "speech_preempted")
			)
				this.host.abandoned?.(text, result.generation);
			if (reason === "speech_overrun" && result.prefix) {
				const { remainder, spokenSentences, totalSentences } = result.prefix;
				this.host.evidence({
					kind: "codex_readback_continue",
					pendingKey: input.pendingKey,
					chunk: index,
					spokenSentences,
					totalSentences,
				});
				// Until the rest is sent, the cut chunk's unread part is still
				// speakable context: a barge-in meanwhile stops the reply (review).
				if (remainder !== "" && result.generation !== undefined)
					this.overrunCut = {
						text,
						generation: result.generation,
						note: input.noteOnAbandon,
					};
				if (remainder === "") next();
				else if (spokenSentences > 0) {
					text = remainder;
					stalled = false;
				} else if (!stalled) stalled = true;
				else {
					stopReason = reason;
					break;
				}
				continue;
			}
			if (result.transport === "submitted" && HEARD_BUT_UNPROVEN.has(reason)) {
				next();
				continue;
			}
			if (result.notSent && !anySubmitted && index === 0)
				return {
					receipt: {
						...binding,
						outcome: "rejected",
						reason,
						transport: "none",
						contentProof: "none",
					},
					unreadChunks: chunks.length,
				};
			stopReason = reason;
			break;
		}
		if (index < chunks.length)
			return {
				receipt: {
					...binding,
					outcome: "failed",
					reason: stopReason ?? firstFailure ?? "speech_failed",
					transport: anySubmitted ? "submitted" : "none",
					contentProof: "none",
				},
				unreadChunks: chunks.length - index,
			};
		if (input.verification === "required" && !allProof)
			return {
				receipt: {
					...binding,
					outcome: "failed",
					reason: firstFailure ?? "speech_proof_missing",
					transport: anySubmitted ? "submitted" : "none",
					contentProof: "none",
				},
				unreadChunks: 0,
			};
		return {
			receipt: {
				...binding,
				outcome: "completed",
				transport: "submitted",
				contentProof: allProof ? "transcript_equivalent" : "none",
			},
			unreadChunks: 0,
		};
	}

	/** One Lead-reply chunk, sent once the conversation pauses. */
	private async readChunk(
		input: {
			verification: VoiceSpeakVerification;
			pendingKey: string;
			sessionGeneration: number;
			ceilingMs?: number;
		},
		text: string,
	): Promise<ChunkResult> {
		const startedAt = this.host.now();
		for (;;) {
			const reason = await this.awaitPause(input, text, startedAt);
			if (reason !== undefined)
				return {
					ok: false,
					transport: "none",
					contentProof: "none",
					reason,
					notSent: true,
				};
			// A cue can take the idle moment first; then wait for the next one.
			// After a reconnect the chunk goes to the new generation.
			if (!this.pending) {
				this.overrunCut = undefined;
				return this.runChunk(
					input.pendingKey,
					text,
					input.verification,
					this.host.sessionGeneration(),
					true,
				);
			}
		}
	}

	/**
	 * Founder rework B: wait for the conversation to pause. The limit is time,
	 * never a count: 8 s of a quiet room that is still not idle (a stuck busy
	 * state), or 120 s in all. No chunk is held meanwhile, so a cue still goes.
	 */
	private awaitPause(
		input: {
			pendingKey: string;
			sessionGeneration: number;
			ceilingMs?: number;
		},
		expected: string,
		startedAt: number,
	): Promise<string | undefined> {
		let activeAt = startedAt;
		return new Promise((resolve) => {
			const poll = (): void => {
				if (this.replyStop) {
					const stop = this.replyStop;
					this.replyStop = undefined;
					resolve(stop);
					return;
				}
				const live = this.host.isLive();
				if (!live && !this.host.recovering?.()) {
					resolve("generation_changed");
					return;
				}
				const now = this.host.now();
				const busy = !live
					? "reconnecting"
					: this.pending
						? "speech_pending"
						: (this.host.busyReason() ?? this.awaitingFinal(expected));
				if (busy === undefined) {
					resolve(undefined);
					return;
				}
				// A reconnect, a cue being spoken and an owed final (30 s at most)
				// are progress too, not a stuck room.
				if (
					!live ||
					this.pending ||
					busy === "awaiting_final" ||
					this.host.roomActive?.()
				)
					activeAt = now;
				const quietMs = now - activeAt;
				const waitedMs = now - startedAt;
				const limit =
					quietMs >= (this.host.readbackQuietMs ?? DEFAULT_READBACK_QUIET_MS)
						? "quiet"
						: waitedMs >=
								(input.ceilingMs ??
									this.host.readbackCeilingMs ??
									DEFAULT_READBACK_CEILING_MS)
							? "ceiling"
							: undefined;
				if (limit) {
					this.host.evidence({
						kind: "codex_speech_admission_timeout",
						pendingKey: input.pendingKey,
						busy,
						limit,
						waitedMs: Math.round(waitedMs),
						quietMs: Math.round(quietMs),
					});
					resolve("busy_conversation");
					return;
				}
				const timer = setTimeout(
					poll,
					this.host.admissionPollMs ?? DEFAULT_ADMISSION_POLL_MS,
				);
				timer.unref?.();
			};
			poll();
		});
	}

	private runChunk(
		pendingKey: string,
		expected: string,
		verification: VoiceSpeakVerification,
		generation: number,
		readback = false,
	): Promise<ChunkResult> {
		return new Promise<ChunkResult>((resolve) => {
			const pending: PendingChunk = {
				pendingKey,
				generation,
				expected,
				readback,
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
		const busy = this.host.busyReason() ?? this.awaitingFinal(pending.expected);
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
	private awaitingFinal(expected: string): string | undefined {
		this.expireOwed();
		// A retry of the same line may go (see turnCreated), but not while an
		// overrun chunk's final is still to come: that final must not meet a
		// chunk it could be taken for (review R3).
		return this.owed.some(
			(owed) => owed.overran === true || owed.expected !== expected,
		)
			? "awaiting_final"
			: undefined;
	}

	private expireOwed(): void {
		const now = this.host.now();
		this.keepOwed((owed) => now <= owed.until);
	}

	/** Drops owed finals; a marker bound to a dropped one goes with it. */
	private keepOwed(keep: (owed: OwedFinal) => boolean): void {
		this.owed = this.owed.filter(keep);
		const owner = this.truncation?.owner;
		if (owner && !this.owed.includes(owner)) this.truncation = undefined;
	}

	/** An owed chunk's final: check it against that chunk's own line. */
	private checkLateFinal(owed: OwedFinal, text: string): void {
		const alignment = speechAlignment(owed.expected, text);
		if (!alignment.overrun) return;
		// A live retry of the same line is the one still audible: cut it.
		const live = this.pending;
		if (live?.sent && !live.settled && live.expected === owed.expected) {
			this.overrun(live, text, alignment, true);
			return;
		}
		this.host.overrun(owed.turnId);
		const detectedAt = this.host.now();
		this.truncation = {
			expected: owed.expected,
			until: detectedAt + TRUNCATION_MARKER_MS,
		};
		this.recordOverrun({
			kind: "codex_speech_overrun",
			pendingKey: owed.pendingKey,
			turnId: owed.turnId ?? null,
			expectedChars: alignment.expectedChars,
			unalignedChars: alignment.unaligned,
			extraTextSha256: createHash("sha256")
				.update(unalignedText(owed.expected, text))
				.digest("hex"),
			detectedAtMs: Math.round(detectedAt - owed.sentAt),
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
		onFinal: boolean,
	): void {
		const detectedAt = this.host.now();
		const consumedAtDetection = this.host.consumedVoiced();
		this.host.overrun(pending.boundTurnId);
		// Founder rework A: a Lead-reply chunk is mirrored only as far as it was
		// read, and the rest of it is read next.
		const prefix = pending.readback
			? spokenPrefix(pending.expected, observed)
			: undefined;
		// Cut on a delta: the final is still to come, and it is this chunk's.
		// It fences the next chunk and is the only final the marker may take.
		const owner: OwedFinal | undefined = onFinal
			? undefined
			: {
					expected: pending.expected,
					turnId: pending.boundTurnId,
					pendingKey: pending.pendingKey,
					sentAt: pending.sentAt,
					until: detectedAt + TRUNCATION_MARKER_MS,
					overran: true,
					heard: observed,
				};
		if (owner) this.owed.push(owner);
		this.truncation = {
			expected: prefix ? prefix.spoken : pending.expected,
			until: detectedAt + TRUNCATION_MARKER_MS,
			...(owner ? { owner } : {}),
		};
		const extra = unalignedText(pending.expected, observed);
		this.recordOverrun(
			{
				kind: "codex_speech_overrun",
				pendingKey: pending.pendingKey,
				turnId: pending.boundTurnId ?? null,
				expectedChars: alignment.expectedChars,
				unalignedChars: alignment.unaligned,
				extraTextSha256: createHash("sha256").update(extra).digest("hex"),
				detectedAtMs: Math.round(detectedAt - pending.sentAt),
			},
			consumedAtDetection,
		);
		this.settle(pending, {
			ok: false,
			transport: "submitted",
			contentProof: "none",
			reason: "speech_overrun",
			...(prefix ? { prefix } : {}),
		});
	}

	/** Every overrun records how much real audio still played after the cut. */
	private recordOverrun(
		record: Record<string, unknown>,
		consumedAtDetection = this.host.consumedVoiced(),
	): void {
		const timer = setTimeout(() => {
			// Real audio the player still took after the cut (its look-ahead).
			const lateVoiced = this.host.consumedVoiced() - consumedAtDetection;
			this.host.evidence({ ...record, stopLatencyMs: lateVoiced * 20 });
		}, OVERRUN_STOP_WINDOW_MS);
		timer.unref?.();
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
		// Settled before its app-server final: that final is still owed and
		// checked. Not after an overrun (already truncated), a rejected
		// transport (no final can come), the founder preempting it (what follows
		// is her answer), or a new generation or close (never delivered).
		if (
			pending.sent &&
			pending.finalText === undefined &&
			result.reason !== "speech_overrun" &&
			result.reason !== "speech_transport_failed" &&
			result.reason !== "speech_preempted" &&
			result.reason !== "generation_changed" &&
			result.reason !== "session_closed"
		)
			this.owed.push({
				expected: pending.expected,
				turnId: pending.boundTurnId,
				pendingKey: pending.pendingKey,
				sentAt: pending.sentAt,
				until: this.host.now() + TRUNCATION_MARKER_MS,
			});
		pending.settle({ ...result, generation: pending.generation });
	}
}
