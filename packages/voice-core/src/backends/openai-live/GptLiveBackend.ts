import { randomUUID } from "node:crypto";
import { TypedEmitter } from "../../emitter.js";
import type {
	AudioFormat,
	CapabilityAwareConversationSession,
	ConversationEventMap,
	ConversationOptions,
	ResumeHandle,
	ScheduleHint,
	ToolResult,
	VoiceBackend,
	VoiceBackendCapabilities,
} from "../../types.js";
import { VoiceError } from "../../types.js";
import type {
	LiveCancelReason,
	LiveRetirementResult,
} from "./LiveGenerationController.js";
import { LiveGenerationController } from "./LiveGenerationController.js";
import type { OpenAiLiveSocket } from "./LiveSession.js";
import {
	OPENAI_LIVE_AUDIO_FORMAT,
	type OpenAiLiveServerEvent,
} from "./liveProtocol.js";

export interface OpenAiLiveConnector {
	connect(): Promise<OpenAiLiveSocket>;
}

export interface GptLiveBackendOptions {
	transport: OpenAiLiveConnector;
	model: string;
	voice: string;
	contextMaxTokens?: number;
	retirementDeadlineMs?: number;
	/** GPT-Live has no transcript-done event; group output after this idle gap. */
	outputTranscriptIdleMs?: number;
	nextEventId?: () => string;
}

export type OpenAiLiveTranscriptDelta = Extract<
	OpenAiLiveServerEvent,
	{ type: "transcript-delta" }
> & { generation: number };

export interface OpenAiLiveConversationSession
	extends CapabilityAwareConversationSession {
	readonly providerGeneration: number | undefined;
	onLiveTranscript(
		listener: (delta: OpenAiLiveTranscriptDelta) => void,
	): () => void;
	suspend(
		reason: Extract<
			LiveCancelReason,
			"announcer-takeover" | "delegation-sealed"
		>,
	): Promise<LiveRetirementResult>;
	resume(): Promise<number>;
	replaceAfterBargeIn(): Promise<number>;
}

const FRONTEND_INSTRUCTIONS = [
	"You are the foreground voice. You may answer simple questions directly in your own words.",
	'When a request requires lookup, action, or judgment, first say exactly "我问下 Lead", then create a client delegation.',
	"Do not claim that a delegation or background task is complete until the client returns its result.",
].join("\n");

export class GptLiveBackend implements VoiceBackend {
	readonly id = "openai-live";
	readonly capabilities: VoiceBackendCapabilities = {
		announce: false,
		converse: true,
		verbatim: false,
		attribution: false,
		bargeIn: false,
		toolCallScheduling: "none",
		transcriptGranularity: "partial",
		supportsResume: false,
		voiceCloning: false,
		audioOut: [OPENAI_LIVE_AUDIO_FORMAT],
		audioIn: [OPENAI_LIVE_AUDIO_FORMAT],
	};

	constructor(private readonly opts: GptLiveBackendOptions) {
		const contextMaxTokens = opts.contextMaxTokens ?? 500;
		if (!Number.isSafeInteger(contextMaxTokens) || contextMaxTokens <= 0) {
			throw new VoiceError(
				"component-missing",
				"openai-live: context token ceiling must be a positive integer",
			);
		}
		const outputTranscriptIdleMs = opts.outputTranscriptIdleMs ?? 1_000;
		if (
			!Number.isSafeInteger(outputTranscriptIdleMs) ||
			outputTranscriptIdleMs < 1
		) {
			throw new VoiceError(
				"component-missing",
				"openai-live: output transcript idle boundary must be a positive integer",
			);
		}
	}

	async createConversation(
		opts: ConversationOptions,
	): Promise<OpenAiLiveConversationSession> {
		if (opts.resumeHandle) {
			throw new VoiceError(
				"unsupported",
				"openai-live: session resume is not supported",
			);
		}
		if (opts.extraTools?.length) {
			throw new VoiceError(
				"unsupported",
				"openai-live: function tools are not supported; use client delegation",
			);
		}
		let eventId = 0;
		const sessionRef: { current?: GptLiveConversationSession } = {};
		const controller = new LiveGenerationController({
			config: {
				model: this.opts.model,
				instructions: [
					FRONTEND_INSTRUCTIONS,
					opts.systemPreamble,
					opts.systemHint,
				]
					.filter((value): value is string => Boolean(value?.trim()))
					.join("\n\n"),
				voice: opts.voice ?? this.opts.voice,
				delegation: "client",
				audio: OPENAI_LIVE_AUDIO_FORMAT,
			},
			connectSocket: () => this.opts.transport.connect(),
			nextEventId: this.opts.nextEventId ?? (() => `openai-live-${++eventId}`),
			retirementDeadlineMs: this.opts.retirementDeadlineMs ?? 1_000,
			cancelLocalOutput: (generation) =>
				sessionRef.current?.cancelGeneration(generation),
		});
		const session = new GptLiveConversationSession(
			controller,
			this.opts.contextMaxTokens ?? 500,
			this.opts.outputTranscriptIdleMs ?? 1_000,
		);
		sessionRef.current = session;
		await controller.start();
		return session;
	}
}

class GptLiveConversationSession implements OpenAiLiveConversationSession {
	readonly sessionId = randomUUID();
	private readonly emitter = new TypedEmitter<ConversationEventMap>();
	private readonly startedAudioGenerations = new Set<number>();
	private readonly outputTranscriptByGeneration = new Map<number, string>();
	private readonly outputTranscriptTimers = new Map<
		number,
		ReturnType<typeof setTimeout>
	>();
	private readonly liveTranscriptListeners = new Set<
		(delta: OpenAiLiveTranscriptDelta) => void
	>();

	get providerGeneration(): number | undefined {
		return this.controller.currentGeneration;
	}

	get effectiveCapabilities() {
		return {
			verbatim: false,
			attribution: false,
			turnCancelOrSuppress: this.controller.turnCancelOrSuppress,
		};
	}

	constructor(
		private readonly controller: LiveGenerationController,
		private readonly contextMaxTokens: number,
		private readonly outputTranscriptIdleMs: number,
	) {
		controller.on("audio", ({ generation, chunk, format }) => {
			if (!this.startedAudioGenerations.has(generation)) {
				this.startedAudioGenerations.add(generation);
				this.emitter.emit("response-started");
			}
			this.emitter.emit("response-audio", chunk, format);
		});
		controller.on("transcript", (liveDelta) => {
			for (const listener of [...this.liveTranscriptListeners]) {
				listener(liveDelta);
			}
			this.emitter.emit("transcript", {
				role: liveDelta.direction === "input" ? "user" : "assistant",
				text: liveDelta.delta,
				final: false,
			});
			if (liveDelta.direction === "output") {
				const prior =
					this.outputTranscriptByGeneration.get(liveDelta.generation) ?? "";
				this.outputTranscriptByGeneration.set(
					liveDelta.generation,
					`${prior}${liveDelta.delta}`,
				);
				const timer = this.outputTranscriptTimers.get(liveDelta.generation);
				if (timer) clearTimeout(timer);
				const idleTimer = setTimeout(
					() => this.flushOutputTranscript(liveDelta.generation),
					this.outputTranscriptIdleMs,
				);
				idleTimer.unref?.();
				this.outputTranscriptTimers.set(liveDelta.generation, idleTimer);
			}
		});
		controller.on(
			"delegation",
			({ delegationId, generation, offsetMs, target }) => {
				this.emitter.emit("delegation-created", {
					delegationId,
					generation,
					...(offsetMs === undefined ? {} : { offsetMs }),
					target,
				});
			},
		);
		controller.on("error", (error) => this.emitter.emit("error", error));
	}

	cancelGeneration(generation: number): void {
		const timer = this.outputTranscriptTimers.get(generation);
		if (timer) clearTimeout(timer);
		this.outputTranscriptTimers.delete(generation);
		const text = this.outputTranscriptByGeneration.get(generation);
		this.outputTranscriptByGeneration.delete(generation);
		if (text) {
			this.emitter.emit("transcript", {
				role: "assistant",
				text,
				final: true,
				interrupted: true,
			});
		}
		this.startedAudioGenerations.delete(generation);
		this.emitter.emit("response-cancelled");
	}

	private flushOutputTranscript(generation: number): void {
		this.outputTranscriptTimers.delete(generation);
		const text = this.outputTranscriptByGeneration.get(generation);
		this.outputTranscriptByGeneration.delete(generation);
		if (!text) return;
		this.emitter.emit("transcript", {
			role: "assistant",
			text,
			final: true,
		});
	}

	onLiveTranscript(
		listener: (delta: OpenAiLiveTranscriptDelta) => void,
	): () => void {
		this.liveTranscriptListeners.add(listener);
		return () => this.liveTranscriptListeners.delete(listener);
	}

	suspend(
		reason: Extract<
			LiveCancelReason,
			"announcer-takeover" | "delegation-sealed"
		>,
	): Promise<LiveRetirementResult> {
		return this.controller.suspend(reason);
	}

	resume(): Promise<number> {
		return this.controller.resume();
	}

	sendAudio(frame: Buffer, format: AudioFormat): void {
		if (
			format.encoding !== OPENAI_LIVE_AUDIO_FORMAT.encoding ||
			format.sampleRateHz !== OPENAI_LIVE_AUDIO_FORMAT.sampleRateHz ||
			format.channels !== OPENAI_LIVE_AUDIO_FORMAT.channels
		) {
			throw new VoiceError(
				"backend-protocol",
				"openai-live: input audio must be PCM16 mono 24 kHz",
			);
		}
		this.controller.appendInputAudio(frame);
	}

	sendText(text: string): void {
		this.controller.appendCommentary(text, null);
	}

	injectContext(text: string): void {
		// OpenAI's Live protocol does not expose a tokenizer. UTF-8 byte length is
		// a conservative upper bound for its byte-level tokenization: rejecting
		// above this value can be stricter for multibyte text, but never admits an
		// event whose token count can exceed the configured safety ceiling.
		if (Buffer.byteLength(text, "utf8") > this.contextMaxTokens) {
			throw new VoiceError(
				"resource-exhausted",
				`openai-live: silent context exceeds the ${this.contextMaxTokens}-token event limit`,
			);
		}
		this.controller.appendThinking(text);
	}

	endUserTurn(): void {}

	interrupt(): void {
		void this.replaceAfterBargeIn().catch((error) => {
			this.emitter.emit(
				"error",
				error instanceof VoiceError
					? error
					: new VoiceError(
							"connection-closed",
							"语音不可用: OpenAI Live replacement failed",
							error,
						),
			);
		});
	}

	replaceAfterBargeIn(): Promise<number> {
		return this.controller.cancelAndReplace("barge-in");
	}

	injectToolResult(_result: ToolResult, _schedule?: ScheduleHint): void {
		throw new VoiceError(
			"unsupported",
			"openai-live: function tools are not supported; use client delegation",
		);
	}

	on<E extends keyof ConversationEventMap>(
		event: E,
		handler: (...args: ConversationEventMap[E]) => void,
	): () => void {
		return this.emitter.on(event, handler);
	}

	async close(): Promise<ResumeHandle | undefined> {
		await this.controller.close();
		return undefined;
	}
}
