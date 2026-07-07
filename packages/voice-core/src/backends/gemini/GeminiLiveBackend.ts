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
import {
	type AudioFormat,
	type BrainAdapter,
	type ConversationEventMap,
	type ConversationOptions,
	type ConversationSession,
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
} from "./transport.js";

const ASK_LEAD_TOOL = "ask_lead";
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
		const conn = await this.opts.transport.connect({
			model: this.opts.profile.model,
			voice: opts.voice,
			systemHint: opts.systemHint,
			resumeHandle: opts.resumeHandle?.payload as string | undefined,
			toolNames: [ASK_LEAD_TOOL],
			asyncFunctionCalling: this.opts.profile.asyncFunctionCalling,
		});
		return new GeminiLiveSession(
			this.id,
			conn,
			opts.brain,
			opts.transcriptSink,
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
	private readonly askLeadAborts = new Map<string, AbortController>();

	constructor(
		private readonly backendId: string,
		private readonly conn: LiveConnection,
		private readonly brain: BrainAdapter,
		private readonly transcriptSink?: TranscriptSink,
	) {
		conn.onEvent((e) => this.onServerEvent(e));
	}

	sendAudio(frame: Buffer, format: AudioFormat): void {
		this.conn.sendAudio(frame, format);
	}

	/** manual interrupt — LOCAL suppression only (no client server-cancel exists). */
	interrupt(): void {
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
			this.abortAllAskLead();
			await this.conn.close();
		}
		return this.latestHandle
			? { backendId: this.backendId, payload: this.latestHandle }
			: undefined;
	}

	private cancelCurrentTurn(): void {
		if (this.turnCancelled) return;
		this.turnCancelled = true;
		this.abortAllAskLead();
		this.emitter.emit("response-cancelled");
	}

	private abortAllAskLead(): void {
		for (const ac of this.askLeadAborts.values()) ac.abort();
		this.askLeadAborts.clear();
	}

	private onServerEvent(e: LiveServerEvent): void {
		switch (e.type) {
			case "transcript":
				// suppress assistant transcript after a cancel (contract); user always flows.
				if (e.role === "assistant" && this.turnCancelled) return;
				this.emitter.emit("transcript", {
					role: e.role,
					text: e.text,
					final: e.final,
				});
				if (e.final) this.writeTranscript(e.role, e.text);
				if (e.role === "user") {
					// a new user turn starts a fresh assistant response window.
					this.turnCancelled = false;
					this.emitter.emit("response-started");
				}
				break;
			case "audio":
				if (this.turnCancelled) return; // drop suppressed audio
				this.emitter.emit("response-audio", e.chunk, e.format);
				break;
			case "turn-complete":
				if (!this.turnCancelled) this.emitter.emit("response-done");
				this.turnCancelled = false;
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
				if (e.name === ASK_LEAD_TOOL) void this.handleAskLead(e.callId, e.args);
				break;
			case "tool-call-cancellation":
				for (const id of e.callIds) {
					this.askLeadAborts.get(id)?.abort();
					this.askLeadAborts.delete(id);
				}
				break;
			case "interrupted":
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

	private writeTranscript(role: "user" | "assistant", text: string): void {
		this.transcriptSink?.append({
			ts: new Date().toISOString(),
			sessionId: this.sessionId,
			backendId: this.backendId,
			face: "converse",
			role,
			text,
			final: true,
		});
	}

	private async handleAskLead(callId: string, args: unknown): Promise<void> {
		const question = extractQuestion(args);
		const controller = new AbortController();
		this.askLeadAborts.set(callId, controller);
		let answer = "";
		try {
			for await (const chunk of this.brain.respond(
				{ text: question, history: [] },
				{ signal: controller.signal },
			)) {
				answer += chunk;
			}
		} catch (err) {
			this.askLeadAborts.delete(callId);
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
		this.askLeadAborts.delete(callId);
		if (controller.signal.aborted) return;
		this.conn.sendToolResponse(callId, answer.trim() || "(no answer)");
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
