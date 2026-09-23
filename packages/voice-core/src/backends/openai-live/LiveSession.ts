import { TypedEmitter } from "../../emitter.js";
import type { AudioFormat } from "../../types.js";
import { VoiceError } from "../../types.js";
import type { GenerationFence } from "./generationFence.js";
import {
	assertStartedMatchesConfig,
	buildCommentaryAppend,
	buildInputAudioAppend,
	buildSessionClose,
	buildSessionStart,
	buildThinkingAppend,
	type OpenAiLiveClientEvent,
	type OpenAiLiveServerEvent,
	type OpenAiLiveSessionConfig,
	parseLiveServerEvent,
} from "./liveProtocol.js";

export interface OpenAiLiveSocket {
	send(event: OpenAiLiveClientEvent): void;
	onMessage(handler: (raw: string | Buffer) => void): () => void;
	onClose(handler: (error?: Error) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	close(): void;
}

export interface LiveSessionEvents extends Record<string, unknown[]> {
	audio: [frame: { generation: number; chunk: Buffer; format: AudioFormat }];
	transcript: [
		delta: Extract<OpenAiLiveServerEvent, { type: "transcript-delta" }> & {
			generation: number;
		},
	];
	delegation: [
		delegation: Extract<
			OpenAiLiveServerEvent,
			{ type: "delegation-created" }
		> & {
			generation: number;
		},
	];
	error: [error: VoiceError];
}

export type LiveSessionFinalization =
	| "provider_connection_closed"
	| "provider_finalization_incomplete";

export interface LiveSessionOptions {
	generation: number;
	config: OpenAiLiveSessionConfig;
	fence: GenerationFence;
	socket: OpenAiLiveSocket;
	nextEventId: () => string;
}

type SessionState = "idle" | "opening" | "active" | "retiring" | "closed";

export class LiveSession {
	private readonly emitter = new TypedEmitter<LiveSessionEvents>();
	private state: SessionState = "idle";
	private opening?: Promise<void>;
	private resolveOpening?: () => void;
	private rejectOpening?: (error: VoiceError) => void;
	private retirement?: Promise<{
		generation: number;
		finalization: LiveSessionFinalization;
	}>;
	private resolveRetirement?: (value: {
		generation: number;
		finalization: LiveSessionFinalization;
	}) => void;
	private retirementTimer?: ReturnType<typeof setTimeout>;
	private socketClosed = false;
	private readonly unsubscribe: Array<() => void>;

	constructor(private readonly opts: LiveSessionOptions) {
		this.unsubscribe = [
			opts.socket.onMessage((raw) => this.onMessage(raw)),
			opts.socket.onClose((error) => this.failConnection(error)),
			opts.socket.onError((error) => this.failConnection(error)),
		];
	}

	on<E extends keyof LiveSessionEvents>(
		event: E,
		handler: (...args: LiveSessionEvents[E]) => void,
	): () => void {
		return this.emitter.on(event, handler);
	}

	start(): Promise<void> {
		if (this.opening) return this.opening;
		if (this.state !== "idle") {
			return Promise.reject(
				new VoiceError(
					"backend-protocol",
					`openai-live: cannot start session in ${this.state} state`,
				),
			);
		}
		this.opts.fence.assertCurrent(this.opts.generation);
		this.state = "opening";
		this.opening = new Promise<void>((resolve, reject) => {
			this.resolveOpening = resolve;
			this.rejectOpening = reject;
		});
		try {
			this.opts.socket.send(
				buildSessionStart(this.opts.config, this.opts.nextEventId()),
			);
		} catch (error) {
			this.failOpening(error);
		}
		return this.opening;
	}

	appendInputAudio(chunk: Buffer): void {
		this.opts.fence.assertCurrent(this.opts.generation);
		if (this.state !== "active") {
			throw new VoiceError(
				"backend-protocol",
				`openai-live: session is not active (${this.state})`,
			);
		}
		this.opts.socket.send(
			buildInputAudioAppend(chunk, this.opts.nextEventId()),
		);
	}

	appendCommentary(content: string, delegationId: string | null): void {
		this.assertActive();
		this.opts.socket.send(
			buildCommentaryAppend(content, delegationId, this.opts.nextEventId()),
		);
	}

	appendThinking(content: string): void {
		this.assertActive();
		this.opts.socket.send(
			buildThinkingAppend(content, this.opts.nextEventId()),
		);
	}

	retire(opts: { deadlineMs: number }): Promise<{
		generation: number;
		finalization: LiveSessionFinalization;
	}> {
		if (this.retirement) return this.retirement;
		if (!Number.isFinite(opts.deadlineMs) || opts.deadlineMs < 0) {
			return Promise.reject(
				new VoiceError(
					"backend-protocol",
					"openai-live: retirement deadline must be non-negative",
				),
			);
		}

		this.opts.fence.tombstone(this.opts.generation);
		this.state = "retiring";
		this.retirement = new Promise((resolve) => {
			this.resolveRetirement = resolve;
		});
		this.opts.socket.send(buildSessionClose(this.opts.nextEventId()));
		this.retirementTimer = setTimeout(
			() => this.finishRetirement("provider_finalization_incomplete"),
			opts.deadlineMs,
		);
		return this.retirement;
	}

	private onMessage(raw: string | Buffer): void {
		let event: OpenAiLiveServerEvent;
		try {
			event = parseLiveServerEvent(raw);
		} catch (error) {
			if (this.state === "opening") this.failOpening(error);
			else this.emitError(error);
			return;
		}

		if (event.type === "session-closed") {
			if (this.state === "retiring") {
				this.finishRetirement("provider_connection_closed");
			} else if (this.state !== "closed") {
				this.state = "closed";
				this.closeSocket();
				this.emitter.emit(
					"error",
					new VoiceError(
						"connection-closed",
						"openai-live: provider closed the active session",
					),
				);
			}
			return;
		}

		if (this.state === "opening" && event.type === "session-started") {
			try {
				this.opts.fence.assertCurrent(this.opts.generation);
				assertStartedMatchesConfig(event, this.opts.config);
				this.state = "active";
				this.resolveOpening?.();
				this.resolveOpening = undefined;
				this.rejectOpening = undefined;
			} catch (error) {
				this.failOpening(error);
			}
			return;
		}
		if (this.state === "opening" && event.type === "server-error") {
			this.failOpening(
				new VoiceError("backend-protocol", `openai-live: ${event.message}`),
			);
			return;
		}

		if (
			this.state !== "active" ||
			!this.opts.fence.isCurrent(this.opts.generation)
		) {
			return;
		}

		switch (event.type) {
			case "output-audio":
				this.emitter.emit("audio", {
					generation: this.opts.generation,
					chunk: event.chunk,
					format: event.format,
				});
				break;
			case "transcript-delta":
				this.emitter.emit("transcript", {
					...event,
					generation: this.opts.generation,
				});
				break;
			case "delegation-created":
				this.emitter.emit("delegation", {
					...event,
					generation: this.opts.generation,
				});
				break;
			case "server-error":
				this.emitter.emit(
					"error",
					new VoiceError("backend-protocol", `openai-live: ${event.message}`),
				);
				break;
			case "session-started":
				this.emitter.emit(
					"error",
					new VoiceError(
						"backend-protocol",
						"openai-live: duplicate session.started event",
					),
				);
				break;
			case "ignored":
				break;
		}
	}

	private emitError(error: unknown): void {
		this.emitter.emit("error", this.asVoiceError(error));
	}

	private assertActive(): void {
		this.opts.fence.assertCurrent(this.opts.generation);
		if (this.state !== "active") {
			throw new VoiceError(
				"backend-protocol",
				`openai-live: session is not active (${this.state})`,
			);
		}
	}

	private failOpening(error: unknown): void {
		if (this.state !== "opening") return;
		const voiceError = this.asVoiceError(error);
		this.opts.fence.tombstone(this.opts.generation);
		this.state = "closed";
		this.unsubscribeAll();
		this.closeSocket();
		this.emitter.emit("error", voiceError);
		this.rejectOpening?.(voiceError);
		this.resolveOpening = undefined;
		this.rejectOpening = undefined;
	}

	private asVoiceError(error: unknown): VoiceError {
		return error instanceof VoiceError
			? error
			: new VoiceError(
					"backend-protocol",
					"openai-live: session failed",
					error,
				);
	}

	private finishRetirement(finalization: LiveSessionFinalization): void {
		if (this.state === "closed") return;
		this.state = "closed";
		if (this.retirementTimer) clearTimeout(this.retirementTimer);
		this.retirementTimer = undefined;
		this.unsubscribeAll();
		this.closeSocket();
		this.resolveRetirement?.({
			generation: this.opts.generation,
			finalization,
		});
		this.resolveRetirement = undefined;
	}

	private closeSocket(): void {
		if (this.socketClosed) return;
		this.socketClosed = true;
		this.opts.socket.close();
	}

	private failConnection(error?: Error): void {
		if (this.state === "closed") return;
		const detail = error?.message ?? "provider connection closed";
		if (this.state === "opening") {
			this.failOpening(
				new VoiceError(
					"connection-closed",
					`语音不可用: OpenAI Live admission failed (${detail})`,
					error,
				),
			);
			return;
		}
		if (this.state === "retiring") {
			this.finishRetirement("provider_finalization_incomplete");
			return;
		}
		this.opts.fence.tombstone(this.opts.generation);
		this.state = "closed";
		this.unsubscribeAll();
		this.closeSocket();
		this.emitter.emit(
			"error",
			new VoiceError(
				"connection-closed",
				`openai-live: provider connection failed (${detail})`,
				error,
			),
		);
	}

	private unsubscribeAll(): void {
		for (const unsubscribe of this.unsubscribe) unsubscribe();
	}
}
