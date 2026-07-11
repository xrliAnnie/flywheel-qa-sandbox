/**
 * FLY-543 voice-core public contract (plan.md r2 §3).
 *
 * Round-1 abstracts voice as TWO independent capability faces:
 *   - announce (speech-out only)  — a Lead "speaks" (read a report / standup).
 *   - converse (speech-in + out)  — a full voice conversation with a Lead.
 * A backend implements one or both. Edge TTS = announce only; Gemini Live =
 * converse only (its ASR is built in, so round-1 needs no standalone STT).
 *
 * The brain (reasoning + memory) lives in-repo, orthogonal to the backend; only
 * the converse face needs it (surfaced to the model as an ask_lead tool).
 * Standalone STT, local models (whisper/CosyVoice/Qwen) and the high-risk
 * ConfirmedTranscriptGate are deferred (the gate rides with action-routing).
 */

export type AudioFormat = {
	encoding: "pcm16" | "wav" | "mp3";
	sampleRateHz: number;
	channels: 1 | 2;
};

export type Turn = { role: "user" | "assistant"; text: string; ts: string };

export type ResumeHandle = { backendId: string; payload: unknown };

export type ToolResult = { callId: string; output: string };

/** Gemini's async function-response scheduling positions. */
export type ScheduleHint = "silent" | "when_idle" | "interrupt";

/** Every failure path surfaces as a VoiceError with a machine code. */
export type VoiceErrorCode =
	| "unsupported" // backend does not support a requested capability (e.g. resume)
	| "component-missing" // component path missing / not executable (fail-fast)
	| "subprocess-failed" // subprocess exited non-zero
	| "timeout" // subprocess exceeded its deadline
	| "cancelled" // aborted via AbortSignal
	| "backend-protocol" // backend protocol error (ws disconnect, bad frame, ...)
	| "resource-exhausted"; // a hard capacity cap refused new work (FLY-1160: resident session limit)

export class VoiceError extends Error {
	constructor(
		public readonly code: VoiceErrorCode,
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "VoiceError";
	}
}

export interface VoiceBackendCapabilities {
	/** provides createAnnouncer (speech-out only). */
	announce: boolean;
	/** provides createConversation (speech-in + out). */
	converse: boolean;
	bargeIn: boolean;
	toolCallScheduling: "none" | "basic" | "scheduled";
	transcriptGranularity: "final-only" | "partial";
	supportsResume: boolean;
	sessionLimits?: { connectionSec?: number; audioSec?: number };
	voiceCloning: boolean;
	audioOut: AudioFormat[];
	/** may be omitted when converse=false. */
	audioIn?: AudioFormat[];
}

/**
 * A fully-specified voice: backend voice id + optional per-call prosody
 * (FLY-546 per-agent voices). rate is "±N%" and pitch is "±NHz" — the exact
 * edge-tts CLI grammar; other backends may reinterpret but the wire format is
 * fixed so configs stay portable.
 */
export type VoiceSpec = { voiceId: string; rate?: string; pitch?: string };

/** string = bare voice id (backwards compatible). */
export type VoiceRef = string | VoiceSpec;

export function toVoiceSpec(ref: VoiceRef): VoiceSpec {
	return typeof ref === "string" ? { voiceId: ref } : ref;
}

export interface AnnouncerOptions {
	/** voice inside the backend's namespace (edge-tts: zh-CN-XiaoxiaoNeural). */
	voice?: VoiceRef;
	transcriptSink?: TranscriptSink;
}

/** A full function declaration the backend passes to the model verbatim
 * (structurally identical to the Gemini transport's LiveToolDeclaration —
 * kept here so the orchestrator-facing contract has no backend import). */
export interface ToolDeclaration {
	name: string;
	description: string;
	/** JSON-schema-style object ({ type: "OBJECT", properties, required }). */
	parameters: Record<string, unknown>;
}

/**
 * FLY-545: an orchestrator-provided Live tool — declaration + handler. The
 * backend declares it to the model and dispatches matching tool-calls to the
 * handler; the resolved string is injected back as the function response
 * (default WHEN_IDLE). A declared-but-unhandled tool would hang the Live turn
 * forever, so declaration and handler travel together. Cancellation contract
 * is identical to ask_lead: tool-call-cancellation / manual interrupt /
 * close() abort the handler via `signal` and the late result is dropped.
 */
export interface LiveToolSpec {
	declaration: ToolDeclaration;
	/** runs orchestrator-side; returned text is injected as the function response. */
	handler: (args: unknown, opts: { signal: AbortSignal }) => Promise<string>;
}

export interface ConversationOptions {
	brain: BrainAdapter;
	voice?: string;
	/** spoken-register hint (short sentences / colloquial / no-markdown). */
	systemHint?: string;
	/**
	 * FLY-967: session-scope context preamble (meeting briefing). When set it is
	 * prefixed to the systemInstruction ahead of systemHint (joined by a blank
	 * line). Unset = current behavior byte-for-byte (talk CLI / FLY-545).
	 */
	systemPreamble?: string;
	/**
	 * FLY-967 round-5: voice barge-in switch. true (default) keeps the
	 * backend's native interruption (server VAD cancels the live response when
	 * the user starts speaking — right for headphone users). false pins
	 * NO_INTERRUPTION: the model always finishes speaking — recommended for
	 * SPEAKER users, whose mic feeds the assistant's own audio back and the
	 * echo gets misjudged as an interruption (~0.3s cancel on every reply).
	 */
	bargeIn?: boolean;
	transcriptSink?: TranscriptSink;
	/**
	 * resume is injected at creation time (Gemini configures sessionResumption at
	 * connect). supportsResume=false + a handle → VoiceError("unsupported").
	 */
	resumeHandle?: ResumeHandle;
	/**
	 * FLY-545: additional Live tools (declaration + handler) dispatched by the
	 * backend. Default [] = current behavior (ask_lead only).
	 */
	extraTools?: LiveToolSpec[];
}

export interface VoiceBackend {
	readonly id:
		| "edge-tts"
		| "gemini-live"
		| "openai-realtime"
		| "cosyvoice"
		| (string & {});
	/** For Gemini: derived from the config-pinned model, never hardcoded. */
	readonly capabilities: VoiceBackendCapabilities;
	/** required when capabilities.announce is true (registry enforces). */
	createAnnouncer?(opts: AnnouncerOptions): Promise<AnnouncerSession>;
	/** required when capabilities.converse is true (registry enforces). */
	createConversation?(opts: ConversationOptions): Promise<ConversationSession>;
}

export interface SpeakResult {
	ttsFirstByteMs: number;
	/**
	 * End-to-end elapsed ms from when this utterance started being processed
	 * (synth begins) until sound actually starts playing — when the founder
	 * actually hears sound (the honest first-response anchor). MUST include the
	 * TTS synth wait, not just local player spawn overhead (FLY-543).
	 */
	playbackStartMs: number;
	durationMs: number;
}

export interface AnnouncerSession {
	readonly sessionId: string;
	/** serial queue: each speak() plays in order; abort/interrupt clears the rest. */
	speak(text: string, opts?: { signal?: AbortSignal }): Promise<SpeakResult>;
	interrupt(): void;
	close(): Promise<void>;
}

export type ConversationEventMap = {
	"speech-started": [];
	"speech-stopped": [];
	/** FLY-1065: final:true events are TURN-LEVEL aggregates (full turn text,
	 * scrubbed); final:false stays the raw fragment passthrough. `interrupted`
	 * marks an assistant turn flushed half-said by a barge-in / manual
	 * interrupt (optional, additive). */
	transcript: [
		{
			role: "user" | "assistant";
			text: string;
			final: boolean;
			interrupted?: boolean;
		},
	];
	"response-started": [];
	"response-audio": [chunk: Buffer, format: AudioFormat];
	"response-done": [];
	/** emitted after any interrupt; no assistant transcript follows for that turn. */
	"response-cancelled": [];
	"tool-call": [{ callId: string; name: string; args: unknown }];
	/** Gemini goAway.timeLeft maps here. */
	"session-expiring": [{ inSec: number }];
	error: [VoiceError];
};

export interface ConversationSession {
	readonly sessionId: string;
	sendAudio(frame: Buffer, format: AudioFormat): void;
	/**
	 * FLY-967: send a text control prompt to the model — steering the founder
	 * never hears ("please open the meeting", "please recap"). These are NOT the
	 * founder's words: nothing is written to the transcript sink for them, so
	 * verbatim-quote pools built from user entries can never pick them up.
	 */
	sendText(text: string): void;
	/**
	 * FLY-967 round-6: the user finished their utterance — commit the turn so
	 * the model responds. Needed because Discord silence-suppression ends the
	 * audio stream abruptly (no trailing silence), so the server VAD never
	 * commits end-of-speech on its own. No-op backends may ignore it.
	 */
	endUserTurn(): void;
	interrupt(): void;
	injectToolResult(r: ToolResult, sched?: ScheduleHint): void;
	on<E extends keyof ConversationEventMap>(
		e: E,
		h: (...a: ConversationEventMap[E]) => void,
	): () => void;
	/** returns the latest resume handle (if the backend supports it). */
	close(): Promise<ResumeHandle | undefined>;
}

export interface BrainAdapter {
	respond(
		turn: { text: string; history: Turn[] },
		opts: { signal: AbortSignal },
	): AsyncIterable<string>;
}

/** announce-face internal pluggable engine (edge-tts ↔ Azure fallback slot). */
export interface TtsEngine {
	synthesize(
		text: string,
		voice: VoiceRef,
		opts: { signal: AbortSignal },
	): Promise<{ audio: Buffer; format: AudioFormat; ttsFirstByteMs: number }>;
}

export interface TranscriptSink {
	/** failures throw explicitly — never swallowed. */
	append(entry: TranscriptEntry): void;
}

export type TranscriptEntry = {
	ts: string;
	sessionId: string;
	backendId: string;
	face: "announce" | "converse";
	role: "user" | "assistant";
	text: string;
	final: boolean;
	/** FLY-1065: the turn was cut short by a barge-in (recorded as-said). */
	interrupted?: boolean;
};
