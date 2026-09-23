import { fileURLToPath } from "node:url";
import {
	BotRegistry,
	type DiscordDeps,
	type DiscordReceiveDiagnostic,
	type RegistryClientLike,
} from "flywheel-voice-bridge";
import type { ReceiveHealth } from "flywheel-voice-core";
import { AudioClock } from "./audio/AudioClock.js";
import { WaitingMouth } from "./audio.js";
import {
	createInitialSileroState,
	type SileroState,
	SileroVad,
} from "./pipeline/SileroVad.js";
import { Uplink } from "./pipeline/Uplink.js";
import { UplinkSpeechGate } from "./pipeline/UplinkSpeechGate.js";
import type { RealtimeAudioOwner } from "./realtime.js";
import { ReceiveHealthTracker } from "./receive-health.js";
import { SpeakerAttribution } from "./speaker-attribution.js";

type RoomDeps = Pick<
	DiscordDeps,
	| "createClient"
	| "joinVoice"
	| "subscribeManual"
	| "createDecoder"
	| "createPlayer"
	| "createResource"
	| "speakingEvents"
	| "memberDisplayName"
	| "userVoiceChannelId"
	| "onVoiceStateUpdate"
	| "sendMessage"
	| "leaveVoice"
	| "receiveEvents"
	| "voiceConnHandle"
>;

type VoiceClient = RegistryClientLike & { user?: { id?: string } };
type Capture = {
	generation: number;
	userId: string;
	opus: NodeJS.ReadableStream;
	decoder: NodeJS.ReadWriteStream;
	settled: boolean;
	pcmBytes: number;
	watchdog?: ReturnType<typeof setTimeout>;
};

const RECEIVE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const RECEIVE_NO_PCM_MS = 2_000;
const RECEIVE_CLOSE_WAIT_MS = 1_000;
const RECEIVE_COOLDOWN_MS = 30_000;
const PCM48_STEREO_FRAME_BYTES = 3_840;

export interface DiscordVoiceRoomOptions {
	createVad?(): Promise<Pick<SileroVad, "score" | "close">>;
	onDiagnostic?(record: Record<string, unknown>): void;
	deps: RoomDeps;
	token: string;
	expectedBotUserId: string;
	guildId: string;
	voiceChannelId: string;
	threadId: string;
	founderUserId: string;
	qaAllowUserIds: string[];
	onAudio(frame: Buffer, metadata: RealtimeAudioOwner): void;
	onFounderPresence(present: boolean): void;
	onReceiveHealth?(snapshot: ReceiveHealth): void;
	onError(error: Error): void;
	assertLease?(): void;
	now?: () => number;
}

export class DiscordVoiceRoom {
	private readonly registry: BotRegistry<VoiceClient, unknown>;
	private readonly allowed: Set<string>;
	private readonly names = new Map<string, string>();
	private readonly now: () => number;
	private readonly attribution: SpeakerAttribution;
	private readonly receiveHealth: ReceiveHealthTracker;
	private connection?: unknown;
	private unsubscribePresence?: () => void;
	private readonly unsubscribeConnection: Array<() => void> = [];
	private capture?: Capture;
	private activeSpeaker?: string;
	private mouth?: WaitingMouth;
	private vad?: Pick<SileroVad, "score" | "close">;
	private uplink?: Uplink;
	private clock?: AudioClock;
	private captureGeneration = 0;
	private retryAttempts = 0;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private stableTimer?: ReturnType<typeof setTimeout>;
	private pendingCloseCleanup?: () => void;
	private isUserSpeaking?: (userId: string) => boolean;
	private cooldownUntil = 0;
	private cooldownSpeaker?: string;
	private unknownDiagnosticCount = 0;
	private stopped = false;

	constructor(private readonly options: DiscordVoiceRoomOptions) {
		this.registry = new BotRegistry<VoiceClient, unknown>({
			createClient: options.deps.createClient as () => VoiceClient,
			joinVoice: options.deps.joinVoice,
		});
		this.allowed = new Set([options.founderUserId, ...options.qaAllowUserIds]);
		this.now = options.now ?? Date.now;
		this.attribution = new SpeakerAttribution();
		this.receiveHealth = new ReceiveHealthTracker({
			now: () => new Date(this.now()),
			onChange: (snapshot) => {
				this.options.onReceiveHealth?.(snapshot);
				this.options.onDiagnostic?.({
					kind: "discord_receive_health",
					...snapshot,
				});
			},
		});
	}

	async start(signal?: AbortSignal): Promise<{ founderPresent: boolean }> {
		// FLY-2701 review R3: the checkpoints below only see the abort once the
		// call they are waiting on returns, and joining waits up to 15s for Ready.
		// When the other start branch fails, everything already created here has
		// to come down now — not when the hung call finally finishes, and not at
		// the caller's outer deadline.
		const onAbort = () => {
			void this.stop().catch(() => undefined);
		};
		if (signal?.aborted) onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await this.startUnderAbort(signal);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async startUnderAbort(
		signal?: AbortSignal,
	): Promise<{ founderPresent: boolean }> {
		this.vad = await (
			this.options.createVad ??
			(() =>
				SileroVad.create(
					fileURLToPath(new URL("../models/silero_vad.onnx", import.meta.url)),
				))
		)();
		await this.checkActive(signal);
		const vad = this.vad;
		const gate = new UplinkSpeechGate({
			score: (samples, state) => vad.score(samples, state as SileroState),
			initialState: createInitialSileroState,
			minSpeechMs: 200,
			threshold: 0.5,
			now: this.now,
			onDegraded: ({ reason, consecutive, sessionPermanent }) =>
				this.options.onDiagnostic?.({
					kind: "uplink_gate_degraded",
					reason,
					consecutive,
					sessionPermanent,
				}),
		});
		this.uplink = new Uplink({
			appendAudio: (frame, _generation, metadata) => {
				this.options.onAudio(frame, {
					...metadata,
					ownerName: metadata.ownerUserId
						? (this.names.get(metadata.ownerUserId) ?? metadata.ownerUserId)
						: null,
				});
				return "sent";
			},
			sessionGeneration: 1,
			prebufferFrames: 3,
			maxQueueFrames: 100,
			speechGate: gate,
			now: this.now,
			record: () => {},
			onGateSummary: (summary) =>
				this.options.onDiagnostic?.({
					kind: "uplink_gate_utterance",
					...summary,
				}),
		});
		await this.registry.start([{ id: "voice", token: this.options.token }]);
		await this.checkActive(signal);
		const client = this.registry.client("voice");
		if (
			!this.options.expectedBotUserId ||
			client.user?.id !== this.options.expectedBotUserId
		) {
			await this.stop();
			throw new Error("lead_bot_identity_mismatch");
		}
		this.connection = await this.registry.join(
			"voice",
			{
				guildId: this.options.guildId,
				channelId: this.options.voiceChannelId,
				selfMute: false,
				selfDeaf: false,
			},
			// FLY-2701 review R4: the connection only reaches `this.connection`
			// once the whole join resolves, so the room's own cleanup cannot see
			// it before then. The join itself has to take the abort.
			signal,
		);
		await this.checkActive(signal);
		this.subscribeConnectionDiagnostics();
		this.options.onReceiveHealth?.(this.receiveHealth.current());
		const player = this.options.deps.createPlayer(this.connection);
		this.mouth = new WaitingMouth({
			player,
			createResource: this.options.deps.createResource,
			assertLease: this.options.assertLease,
			onError: this.options.onError,
		});
		this.mouth.start();
		this.clock = new AudioClock({
			intervalMs: 20,
			now: this.now,
			schedule: (callback, delay) => {
				const timer = setTimeout(callback, delay);
				timer.unref?.();
				return timer;
			},
			cancel: (timer) => clearTimeout(timer as NodeJS.Timeout),
			onFire: () => {
				if (!this.stopped) this.uplink?.tick();
			},
			onDropped: (reason, scheduledAt) =>
				this.options.onDiagnostic?.({
					kind: "uplink_clock_dropped",
					reason,
					scheduledAt,
				}),
		});
		this.clock.start();
		const speaking = this.options.deps.speakingEvents(this.connection);
		speaking.on("start", (userId) => this.speakingStart(userId));
		speaking.on("end", (userId) => this.speakingEnd(userId));
		this.unsubscribePresence = this.options.deps.onVoiceStateUpdate(
			client,
			(event) => {
				if (event.userId !== this.options.founderUserId || event.isBot) return;
				if (event.toChannelId === this.options.voiceChannelId) {
					this.options.onFounderPresence(true);
				} else if (event.fromChannelId === this.options.voiceChannelId) {
					this.options.onFounderPresence(false);
				}
			},
		);
		return {
			founderPresent:
				(await this.options.deps.userVoiceChannelId(
					client,
					this.options.guildId,
					this.options.founderUserId,
				)) === this.options.voiceChannelId,
		};
	}

	speaker(): { userId: string; name: string } | null {
		const userId = this.attribution.consumeOwner(this.now());
		return userId ? { userId, name: this.names.get(userId) ?? userId } : null;
	}

	playSpeech(speechId: string, pcm24Mono: Buffer): Promise<void> {
		return (
			this.mouth?.playSpeech(speechId, pcm24Mono) ??
			Promise.reject(new Error("speech_room_not_ready"))
		);
	}

	cancelSpeech(speechId: string): void {
		this.mouth?.cancelSpeech(speechId);
	}

	cancelAllSpeech(): void {
		this.mouth?.cancelAllSpeech();
	}

	setWaiting(waiting: boolean): void {
		this.mouth?.setWaiting(waiting);
	}

	setBedEnabled(enabled: boolean): void {
		this.mouth?.setBedEnabled(enabled);
	}

	async status(text: string): Promise<void> {
		await this.options.deps.sendMessage(
			this.registry.client("voice"),
			this.options.threadId,
			text,
		);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.clearTimer("retry");
		this.clearTimer("stable");
		this.clock?.stop();
		this.uplink?.cancelUtterance();
		this.uplink?.setMicOpen(false);
		this.unsubscribePresence?.();
		this.unsubscribePresence = undefined;
		this.pendingCloseCleanup?.();
		this.pendingCloseCleanup = undefined;
		this.cooldownSpeaker = undefined;
		for (const unsubscribe of this.unsubscribeConnection.splice(0))
			unsubscribe();
		if (this.activeSpeaker) {
			this.uplink?.speakingEnd(this.activeSpeaker);
			this.attribution.speakingEnd(this.activeSpeaker, this.now());
			this.activeSpeaker = undefined;
		}
		if (this.capture) this.disposeCapture(this.capture);
		this.mouth?.stop();
		this.mouth = undefined;
		if (this.connection) this.options.deps.leaveVoice(this.connection);
		this.connection = undefined;
		await this.registry.destroyAll();
		const vad = this.vad;
		this.vad = undefined;
		await vad?.close();
	}

	/**
	 * FLY-2701 review R2: the caller's start deadline and the other branch's
	 * failure both arrive as an abort. Honour it at the same checkpoints that
	 * already handle a local stop — including the one right after `join()`,
	 * where the connection exists but `start()` has not returned yet, so the
	 * caller cannot see anything to clean up.
	 */
	private async checkActive(signal?: AbortSignal): Promise<void> {
		if (this.stopped || signal?.aborted) {
			await this.stop();
			throw new Error(
				signal?.aborted && !this.stopped
					? "voice_room_start_aborted"
					: "voice_room_stopped",
			);
		}
	}

	private speakingStart(userId: string): void {
		if (
			this.stopped ||
			!this.allowed.has(userId) ||
			this.activeSpeaker ||
			this.capture
		)
			return;
		if (this.now() < this.cooldownUntil) {
			this.cooldownSpeaker = userId;
			return;
		}
		if (this.retryTimer) return;
		this.startCapture(userId, false);
	}

	private startCapture(userId: string, retry: boolean): void {
		if (this.stopped || this.capture || !this.allowed.has(userId)) return;
		if (!this.leaseIsActive()) return;
		let opus: NodeJS.ReadableStream | undefined;
		let decoder: NodeJS.ReadWriteStream | undefined;
		try {
			opus = this.options.deps.subscribeManual(this.connection!)(userId);
			decoder = this.options.deps.createDecoder();
		} catch (error) {
			this.destroyStream(opus);
			this.destroyStream(decoder);
			this.options.onError(error as Error);
			return;
		}
		const capture: Capture = {
			generation: ++this.captureGeneration,
			userId,
			opus,
			decoder,
			settled: false,
			pcmBytes: 0,
		};
		this.capture = capture;
		this.activeSpeaker = userId;
		this.attribution.speakingStart(userId, this.now());
		this.uplink?.setMicOpen(true);
		this.uplink?.speakingStart(userId, true);
		this.uplink?.beginUtterance("gated", this.now());
		if (retry) this.receiveHealth.retryAttempt();
		void this.options.deps
			.memberDisplayName(
				this.registry.client("voice"),
				this.options.guildId,
				userId,
			)
			.then((name) => {
				if (!this.isCurrent(capture)) return;
				if (name) this.names.set(userId, name);
			});
		decoder.on("data", (chunk: Buffer) => {
			if (!this.isCurrent(capture) || !this.leaseIsActive(capture)) return;
			capture.pcmBytes += chunk.length;
			if (capture.pcmBytes >= PCM48_STEREO_FRAME_BYTES && capture.watchdog) {
				clearTimeout(capture.watchdog);
				capture.watchdog = undefined;
			}
			while (capture.pcmBytes >= PCM48_STEREO_FRAME_BYTES) {
				capture.pcmBytes -= PCM48_STEREO_FRAME_BYTES;
				const changed = this.receiveHealth.pcmFrame();
				if (changed?.state === "receiving") this.scheduleStableReset();
			}
			this.uplink?.pushPcm48Stereo(userId, chunk);
		});
		opus.on("error", (error: Error) =>
			this.captureFailed(capture, "packet", error),
		);
		decoder.on("error", (error: Error) =>
			this.captureFailed(capture, "decoder", error),
		);
		capture.watchdog = setTimeout(
			() => this.captureNoPcm(capture),
			RECEIVE_NO_PCM_MS,
		);
		capture.watchdog.unref?.();
		try {
			opus.pipe(decoder);
		} catch (error) {
			this.disposeCapture(capture);
			this.options.onError(error as Error);
		}
	}

	private speakingEnd(userId: string): void {
		if (this.cooldownSpeaker === userId) this.cooldownSpeaker = undefined;
		if (this.activeSpeaker !== userId) return;
		this.uplink?.endUtterance(this.now());
		this.uplink?.speakingEnd(userId);
		this.attribution.speakingEnd(userId, this.now());
		this.activeSpeaker = undefined;
		if (this.capture) this.disposeCapture(this.capture);
	}

	private captureFailed(
		capture: Capture,
		channel: "packet" | "decoder",
		error: Error,
	): void {
		if (!this.isCurrent(capture)) return;
		this.clearTimer("stable");
		this.receiveHealth.fail(channel, error);
		this.retireFailedCapture(capture);
	}

	private captureNoPcm(capture: Capture): void {
		if (!this.isCurrent(capture)) return;
		this.clearTimer("stable");
		this.receiveHealth.noPcm();
		this.retireFailedCapture(capture);
	}

	private retireFailedCapture(capture: Capture): void {
		const userId = capture.userId;
		const generation = capture.generation;
		this.pendingCloseCleanup?.();
		let closeObserved = false;
		const cleanupClose = () => {
			capture.opus.removeListener?.("close", onClose);
			if (this.pendingCloseCleanup === cleanupClose)
				this.pendingCloseCleanup = undefined;
		};
		const onClose = () => {
			if (closeObserved) return;
			closeObserved = true;
			cleanupClose();
			this.clearTimer("retry");
			this.scheduleRetry(userId, generation);
		};
		this.pendingCloseCleanup = cleanupClose;
		capture.opus.once?.("close", onClose);
		this.uplink?.cancelUtterance();
		this.uplink?.setMicOpen(false);
		this.uplink?.speakingEnd(userId);
		this.attribution.speakingEnd(userId, this.now());
		this.activeSpeaker = undefined;
		this.disposeCapture(capture);
		if ((capture.opus as { closed?: boolean }).closed) {
			onClose();
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			cleanupClose();
			this.retryAttempts = RECEIVE_RETRY_DELAYS_MS.length;
			this.receiveHealth.exhausted();
			this.scheduleCooldownProbe(userId, generation);
		}, RECEIVE_CLOSE_WAIT_MS);
		this.retryTimer.unref?.();
	}

	private disposeCapture(capture: Capture): void {
		if (capture.settled) return;
		capture.settled = true;
		if (capture.watchdog) clearTimeout(capture.watchdog);
		capture.watchdog = undefined;
		if (this.capture === capture) this.capture = undefined;
		(
			capture.opus as { unpipe?: (destination?: NodeJS.WritableStream) => void }
		).unpipe?.(capture.decoder);
		this.destroyStream(capture.opus);
		this.destroyStream(capture.decoder);
	}

	private scheduleRetry(userId: string, generation: number): void {
		if (
			this.stopped ||
			this.capture ||
			this.retryTimer ||
			generation !== this.captureGeneration
		)
			return;
		if (this.retryAttempts >= RECEIVE_RETRY_DELAYS_MS.length) {
			this.receiveHealth.exhausted();
			this.scheduleCooldownProbe(userId, generation);
			return;
		}
		const delay = RECEIVE_RETRY_DELAYS_MS[this.retryAttempts] ?? 0;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (
				this.stopped ||
				this.capture ||
				generation !== this.captureGeneration ||
				!this.isSpeaking(userId) ||
				!this.leaseIsActive()
			)
				return;
			this.retryAttempts += 1;
			this.startCapture(userId, true);
		}, delay);
		this.retryTimer.unref?.();
	}

	private scheduleCooldownProbe(userId: string, generation: number): void {
		this.cooldownUntil = this.now() + RECEIVE_COOLDOWN_MS;
		this.cooldownSpeaker = userId;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			const probationUserId = this.cooldownSpeaker;
			this.cooldownSpeaker = undefined;
			if (
				!this.stopped &&
				!this.capture &&
				generation === this.captureGeneration &&
				probationUserId !== undefined &&
				this.isSpeaking(probationUserId) &&
				this.leaseIsActive()
			) {
				this.retryAttempts = RECEIVE_RETRY_DELAYS_MS.length;
				this.startCapture(probationUserId, true);
			}
		}, RECEIVE_COOLDOWN_MS);
		this.retryTimer.unref?.();
	}

	private scheduleStableReset(): void {
		this.clearTimer("stable");
		this.stableTimer = setTimeout(() => {
			this.stableTimer = undefined;
			if (this.stopped) return;
			this.retryAttempts = 0;
			this.cooldownUntil = 0;
			this.cooldownSpeaker = undefined;
		}, RECEIVE_COOLDOWN_MS);
		this.stableTimer.unref?.();
	}

	private isCurrent(capture: Capture): boolean {
		return !this.stopped && this.capture === capture && !capture.settled;
	}

	private isSpeaking(userId: string): boolean {
		return this.isUserSpeaking?.(userId) ?? false;
	}

	private leaseIsActive(capture?: Capture): boolean {
		try {
			this.options.assertLease?.();
			return true;
		} catch {
			if (capture && this.isCurrent(capture)) {
				this.uplink?.cancelUtterance();
				this.uplink?.setMicOpen(false);
				this.uplink?.speakingEnd(capture.userId);
				this.attribution.speakingEnd(capture.userId, this.now());
				this.activeSpeaker = undefined;
				this.disposeCapture(capture);
			}
			if (!this.stopped) this.options.onError(new Error("voice_lease_fenced"));
			return false;
		}
	}

	private subscribeConnectionDiagnostics(): void {
		const connection = this.connection;
		if (!connection) return;
		const receiveEvents = this.options.deps.receiveEvents?.(connection);
		if (receiveEvents) {
			this.isUserSpeaking = (userId) => receiveEvents.isSpeaking(userId);
			this.unsubscribeConnection.push(
				receiveEvents.onTransition((transitionId) =>
					this.options.onDiagnostic?.({
						kind: "discord_dave_transitioned",
						transitionId,
					}),
				),
				receiveEvents.onDiagnostic((event) => this.receiveDiagnostic(event)),
			);
		}
		const handle = this.options.deps.voiceConnHandle?.(connection);
		if (handle) {
			this.unsubscribeConnection.push(
				handle.onStateChange((from, to) =>
					this.options.onDiagnostic?.({
						kind: "discord_connection_state",
						from,
						to,
					}),
				),
				handle.onError((error) => {
					if (!this.stopped) this.options.onError(error);
				}),
			);
		}
	}

	private destroyStream(
		stream: NodeJS.ReadableStream | NodeJS.ReadWriteStream | undefined,
	): void {
		const candidate = stream as
			| { destroy?: () => void; destroyed?: boolean }
			| undefined;
		if (candidate && !candidate.destroyed) candidate.destroy?.();
	}

	private receiveDiagnostic(event: DiscordReceiveDiagnostic): void {
		if (event.kind === "unknown") {
			this.unknownDiagnosticCount = Math.min(
				Number.MAX_SAFE_INTEGER,
				this.unknownDiagnosticCount + 1,
			);
			this.options.onDiagnostic?.({
				kind: "discord_dave_diagnostic_unknown",
				unknownDiagnosticCount: this.unknownDiagnosticCount,
			});
			return;
		}
		const { kind: diagnosticKind, ...fields } = event;
		this.options.onDiagnostic?.({
			kind: "discord_dave_diagnostic",
			diagnosticKind,
			...fields,
		});
	}

	private clearTimer(which: "retry" | "stable"): void {
		const timer = which === "retry" ? this.retryTimer : this.stableTimer;
		if (timer) clearTimeout(timer);
		if (which === "retry") this.retryTimer = undefined;
		else this.stableTimer = undefined;
	}
}
