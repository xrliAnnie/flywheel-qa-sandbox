/**
 * GeminiLiveTransport — the injectable seam between GeminiLiveBackend and the
 * actual @google/genai Live websocket. The adapter is written against THIS
 * interface so it is fully unit-testable with a mock (CI needs no SDK / no
 * GEMINI_API_KEY); the real SDK is wired only in genaiConnector.ts (lazy).
 *
 * Event names mirror the Live server messages the adapter maps onto voice-core's
 * unified vocabulary (plan.md r2 §4 step 6). Tools are declared with full
 * schemas (LiveToolDeclaration) and passed to the SDK verbatim (FLY-959 bug 3).
 * Note: there is NO client-side
 * server-cancel — `interrupted` is a SERVER output signal (barge-in), and
 * `tool-call-cancellation` is the server revoking a tool call. Manual client
 * interrupt is a LOCAL suppression handled entirely in the session.
 */
import type { AudioFormat } from "../../types.js";

export type LiveServerEvent =
	| {
			type: "transcript";
			role: "user" | "assistant";
			text: string;
			final: boolean;
			/** FLY-1065: SDK Transcription.finished — the official end-of-transcription
			 * flag. Probe evidence: the current production model never sends it, so
			 * the session treats it as a fast path only (turn aggregation has its own
			 * flush chain); kept so a model upgrade benefits automatically. */
			finished?: boolean;
	  }
	| { type: "audio"; chunk: Buffer; format: AudioFormat }
	| { type: "turn-complete" }
	/** serverContent.generationComplete — generation text is complete (probe:
	 * ~51ms after the last output fragment, vs turnComplete ~10s later, which
	 * tracks audio playback). The assistant-side flush signal (FLY-1065). */
	| { type: "generation-complete" }
	| { type: "tool-call"; callId: string; name: string; args: unknown }
	/** server revoked already-issued tool calls → abort in-flight ask_lead. */
	| { type: "tool-call-cancellation"; callIds: string[] }
	/** serverContent.interrupted — user barge-in; server stopped generation. */
	| { type: "interrupted" }
	/** sessionResumptionUpdate.newHandle — rolls forward; adapter stores it. */
	| { type: "resumption-update"; handle: string }
	/** goAway.timeLeft (seconds) — connection about to drop. */
	| { type: "go-away"; timeLeftSec: number }
	| { type: "error"; message: string };

export interface LiveConnection {
	sendAudio(frame: Buffer, format: AudioFormat): void;
	/** FLY-967: text control prompt via sendRealtimeInput({ text }). */
	sendText(text: string): void;
	/** FLY-967 round-6: signal end-of-user-audio (audioStreamEnd) so the model
	 * commits the turn and responds. Discord silence-suppression stops the
	 * audio stream abruptly when the user goes quiet — with no trailing silence
	 * and no turn-end signal the server VAD never commits and the model never
	 * replies (reproduced: abrupt audio end = NO_RESPONSE). */
	endAudioStream(): void;
	/** function-response back to the model, with optional scheduling. */
	sendToolResponse(
		callId: string,
		output: string,
		scheduling?: "silent" | "when_idle" | "interrupt",
	): void;
	onEvent(cb: (e: LiveServerEvent) => void): void;
	close(): Promise<void>;
}

/** A full function declaration — real models need description+parameters to
 * actually call a tool (FLY-543 QA: zero-schema declarations made the model
 * fabricate answers or stall). Passed to the SDK verbatim. */
export interface LiveToolDeclaration {
	name: string;
	description: string;
	/** JSON-schema-style object ({ type: "OBJECT", properties, required }). */
	parameters: Record<string, unknown>;
}

export interface LiveConnectParams {
	model: string;
	voice?: string;
	systemHint?: string;
	/** FLY-967: briefing preamble — composed BEFORE systemHint into the
	 * systemInstruction by the connector (preamble + "\n\n" + hint). */
	systemPreamble?: string;
	/** FLY-967 round-5: false pins NO_INTERRUPTION (anti-echo for speaker
	 * users); true/unset keeps native server-VAD interruption. */
	bargeIn?: boolean;
	/** sessionResumption.handle for reconnect (resume). */
	resumeHandle?: string;
	/** declared tools (the brain is surfaced as ask_lead). */
	tools: LiveToolDeclaration[];
	/** true iff the pinned model supports non-blocking function calls. */
	asyncFunctionCalling: boolean;
}

export interface GeminiLiveTransport {
	connect(params: LiveConnectParams): Promise<LiveConnection>;
}
