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
	start(signal?: AbortSignal): Promise<void>;
	appendAudio(frame: Buffer, metadata: RealtimeAudioOwner): void;
	appendSpeech(speech: PreparedSpeech): Promise<void>;
	cancelSpeech(speechId: string): void;
	stop(): Promise<void>;
}

interface RoomLike {
	start(signal?: AbortSignal): Promise<{ founderPresent: boolean }>;
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
	/** Plan §7: one fixed ceiling over preflight and both start branches. */
	startDeadlineMs?: number;
	/**
	 * Absolute epoch-ms instant the whole start expires, counted from the
	 * caller's preflight rather than from the moment the branches begin.
	 */
	startDeadlineAt?: () => number;
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
	/** FLY-2701: her presence *right now*, not "she showed up at some point". */
	private founderInRoom = false;
	/**
	 * FLY-2701 review R2: the room subscribes to presence before it reads the
	 * channel, so any event it delivers is newer than the snapshot its start
	 * returns. Once one has arrived, the snapshot is stale and must not be
	 * applied — with a parallel start that window is as long as the other
	 * branch takes.
	 */
	private presenceObserved = false;
	private presenceWaiters: Array<(present: boolean) => void> = [];
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
				this.guarded(() => {
					if (this.prewarmGated()) return;
					this.frontend.appendAudio(frame, metadata);
				}),
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
		const result = await this.startBranches();
		this.options.assertLease?.();
		this.admitted = true;
		// Only apply the room's reading if nothing newer arrived while the other
		// start branch was still running.
		if (!this.presenceObserved) this.founderInRoom = result.founderPresent;
		if (this.founderInRoom) this.founder.resolve(true);
		await this.options.lifecycle("ready");
		// Return what is true now, not the room's opening reading. The caller's
		// instant path commits `live` to the Bridge on this value, so handing back
		// a snapshot an event has already overtaken writes a durable live state
		// for a call nobody is in.
		return { founderPresent: this.founderInRoom };
	}

	/**
	 * FLY-2701 plan §7 / slice D. The model connection and joining the room have
	 * nothing to say to each other, so making one wait for the other only adds
	 * its latency to every cold start. They share one AbortController and one
	 * session-start deadline instead.
	 *
	 * The part that matters for correctness is the losing branch. A
	 * `Promise.race` that rejects on the first failure leaves the other one
	 * running, and if joining the room is the one still running, the bot lands in
	 * the channel with nothing driving it and nobody left to take it out. So both
	 * settlements are always observed — even past the deadline — and whatever
	 * arrived is stopped.
	 */
	private async startBranches(): Promise<{ founderPresent: boolean }> {
		const controller = new AbortController();
		const landed = { frontend: false, room: false };
		let abandoned = false;
		let failure: unknown;
		let roomResult: { founderPresent: boolean } | undefined;
		// FLY-2701 review R3: with each branch cleaning itself up on landing,
		// there is nothing left for the caller to wait around for once one has
		// failed. The survivor still hands itself back whenever it turns up.
		//
		// This gate *resolves* rather than rejects: a second rejected promise
		// racing the same error is one more thing that has to be handled on every
		// path, and review R4 caught exactly that leaking out as an unhandled
		// rejection. The error itself is thrown once, below, from `failure`.
		let reportFailure!: () => void;
		const firstFailure = new Promise<void>((resolve) => {
			reportFailure = resolve;
		});

		// Each half is handed back on its own. Waiting for both to settle before
		// cleaning up sounds tidier and is exactly the bug: the case that leaks a
		// joined bot is the one where the other branch never settles at all.
		const releaseFrontend = (): void => {
			void this.frontend.stop().catch(() => undefined);
		};
		const releaseRoom = (): void => {
			void this.room.stop().catch(() => undefined);
		};
		const abandon = (error: unknown): void => {
			controller.abort(error);
			if (abandoned) return;
			failure ??= error;
			abandoned = true;
			if (landed.frontend) releaseFrontend();
			if (landed.room) releaseRoom();
			reportFailure();
		};

		const frontendBranch = this.frontend.start(controller.signal).then(() => {
			landed.frontend = true;
			if (abandoned) releaseFrontend();
		}, abandon);
		const roomBranch = this.room.start(controller.signal).then((result) => {
			landed.room = true;
			roomResult = result;
			if (abandoned) releaseRoom();
		}, abandon);
		const settled = Promise.all([frontendBranch, roomBranch]);

		let timer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				const error = new Error("voice_session_start_timeout");
				abandon(error);
				reject(error);
			}, this.startBudgetMs());
			timer.unref?.();
		});
		expiry.catch(() => undefined);

		try {
			await Promise.race([settled, expiry, firstFailure]);
		} finally {
			if (timer) clearTimeout(timer);
		}

		if (failure !== undefined) throw failure;
		if (this.stopping) {
			abandon(new Error("voice_session_stopped"));
			throw new Error("voice_session_stopped");
		}
		return roomResult!;
	}

	/**
	 * Plan §7 puts preflight and both branches under one ceiling. The caller
	 * knows when its own preflight began, so it may hand over the absolute
	 * instant the whole start expires; otherwise the ceiling starts here.
	 */
	private startBudgetMs(): number {
		const ceiling = this.options.startDeadlineMs ?? 120_000;
		const deadlineAt = this.options.startDeadlineAt?.();
		if (deadlineAt === undefined) return ceiling;
		return Math.max(0, Math.min(ceiling, deadlineAt - this.now().getTime()));
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

	/**
	 * FLY-2701: a booked meeting sits in the room before its time. Nothing said
	 * there belongs to the meeting, so no room audio reaches the model until T.
	 * Transcripts, playback and capture are already gated on `live` above; this
	 * closes the remaining inbound path. An instant session has no floor and is
	 * unaffected.
	 */
	private prewarmGated(): boolean {
		return !this.live && this.options.projection.notBeforeLiveAt != null;
	}

	isFounderPresent(): boolean {
		return this.founderInRoom;
	}

	/**
	 * A prewarmed meeting may have watched her arrive and leave again while it
	 * waited for the meeting time, so going live asks about *now* and then waits
	 * for the next arrival — it never replays the one-off "she was here once".
	 */
	async waitForFounderPresence(timeoutMs: number): Promise<boolean> {
		if (this.founderInRoom) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let waiter!: (present: boolean) => void;
		try {
			return await new Promise<boolean>((resolve) => {
				waiter = resolve;
				this.presenceWaiters.push(waiter);
				timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref?.();
			});
		} finally {
			if (timer) clearTimeout(timer);
			const index = this.presenceWaiters.indexOf(waiter);
			if (index >= 0) this.presenceWaiters.splice(index, 1);
		}
	}

	/**
	 * FLY-2701 review R1: the caller reached here through an await — the Bridge's
	 * own `live` round trip — and she can leave inside it. That leave arrives
	 * while `live` is still false, so the end path lets it pass, and no second
	 * leave event will ever follow. Asking presence once more here is the last
	 * point at which the race is still visible; after this, media is open.
	 */
	async markLive(): Promise<void> {
		if (!this.founderInRoom) {
			this.finish({ kind: "ended", reason: "she-left" });
			return;
		}
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
		this.presenceObserved = true;
		this.founderInRoom = present;
		if (present) {
			this.founder.resolve(true);
			for (const waiter of this.presenceWaiters.splice(0)) waiter(true);
		} else if (this.live) {
			this.finish({ kind: "ended", reason: "she-left" });
		}
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
