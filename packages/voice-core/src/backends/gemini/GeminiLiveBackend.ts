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
	/** in-flight tool executions (ask_lead AND extraTools share one abort map —
	 * the cancellation contract is identical for both). */
	private readonly toolAborts = new Map<string, AbortController>();
	private readonly extraTools: Map<string, LiveToolSpec["handler"]>;

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
		this.abortAllTools();
		this.emitter.emit("response-cancelled");
	}

	private abortAllTools(): void {
		for (const ac of this.toolAborts.values()) ac.abort();
		this.toolAborts.clear();
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
