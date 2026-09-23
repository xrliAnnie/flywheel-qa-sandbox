import { TypedEmitter } from "../../emitter.js";
import { VoiceError } from "../../types.js";
import { GenerationFence } from "./generationFence.js";
import {
	LiveSession,
	type LiveSessionEvents,
	type LiveSessionFinalization,
	type OpenAiLiveSocket,
} from "./LiveSession.js";
import type { OpenAiLiveSessionConfig } from "./liveProtocol.js";

export type LiveCancelReason =
	| "barge-in"
	| "announcer-takeover"
	| "provider-failure"
	| "session-close";

export interface LiveGenerationControllerOptions {
	config: OpenAiLiveSessionConfig;
	connectSocket: () => Promise<OpenAiLiveSocket>;
	nextEventId: () => string;
	retirementDeadlineMs: number;
	/** Must synchronously stop/flush local output for the retiring generation. */
	cancelLocalOutput: (generation: number, reason: LiveCancelReason) => void;
}

export interface LiveGenerationControllerEvents extends LiveSessionEvents {
	ready: [generation: number];
	retired: [
		result: {
			generation: number;
			finalization: LiveSessionFinalization;
		},
	];
}

export class LiveGenerationController {
	private readonly emitter = new TypedEmitter<LiveGenerationControllerEvents>();
	private readonly fence = new GenerationFence();
	private readonly sessionUnsubscribers = new Map<
		LiveSession,
		Array<() => void>
	>();
	private generation = 0;
	private readyGeneration?: number;
	private active?: LiveSession;
	private opening?: Promise<number>;
	private replacing?: Promise<number>;
	private closed = false;
	private closing?: Promise<void>;

	constructor(private readonly opts: LiveGenerationControllerOptions) {
		if (
			!Number.isFinite(opts.retirementDeadlineMs) ||
			opts.retirementDeadlineMs < 0
		) {
			throw new VoiceError(
				"component-missing",
				"openai-live: retirement deadline must be non-negative",
			);
		}
	}

	get currentGeneration(): number | undefined {
		return this.generation > 0 ? this.generation : undefined;
	}

	get turnCancelOrSuppress(): boolean {
		return (
			this.readyGeneration !== undefined &&
			this.fence.isCurrent(this.readyGeneration)
		);
	}

	on<E extends keyof LiveGenerationControllerEvents>(
		event: E,
		handler: (...args: LiveGenerationControllerEvents[E]) => void,
	): () => void {
		return this.emitter.on(event, handler);
	}

	start(): Promise<number> {
		if (this.closed) return Promise.reject(this.closedError());
		if (this.active || this.opening) {
			return Promise.reject(
				new VoiceError(
					"backend-protocol",
					"openai-live: generation controller already started",
				),
			);
		}
		return this.trackOpening(this.openGeneration());
	}

	cancelAndReplace(
		reason: Exclude<LiveCancelReason, "provider-failure" | "session-close">,
	): Promise<number> {
		if (this.closed) return Promise.reject(this.closedError());
		if (this.replacing) return this.replacing;
		const priorSession = this.active;
		const priorOpening = this.opening;
		this.cancelCurrent(reason);
		const replacement = (async (): Promise<number> => {
			if (priorSession) {
				await this.retire(priorSession);
			}
			if (priorOpening) await priorOpening.catch(() => undefined);
			if (this.closed) throw this.closedError();
			return this.openGeneration();
		})();
		this.replacing = replacement;
		void replacement.then(
			() => {
				if (this.replacing === replacement) this.replacing = undefined;
			},
			() => {
				if (this.replacing === replacement) this.replacing = undefined;
			},
		);
		return this.trackOpening(replacement);
	}

	appendInputAudio(chunk: Buffer): void {
		this.requireActive().appendInputAudio(chunk);
	}

	appendCommentary(content: string, delegationId: string | null): void {
		this.requireActive().appendCommentary(content, delegationId);
	}

	appendThinking(content: string): void {
		this.requireActive().appendThinking(content);
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		const priorSession = this.active;
		const priorOpening = this.opening;
		this.cancelCurrent("session-close");
		this.closing = (async () => {
			if (priorSession) await this.retire(priorSession);
			if (priorOpening) await priorOpening.catch(() => undefined);
		})();
		return this.closing;
	}

	private async openGeneration(): Promise<number> {
		if (this.closed) throw this.closedError();
		const generation = ++this.generation;
		this.fence.activate(generation);
		let socket: OpenAiLiveSocket;
		try {
			socket = await this.opts.connectSocket();
		} catch (error) {
			this.fence.tombstone(generation);
			throw error;
		}
		try {
			this.fence.assertCurrent(generation);
			if (this.closed) throw this.closedError();
		} catch (error) {
			socket.close();
			throw error;
		}

		const session = new LiveSession({
			generation,
			config: this.opts.config,
			fence: this.fence,
			socket,
			nextEventId: this.opts.nextEventId,
		});
		this.active = session;
		this.attach(session, generation);
		try {
			await session.start();
			this.fence.assertCurrent(generation);
			this.readyGeneration = generation;
			this.emitter.emit("ready", generation);
			return generation;
		} catch (error) {
			if (this.active === session) this.active = undefined;
			this.readyGeneration = undefined;
			this.fence.tombstone(generation);
			this.detach(session);
			throw error;
		}
	}

	private attach(session: LiveSession, generation: number): void {
		const unsubscribers: Array<() => void> = [
			session.on("audio", (frame) => this.emitter.emit("audio", frame)),
			session.on("transcript", (delta) =>
				this.emitter.emit("transcript", delta),
			),
			session.on("delegation", (delegation) =>
				this.emitter.emit("delegation", delegation),
			),
			session.on("error", (error) => {
				if (this.readyGeneration === generation) {
					this.readyGeneration = undefined;
					this.opts.cancelLocalOutput(generation, "provider-failure");
				}
				this.emitter.emit("error", error);
			}),
		];
		this.sessionUnsubscribers.set(session, unsubscribers);
	}

	private detach(session: LiveSession): void {
		for (const unsubscribe of this.sessionUnsubscribers.get(session) ?? []) {
			unsubscribe();
		}
		this.sessionUnsubscribers.delete(session);
	}

	private async retire(session: LiveSession): Promise<void> {
		const result = await session.retire({
			deadlineMs: this.opts.retirementDeadlineMs,
		});
		this.detach(session);
		if (this.active === session) this.active = undefined;
		this.emitter.emit("retired", result);
	}

	private cancelCurrent(reason: LiveCancelReason): void {
		if (this.generation <= 0 || !this.fence.isCurrent(this.generation)) return;
		const generation = this.generation;
		this.fence.tombstone(generation);
		this.readyGeneration = undefined;
		this.opts.cancelLocalOutput(generation, reason);
	}

	private requireActive(): LiveSession {
		if (!this.active || !this.turnCancelOrSuppress) {
			throw new VoiceError(
				"cancelled",
				"openai-live: no active admitted generation",
			);
		}
		return this.active;
	}

	private trackOpening(promise: Promise<number>): Promise<number> {
		this.opening = promise;
		void promise.then(
			() => {
				if (this.opening === promise) this.opening = undefined;
			},
			() => {
				if (this.opening === promise) this.opening = undefined;
			},
		);
		return promise;
	}

	private closedError(): VoiceError {
		return new VoiceError(
			"backend-protocol",
			"openai-live: generation controller is closed",
		);
	}
}
