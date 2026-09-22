import type { ReceiveHealth } from "flywheel-voice-core";
import type { VoiceSessionProjection } from "./bridge-client.js";
import type { ActiveVoiceSession, VoiceEnd } from "./daemon.js";
import type { CapturedTranscript } from "./delivery.js";
import type { RealtimeAudioOwner } from "./realtime.js";
import type { PreparedSpeech } from "./speech.js";

export interface FrontendHandlers {
	onTranscript(input: {
		itemId: string;
		contentIndex: number;
		text: string;
		ownerUserId: string;
		speakerName: string;
		utteranceId: string;
	}): void;
	onSpeechAudioReady(input: { speechId: string; pcm24Mono: Buffer }): void;
	onSpeechResult(input: {
		speechId: string;
		status: "rejected" | "timeout" | "failed";
		reason: string;
	}): void;
	onClosed(outcome: VoiceEnd): void;
}

export interface RoomHandlers {
	onAudio(frame: Buffer, metadata: RealtimeAudioOwner): void;
	onFounderPresence(present: boolean): void;
	onReceiveHealth(snapshot: ReceiveHealth): void;
	onError(error: Error): void;
	assertLease(): void;
}

interface FrontendLike {
	start(): Promise<void>;
	appendAudio(frame: Buffer, metadata: RealtimeAudioOwner): void;
	appendSpeech(speech: PreparedSpeech): Promise<void>;
	cancelSpeech(speechId: string): void;
	stop(): Promise<void>;
}

interface RoomLike {
	start(): Promise<{ founderPresent: boolean }>;
	playSpeech(speechId: string, pcm24Mono: Buffer): Promise<void>;
	cancelSpeech?(speechId: string): void;
	status(text: string): Promise<void>;
	stop(): Promise<void>;
	setBedEnabled?(enabled: boolean): void;
	setWaiting?(waiting: boolean): void;
}

export interface GenericVoiceSessionOptions {
	projection: VoiceSessionProjection;
	delivery: { capture(input: CapturedTranscript): Promise<boolean> | boolean };
	createFrontend(handlers: FrontendHandlers): FrontendLike;
	createRoom(handlers: RoomHandlers): RoomLike;
	lifecycle(
		state: "ready" | "live" | "interrupted" | "ended",
		reason?: string,
	): Promise<void> | void;
	evidence(record: Record<string, unknown>): void;
	/** Retained for config compatibility; playback uses an audio-duration budget. */
	confirmationMs: number;
	now?: () => Date;
	cleanup?(): void;
	assertLease?(): void;
	postStatus?(text: string): Promise<void>;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	return {
		promise: new Promise<T>((done) => {
			resolve = done;
		}),
		resolve,
	};
}

type SpeechReceipt = "confirmed" | "unconfirmed" | "failed";

export class GenericVoiceSession implements ActiveVoiceSession {
	private readonly frontend: FrontendLike;
	private readonly room: RoomLike;
	private readonly founder = deferred<boolean>();
	private readonly ended = deferred<VoiceEnd>();
	private readonly now: () => Date;
	private live = false;
	private admitted = false;
	private stopping = false;
	private endedOnce = false;
	private latestReceiveHealth?: ReceiveHealth;
	private pendingSpeech?: {
		speech: PreparedSpeech;
		resolve(status: SpeechReceipt): void;
		playbackTimer?: ReturnType<typeof setTimeout>;
	};

	constructor(private readonly options: GenericVoiceSessionOptions) {
		this.now = options.now ?? (() => new Date());
		this.frontend = options.createFrontend({
			onTranscript: (input) => this.transcript(input),
			onSpeechAudioReady: (input) => this.speechAudioReady(input),
			onSpeechResult: (input) => this.speechResult(input),
			onClosed: (outcome) =>
				this.finish(
					!this.live && outcome.kind === "ended"
						? { kind: "failed", reason: "realtime_pre_live_end" }
						: outcome,
				),
		});
		this.room = options.createRoom({
			onAudio: (frame, metadata) =>
				this.guarded(() => this.frontend.appendAudio(frame, metadata)),
			onFounderPresence: (present) => this.founderPresence(present),
			onReceiveHealth: (snapshot) => {
				if (!this.stopping) this.latestReceiveHealth = { ...snapshot };
			},
			onError: (error) =>
				this.finish({
					kind: "failed",
					reason: `discord_audio:${error.message}`,
				}),
			assertLease: () => this.options.assertLease?.(),
		});
	}

	async start(): Promise<{ founderPresent: boolean }> {
		if (this.stopping) throw new Error("voice_session_stopped");
		this.options.assertLease?.();
		await this.frontend.start();
		if (this.stopping) {
			await this.frontend.stop();
			throw new Error("voice_session_stopped");
		}
		this.options.assertLease?.();
		const result = await this.room.start();
		if (this.stopping) {
			await this.room.stop();
			throw new Error("voice_session_stopped");
		}
		this.options.assertLease?.();
		this.admitted = true;
		if (result.founderPresent) this.founder.resolve(true);
		await this.options.lifecycle("ready");
		return result;
	}

	async waitForFounder(timeoutMs: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.founder.promise,
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), timeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async markLive(): Promise<void> {
		this.live = true;
		await this.options.lifecycle("live");
	}

	waitForEnd(): Promise<VoiceEnd> {
		return this.ended.promise;
	}

	receiveHealth(): ReceiveHealth | undefined {
		return this.latestReceiveHealth
			? { ...this.latestReceiveHealth }
			: undefined;
	}

	requestEnd(outcome: VoiceEnd): void {
		this.finish(outcome);
	}

	async speak(speech: PreparedSpeech): Promise<SpeechReceipt> {
		if (this.pendingSpeech || this.stopping || !this.admitted || !this.live)
			return "failed";
		this.room.setWaiting?.(false);
		return new Promise<SpeechReceipt>((resolve) => {
			this.pendingSpeech = { speech, resolve };
			void this.frontend.appendSpeech(speech).catch(() => {
				this.settleSpeech(speech.speechId, "failed");
			});
		});
	}

	notify(text: string): void {
		this.status(text);
	}

	async stop(outcome?: VoiceEnd): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		this.admitted = false;
		const pending = this.pendingSpeech;
		if (pending) {
			this.frontend.cancelSpeech(pending.speech.speechId);
			this.room.cancelSpeech?.(pending.speech.speechId);
			this.settleSpeech(pending.speech.speechId, "failed");
		}
		try {
			if (outcome) {
				await this.options.lifecycle(
					outcome.kind === "ended" ? "ended" : "interrupted",
					outcome.reason,
				);
			}
		} finally {
			await this.room.stop().catch(() => undefined);
			await this.frontend.stop().catch(() => undefined);
			this.options.cleanup?.();
		}
	}

	private founderPresence(present: boolean): void {
		if (present) this.founder.resolve(true);
		else if (this.live) this.finish({ kind: "ended", reason: "she-left" });
	}

	private transcript(input: {
		itemId: string;
		contentIndex: number;
		text: string;
		ownerUserId: string;
		speakerName: string;
		utteranceId: string;
	}): void {
		if (this.stopping || !this.admitted || !this.live) return;
		const command = input.text.normalize("NFKC").replace(/\s+/gu, "");
		if (input.ownerUserId === this.options.projection.founderUserId) {
			if (command === "退出语音模式") {
				this.finish({ kind: "ended", reason: "voice-stop" });
				return;
			}
			if (command === "等待音关掉" || command === "等待音打开") {
				this.room.setBedEnabled?.(command.endsWith("打开"));
				return;
			}
		}
		this.room.setWaiting?.(true);
		void Promise.resolve(
			this.options.delivery.capture({
				transcriptId: `${this.options.projection.sessionId}:1:${input.itemId}:${input.contentIndex}`,
				speakerUserId: input.ownerUserId,
				speakerName: input.speakerName,
				rawText: input.text,
				ts: this.now().toISOString(),
			}),
		)
			.then((delivered) => {
				if (delivered)
					this.status(`📻 已转达，${this.options.projection.displayName} 在想`);
			})
			.catch((error) =>
				this.finish({
					kind: "failed",
					reason: `delivery_failed:${(error as Error).message}`,
				}),
			);
	}

	private speechAudioReady(input: {
		speechId: string;
		pcm24Mono: Buffer;
	}): void {
		if (this.stopping || !this.admitted || !this.live) return;
		const pending = this.pendingSpeech;
		if (!pending || pending.speech.speechId !== input.speechId) return;
		const playbackBudgetMs = Math.ceil(input.pcm24Mono.length / 48) + 5_000;
		pending.playbackTimer = setTimeout(() => {
			this.room.cancelSpeech?.(input.speechId);
			this.settleSpeech(input.speechId, "failed");
			this.status("📻 播放中断，请重开语音");
			this.finish({ kind: "failed", reason: "realtime_playback_stalled" });
		}, playbackBudgetMs);
		pending.playbackTimer.unref?.();
		void this.room
			.playSpeech(input.speechId, input.pcm24Mono)
			.then(() => {
				if (this.settleSpeech(input.speechId, "confirmed")) {
					this.options.evidence({
						ts: this.now().toISOString(),
						kind: "realtime_playback_submitted",
						speechId: input.speechId,
						pcmBytes: input.pcm24Mono.length,
					});
					this.status("📻 已念完");
				}
			})
			.catch(() => this.settleSpeech(input.speechId, "failed"));
	}

	private speechResult(input: {
		speechId: string;
		status: "rejected" | "timeout" | "failed";
		reason: string;
	}): void {
		if (this.stopping) return;
		this.options.evidence({
			ts: this.now().toISOString(),
			kind: "realtime_speech_terminal",
			speechId: input.speechId,
			status: input.status,
			reason: input.reason,
		});
		this.status("📻 这段未朗读，请看文字");
		this.settleSpeech(
			input.speechId,
			input.status === "timeout" ? "unconfirmed" : "failed",
		);
	}

	private settleSpeech(speechId: string, status: SpeechReceipt): boolean {
		const pending = this.pendingSpeech;
		if (!pending || pending.speech.speechId !== speechId) return false;
		if (pending.playbackTimer) clearTimeout(pending.playbackTimer);
		this.pendingSpeech = undefined;
		pending.resolve(status);
		return true;
	}

	private status(text: string): void {
		if (this.stopping || !this.admitted) return;
		void (this.options.postStatus ?? ((value) => this.room.status(value)))(
			text,
		).catch((error) =>
			this.options.evidence({
				ts: this.now().toISOString(),
				kind: "status_failed",
				reason: (error as Error).message,
			}),
		);
	}

	private finish(outcome: VoiceEnd): void {
		if (this.endedOnce) return;
		this.endedOnce = true;
		this.ended.resolve(outcome);
	}

	private guarded(effect: () => void): void {
		if (this.stopping || !this.admitted) return;
		try {
			this.options.assertLease?.();
			effect();
		} catch {
			this.finish({ kind: "failed", reason: "lease_lost" });
		}
	}
}
