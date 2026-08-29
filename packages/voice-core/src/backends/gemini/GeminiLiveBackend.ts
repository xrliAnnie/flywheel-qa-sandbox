/**
 * GeminiLiveBackend — the converse face (plan.md r2 §4 step 6). Streaming,
 * server-side VAD + native barge-in, built-in ASR (so round-1 needs no
 * standalone STT). The brain stays in-repo, surfaced to the model as an
 * `ask_lead` tool: when the model calls it we run the same BrainAdapter and
 * stream the answer back as a function-response.
 *
 * Capabilities are DERIVED FROM THE CONFIG-PINNED MODEL, never hardcoded:
 * toolCallScheduling "scheduled" only when the model supports async function
 * calls, else "basic". Resume: sessionResumption.handle configured at connect;
 * newHandle rolls forward; close() returns the latest handle.
 *
 * Cancellation contract (plan.md r2 §3 — two distinct paths):
 *   - server barge-in ("interrupted"): stop this turn, emit response-cancelled,
 *     abort in-flight ask_lead; drop any accompanying tool-call-cancellation.
 *   - manual interrupt(): LOCAL suppression only (no client server-cancel exists):
 *     drop the rest of this turn's audio/transcript, emit response-cancelled,
 *     abort in-flight ask_lead.
 */
import { randomUUID } from "node:crypto";
import { TypedEmitter } from "../../emitter.js";
import { scrubTranscript } from "../../scrub.js";
import {
	type AudioFormat,
	type BrainAdapter,
	type ConversationEventMap,
	type ConversationOptions,
	type ConversationSession,
	type LiveToolSpec,
	type ResumeHandle,
	type ScheduleHint,
	type ToolResult,
	type TranscriptSink,
	type VoiceBackend,
	type VoiceBackendCapabilities,
	VoiceError,
} from "../../types.js";
import type {
	GeminiLiveTransport,
	LiveConnection,
	LiveServerEvent,
	LiveToolDeclaration,
} from "./transport.js";
import { TurnAccumulator, type TurnRole } from "./turn-accumulator.js";

const ASK_LEAD_TOOL = "ask_lead";

const ASK_LEAD_DECLARATION: LiveToolDeclaration = {
	name: ASK_LEAD_TOOL,
	description:
		"Ask the Lead (the project brain) a question about the project — its issues, status, decisions, or code. Always call this instead of guessing whenever the user asks about project matters.",
	parameters: {
		type: "OBJECT",
		properties: {
			question: {
				type: "STRING",
				description: "The user's question, in their own words.",
			},
		},
		required: ["question"],
	},
};
const PCM_24K: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 24_000,
	channels: 1,
};
const PCM_16K: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 16_000,
	channels: 1,
};

export interface GeminiModelProfile {
	/** config-pinned model name (evidence/ records the exact snapshot). */
	model: string;
	/** whether the pinned model supports non-blocking function calls. */
	asyncFunctionCalling: boolean;
	/** connection / audio caps for this model (Live limits drift by model). */
	connectionSec?: number;
	audioSec?: number;
}

export interface GeminiLiveBackendOptions {
	transport: GeminiLiveTransport;
	profile: GeminiModelProfile;
}

export class GeminiLiveBackend implements VoiceBackend {
	readonly id = "gemini-live";
	readonly capabilities: VoiceBackendCapabilities;

	constructor(private readonly opts: GeminiLiveBackendOptions) {
		this.capabilities = deriveCapabilities(opts.profile);
	}

	async createConversation(
		opts: ConversationOptions,
	): Promise<ConversationSession> {
		if (opts.resumeHandle && opts.resumeHandle.backendId !== this.id) {
			throw new VoiceError(
				"unsupported",
				`resume handle is for backend "${opts.resumeHandle.backendId}", not gemini-live`,
			);
		}
		const extraTools = opts.extraTools ?? [];
		const conn = await this.opts.transport.connect({
			model: this.opts.profile.model,
			voice: opts.voice,
			systemHint: opts.systemHint,
			systemPreamble: opts.systemPreamble,
			bargeIn: opts.bargeIn ?? true,
			resumeHandle: opts.resumeHandle?.payload as string | undefined,
			// ask_lead first (its brain path is fixed); extras are declared verbatim.
			tools: [ASK_LEAD_DECLARATION, ...extraTools.map((t) => t.declaration)],
			asyncFunctionCalling: this.opts.profile.asyncFunctionCalling,
		});
		return new GeminiLiveSession(
			this.id,
			conn,
			opts.brain,
			opts.transcriptSink,
			extraTools,
		);
	}
}

export function deriveCapabilities(
	profile: GeminiModelProfile,
): VoiceBackendCapabilities {
	return {
		announce: false,
		converse: true,
		bargeIn: true,
		// NOT hardcoded: scheduled only when the pinned model truly supports it.
		toolCallScheduling: profile.asyncFunctionCalling ? "scheduled" : "basic",
		transcriptGranularity: "partial",
		supportsResume: true,
		sessionLimits: {
			connectionSec: profile.connectionSec,
			audioSec: profile.audioSec,
		},
		voiceCloning: false,
		audioOut: [PCM_24K],
		audioIn: [PCM_16K],
	};
}

class GeminiLiveSession implements ConversationSession {
	readonly sessionId = randomUUID();
	private readonly emitter = new TypedEmitter<ConversationEventMap>();
	private latestHandle?: string;
	private closed = false;
	/** true after the current assistant turn was cancelled (barge-in or manual). */
	private turnCancelled = false;
	/** true while a model response window is open (response-started emitted). */
	private turnActive = false;
	/** in-flight tool executions (ask_lead AND extraTools share one abort map —
	 * the cancellation contract is identical for both). */
	private readonly toolAborts = new Map<string, AbortController>();
	private readonly extraTools: Map<string, LiveToolSpec["handler"]>;
	/** FLY-1065: per-role delta buffers behind the turn-level final semantics. */
	private readonly acc = new TurnAccumulator();

	constructor(
		private readonly backendId: string,
		private readonly conn: LiveConnection,
		private readonly brain: BrainAdapter,
		private readonly transcriptSink?: TranscriptSink,
		extraTools: LiveToolSpec[] = [],
	) {
		this.extraTools = new Map(
			extraTools.map((t) => [t.declaration.name, t.handler]),
		);
		conn.onEvent((e) => this.onServerEvent(e));
	}

	sendAudio(frame: Buffer, format: AudioFormat): void {
		this.conn.sendAudio(frame, format);
	}

	/** control prompt — not the founder's words; never written to the transcript. */
	sendText(text: string): void {
		this.conn.sendText(text);
	}

	/** FLY-967 round-6: the user stopped speaking — commit their turn so the
	 * model responds (Discord silence-suppression gives no trailing silence for
	 * the server VAD to detect end-of-speech on its own). */
	endUserTurn(): void {
		this.conn.endAudioStream();
	}

	/** manual interrupt — LOCAL suppression only (no client server-cancel exists).
	 * The half-said assistant turn is flushed WITH the interrupted mark first —
	 * what she heard half of must be recorded as-said (FLY-1065). */
	interrupt(): void {
		this.flushFinal("assistant", { interrupted: true });
		this.cancelCurrentTurn();
	}

	injectToolResult(r: ToolResult, sched?: ScheduleHint): void {
		this.conn.sendToolResponse(r.callId, r.output, sched);
	}

	on<E extends keyof ConversationEventMap>(
		e: E,
		h: (...a: ConversationEventMap[E]) => void,
	): () => void {
		return this.emitter.on(e, h);
	}

	async close(): Promise<ResumeHandle | undefined> {
		if (!this.closed) {
			this.closed = true;
			// flush both residual buffers BEFORE closing — a rotator rotation (or
			// the meeting teardown) must not lose the last half-turn (FLY-1065).
			this.flushFinal("user");
			this.flushFinal("assistant");
			this.abortAllTools();
			await this.conn.close();
		}
		return this.latestHandle
			? { backendId: this.backendId, payload: this.latestHandle }
			: undefined;
	}

	private cancelCurrentTurn(): void {
		if (this.turnCancelled) return;
		this.turnCancelled = true;
		this.turnActive = false; // the next turn re-opens its own window
		this.abortAllTools();
		this.emitter.emit("response-cancelled");
	}

	private abortAllTools(): void {
		for (const ac of this.toolAborts.values()) ac.abort();
		this.toolAborts.clear();
	}

	/** open the response window lazily on the FIRST model output of a turn.
	 * FLY-967 round-4: keying response-started off user transcripts left
	 * sendText-initiated turns (the /gemini opening) with no window — the
	 * speaker never saw beginTurn and gate-dropped every opening chunk.
	 *
	 * FLY-1065: the first model output of a turn is ALSO the user-side flush
	 * signal — she finished, the model is answering, so her turn is definable
	 * NOW (probe: input transcription lands before the first output fragment).
	 * Without this her caption would wait for turn-complete, ~10s after the
	 * conversation moved on. */
	private ensureTurnStarted(): void {
		if (this.turnActive || this.turnCancelled) return;
		this.turnActive = true;
		this.flushFinal("user");
		this.emitter.emit("response-started");
	}

	private onServerEvent(e: LiveServerEvent): void {
		switch (e.type) {
			case "transcript":
				// suppress assistant transcript after a cancel (contract); user always
				// flows. Suppressed fragments never enter the turn buffer either — the
				// pre-cancel half was already flushed by the interrupted handler.
				if (e.role === "assistant" && this.turnCancelled) return;
				if (e.role === "assistant") this.ensureTurnStarted();
				// FLY-1065 turn aggregation: fragments buffer per role and pass
				// through as final:false; final:true is emitted ONLY by flushFinal
				// (turn-level aggregate). The transport's legacy `final` field is a
				// dead signal here.
				this.acc.append(e.role, e.text);
				this.emitter.emit("transcript", {
					role: e.role,
					text: e.text,
					final: false,
				});
				// fast path: the SDK's official end-of-transcription flag (probe:
				// never sent by the current model; kept for model upgrades).
				if (e.finished === true) this.flushFinal(e.role);
				if (e.role === "user") {
					// a new user turn resets a cancelled window; the response window
					// itself opens on the first MODEL output (ensureTurnStarted).
					this.turnCancelled = false;
				}
				break;
			case "audio":
				if (this.turnCancelled) return; // drop suppressed audio
				this.ensureTurnStarted();
				this.emitter.emit("response-audio", e.chunk, e.format);
				break;
			case "generation-complete":
				// generation text is complete (~51ms after the last fragment; audio
				// may still be playing). The assistant-side main flush; also the
				// late-arriving-user backstop (FLY-1065).
				this.flushFinal("user");
				this.flushFinal("assistant");
				break;
			case "turn-complete":
				// last-resort flush: with no finished / generation-complete signal the
				// worst case degrades to end-of-turn aggregation (user first).
				this.flushFinal("user");
				this.flushFinal("assistant");
				if (!this.turnCancelled && this.turnActive)
					this.emitter.emit("response-done");
				this.turnCancelled = false;
				this.turnActive = false;
				break;
			case "tool-call":
				// a tool call arriving after this turn was cancelled belongs to the
				// cancelled generation — drop it entirely (local-suppression semantics;
				// running it would send a function-response for a dead turn).
				if (this.turnCancelled) return;
				this.emitter.emit("tool-call", {
					callId: e.callId,
					name: e.name,
					args: e.args,
				});
				if (e.name === ASK_LEAD_TOOL) {
					void this.handleAskLead(e.callId, e.args);
				} else if (this.extraTools.has(e.name)) {
					void this.handleExtraTool(e.callId, e.name, e.args);
				} else {
					// declared-but-unhandled (or model-hallucinated) name: answer with
					// an explicit error so the Live turn never hangs waiting (FLY-545).
					this.conn.sendToolResponse(
						e.callId,
						`(unknown tool "${e.name}" — no handler registered)`,
					);
				}
				break;
			case "tool-call-cancellation":
				for (const id of e.callIds) {
					this.toolAborts.get(id)?.abort();
					this.toolAborts.delete(id);
				}
				break;
			case "interrupted":
				// flush the half-said assistant turn WITH the interrupted mark BEFORE
				// suppression kicks in — the record keeps what she actually heard. If
				// generation-complete already flushed (she interrupted playback of a
				// completed answer) the empty buffer makes this a no-op, honestly
				// leaving the un-marked full text in place (FLY-1065).
				this.flushFinal("assistant", { interrupted: true });
				this.cancelCurrentTurn();
				break;
			case "resumption-update":
				this.latestHandle = e.handle;
				break;
			case "go-away":
				this.emitter.emit("session-expiring", { inSec: e.timeLeftSec });
				break;
			case "error":
				this.emitter.emit(
					"error",
					new VoiceError("backend-protocol", e.message),
				);
				break;
		}
	}

	/** the ONE final exit (FLY-1065): aggregate → empty-buffer idempotency gate
	 * → scrub → final event + sink row. Every flush signal funnels here, so
	 * multi-signal arrival can never double-emit and no unscrubbed turn text
	 * ever leaves the session. */
	private flushFinal(role: TurnRole, opts?: { interrupted?: boolean }): void {
		const raw = this.acc.flush(role);
		if (raw == null) return;
		const text = scrubTranscript(raw);
		this.emitter.emit("transcript", {
			role,
			text,
			final: true,
			...(opts?.interrupted ? { interrupted: true } : {}),
		});
		this.writeTranscript(role, text, opts?.interrupted);
	}

	private writeTranscript(
		role: "user" | "assistant",
		text: string,
		interrupted?: boolean,
	): void {
		this.transcriptSink?.append({
			ts: new Date().toISOString(),
			sessionId: this.sessionId,
			backendId: this.backendId,
			face: "converse",
			role,
			text,
			final: true,
			...(interrupted ? { interrupted: true } : {}),
		});
	}

	private async handleAskLead(callId: string, args: unknown): Promise<void> {
		const question = extractQuestion(args);
		const controller = new AbortController();
		this.toolAborts.set(callId, controller);
		let answer = "";
		try {
			for await (const chunk of this.brain.respond(
				{ text: question, history: [] },
				{ signal: controller.signal },
			)) {
				answer += chunk;
			}
		} catch (err) {
			this.toolAborts.delete(callId);
			if (controller.signal.aborted) return; // cancelled — do not send a response
			this.emitter.emit(
				"error",
				new VoiceError(
					"backend-protocol",
					`ask_lead brain failed: ${String(err)}`,
					err,
				),
			);
			this.conn.sendToolResponse(
				callId,
				"(the lead could not answer right now)",
			);
			return;
		}
		this.toolAborts.delete(callId);
		if (controller.signal.aborted) return;
		this.conn.sendToolResponse(callId, answer.trim() || "(no answer)");
	}

	/** FLY-545: dispatch an orchestrator-provided extra tool. Same cancellation
	 * contract as ask_lead; the result is injected WHEN_IDLE so a long answer
	 * never blocks the live turn (§15 "long answer → ack first" scheduling). */
	private async handleExtraTool(
		callId: string,
		name: string,
		args: unknown,
	): Promise<void> {
		const handler = this.extraTools.get(name);
		if (!handler) return; // unreachable — caller checked membership
		const controller = new AbortController();
		this.toolAborts.set(callId, controller);
		let output: string;
		try {
			output = await handler(args, { signal: controller.signal });
		} catch (err) {
			this.toolAborts.delete(callId);
			if (controller.signal.aborted) return; // cancelled — do not send a response
			this.emitter.emit(
				"error",
				new VoiceError(
					"backend-protocol",
					`${name} tool failed: ${String(err)}`,
					err,
				),
			);
			this.conn.sendToolResponse(
				callId,
				`(the ${name} tool could not answer right now)`,
				"when_idle",
			);
			return;
		}
		this.toolAborts.delete(callId);
		if (controller.signal.aborted) return;
		this.conn.sendToolResponse(callId, output, "when_idle");
	}
}

function extractQuestion(args: unknown): string {
	if (typeof args === "string") return args;
	if (args && typeof args === "object") {
		const o = args as Record<string, unknown>;
		for (const k of ["question", "text", "prompt", "query"]) {
			if (typeof o[k] === "string") return o[k] as string;
		}
	}
	return "";
}
