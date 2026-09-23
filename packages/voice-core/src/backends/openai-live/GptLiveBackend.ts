import { randomUUID } from "node:crypto";
import { TypedEmitter } from "../../emitter.js";
import type {
	AudioFormat,
	CapabilityAwareConversationSession,
	ConversationEventMap,
	ConversationOptions,
	ConversationSession,
	ResumeHandle,
	ScheduleHint,
	ToolResult,
	VoiceBackend,
	VoiceBackendCapabilities,
} from "../../types.js";
import { VoiceError } from "../../types.js";
import { LiveGenerationController } from "./LiveGenerationController.js";
import type { OpenAiLiveSocket } from "./LiveSession.js";
import { OPENAI_LIVE_AUDIO_FORMAT } from "./liveProtocol.js";

export interface OpenAiLiveConnector {
	connect(): Promise<OpenAiLiveSocket>;
}

export interface GptLiveBackendOptions {
	transport: OpenAiLiveConnector;
	model: string;
	voice: string;
	retirementDeadlineMs?: number;
	nextEventId?: () => string;
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

	constructor(private readonly opts: GptLiveBackendOptions) {}

	async createConversation(
		opts: ConversationOptions,
	): Promise<ConversationSession> {
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
		const session = new GptLiveConversationSession(controller);
		sessionRef.current = session;
		await controller.start();
		return session;
	}
}

class GptLiveConversationSession implements CapabilityAwareConversationSession {
	readonly sessionId = randomUUID();
	private readonly emitter = new TypedEmitter<ConversationEventMap>();
	private readonly startedAudioGenerations = new Set<number>();

	get effectiveCapabilities() {
		return {
			verbatim: false,
			attribution: false,
			turnCancelOrSuppress: this.controller.turnCancelOrSuppress,
		};
	}

	constructor(private readonly controller: LiveGenerationController) {
		controller.on("audio", ({ generation, chunk, format }) => {
			if (!this.startedAudioGenerations.has(generation)) {
				this.startedAudioGenerations.add(generation);
				this.emitter.emit("response-started");
			}
			this.emitter.emit("response-audio", chunk, format);
		});
		controller.on("transcript", ({ direction, delta }) => {
			this.emitter.emit("transcript", {
				role: direction === "input" ? "user" : "assistant",
				text: delta,
				final: false,
			});
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
		this.startedAudioGenerations.delete(generation);
		this.emitter.emit("response-cancelled");
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
		this.controller.appendThinking(text);
	}

	endUserTurn(): void {}

	interrupt(): void {
		void this.controller.cancelAndReplace("barge-in");
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
