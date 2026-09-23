import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type {
	AudioFormat,
	AudibleTailEstimate,
	FrameReceipt,
	ReceiveHealth,
	RoomAudioFrame,
	RoomAudioOwner,
	RoomBargeInEvent,
	RoomIO as RoomIOContract,
	RoomIOIdentity,
	RoomPresence,
	SpeechFrame,
	SpeechStart,
	SpeechStartReceipt,
	SubmittedReceipt,
} from "flywheel-voice-core";
import { BotRegistry, type RegistryClientLike } from "../bots/BotRegistry.js";
import type {
	DiscordDeps,
	DiscordReceiveDiagnostic,
} from "../bots/discordWiring.js";
import { AudioClock } from "./audio/AudioClock.js";
import { Downmix48to24, WaitingMouth } from "./audio.js";
import {
	createInitialSileroState,
	type SileroState,
	SileroVad,
} from "./pipeline/SileroVad.js";
import { Uplink } from "./pipeline/Uplink.js";
import { UplinkSpeechGate } from "./pipeline/UplinkSpeechGate.js";
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
> &
	Partial<Pick<DiscordDeps, "voiceChannelHumanCount">>;

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

export interface RoomIOOptions {
	sessionId: string;
	generation: number;
	roomKey: string;
	buildSha?: string | null;
	instanceId?: string;
	implementationDigest?: string;
	allowedClipPaths?: readonly string[];
	maxOutputQueueFrames?: number;
	/** Local transport cushion used only by audibleTail (estimated). */
	playbackTailMarginMs?: number;
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
	onAudio?(frame: Buffer, metadata: RoomAudioOwner): void;
	onFounderPresence?(present: boolean): void;
	onFrame?(frame: RoomAudioFrame): void;
	onPresence?(presence: RoomPresence): void;
	onReceiveHealth?(snapshot: ReceiveHealth): void;
	onBargeIn?(event: RoomBargeInEvent): void;
	onError(error: Error): void;
	assertLease?(): void;
	now?: () => number;
}

export const ROOM_IO_VERSION = 1 as const;
export const ROOM_IO_IMPLEMENTATION_KEY =
	"flywheel-voice-bridge/room/RoomIO#createRoomIO" as const;
const ROOM_IO_MODULE_EXTENSION = extname(fileURLToPath(import.meta.url));
const ROOM_IO_CLOSURE = [
	{
		path: "models/silero_vad.onnx",
		url: new URL("../../models/silero_vad.onnx", import.meta.url),
	},
	{
		path: "src/audio/resample",
		url: new URL(`../audio/resample${ROOM_IO_MODULE_EXTENSION}`, import.meta.url),
	},
	{
		path: "src/bots/BotRegistry",
		url: new URL(`../bots/BotRegistry${ROOM_IO_MODULE_EXTENSION}`, import.meta.url),
	},
	...[
		"RoomIO",
		"audio",
		"audio/AudioClock",
		"audio/FrameQueue",
		"audio/JitterBuffer",
		"audio/Resample",
		"audio/Silence",
		"pipeline/SileroVad",
		"pipeline/Uplink",
		"pipeline/UplinkSpeechGate",
		"receive-health",
		"speaker-attribution",
	].map((modulePath) => ({
		path: `src/room/${modulePath}`,
		url: new URL(`./${modulePath}${ROOM_IO_MODULE_EXTENSION}`, import.meta.url),
	})),
].sort((left, right) =>
	left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
);

export const ROOM_IO_IMPLEMENTATION_MANIFEST = Object.freeze(
	ROOM_IO_CLOSURE.map(({ path, url }) => ({
		path,
		sha256: createHash("sha256").update(readFileSync(url)).digest("hex"),
	})),
);
export const ROOM_IO_IMPLEMENTATION_DIGEST = (() => {
	const hash = createHash("sha256").update(
		`${ROOM_IO_IMPLEMENTATION_KEY}\0${ROOM_IO_VERSION}\0`,
	);
	for (const entry of ROOM_IO_IMPLEMENTATION_MANIFEST)
		hash.update(entry.path).update("\0").update(entry.sha256).update("\0");
	return hash.digest("hex");
})();

export class BridgeRoomIO implements RoomIOContract {
	readonly identity: RoomIOIdentity;
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
	private captureSequence = 0;
	private retryAttempts = 0;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private stableTimer?: ReturnType<typeof setTimeout>;
	private pendingCloseCleanup?: () => void;
	private isUserSpeaking?: (userId: string) => boolean;
	private cooldownUntil = 0;
	private cooldownSpeaker?: string;
	private unknownDiagnosticCount = 0;
	private stopped = false;
	private speech?: {
		speechId: string;
		generation: number;
		format: AudioFormat;
		nextSequence: number;
		pcm24Bytes: number;
		convert(chunk: Buffer): Buffer;
	};
	private tailUntil = 0;
	private clipActive = false;
	private clipSpeechId?: string;
	private activeBarge?: {
		utteranceId: string;
		owner: RoomBargeInEvent["owner"];
		startedAt: number;
	};
	private readonly frameListeners = new Set<(frame: RoomAudioFrame) => void>();
	private readonly presenceListeners = new Set<
		(presence: RoomPresence) => void
	>();
	private readonly receiveHealthListeners = new Set<
		(snapshot: ReceiveHealth) => void
	>();
	private readonly bargeInListeners = new Set<
		(event: RoomBargeInEvent) => void
	>();

	constructor(private readonly options: RoomIOOptions) {
		if (!options.sessionId || !Number.isSafeInteger(options.generation)) {
			throw new Error("room_io_identity_invalid");
		}
		const instanceId = options.instanceId ?? randomUUID();
		this.identity = {
			moduleExport: ROOM_IO_IMPLEMENTATION_KEY,
			roomIOVersion: ROOM_IO_VERSION,
			implementationDigest:
				options.implementationDigest ?? ROOM_IO_IMPLEMENTATION_DIGEST,
			buildSha: options.buildSha ?? null,
			instanceId,
			sessionId: options.sessionId,
			roomKey: options.roomKey,
			generation: options.generation,
			inputRouteInstanceId: instanceId,
			outputRouteInstanceId: instanceId,
		};
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
				this.emitReceiveHealth(snapshot);
				this.options.onDiagnostic?.({
					kind: "discord_receive_health",
					...snapshot,
				});
			},
		});
	}

	onFrame(listener: (frame: RoomAudioFrame) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	onPresence(listener: (presence: RoomPresence) => void): () => void {
		this.presenceListeners.add(listener);
		return () => this.presenceListeners.delete(listener);
	}

	onReceiveHealth(listener: (snapshot: ReceiveHealth) => void): () => void {
		this.receiveHealthListeners.add(listener);
		return () => this.receiveHealthListeners.delete(listener);
	}

	onBargeIn(listener: (event: RoomBargeInEvent) => void): () => void {
		this.bargeInListeners.add(listener);
		return () => this.bargeInListeners.delete(listener);
	}

	async start(signal?: AbortSignal): Promise<{
		founderPresent: boolean;
		humanCount: number;
	}> {
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
	): Promise<{ founderPresent: boolean; humanCount: number }> {
		this.vad = await (
			this.options.createVad ??
			(() =>
				SileroVad.create(
					fileURLToPath(
						new URL("../../models/silero_vad.onnx", import.meta.url),
					),
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
			onOpened: ({ openAtMs }) => this.startBargeObservation(openAtMs),
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
				const owner: RoomAudioOwner = {
					...metadata,
					ownerName: metadata.ownerUserId
						? (this.names.get(metadata.ownerUserId) ?? metadata.ownerUserId)
						: null,
				};
				this.options.onAudio?.(frame, owner);
				this.emitFrame({
					pcm: Buffer.from(frame),
					format: {
						encoding: "pcm16",
						sampleRateHz: 24_000,
						channels: 1,
					},
					sessionId: this.options.sessionId,
					generation: this.options.generation,
					sequence: this.captureSequence++,
					capturedAt: this.now(),
					utteranceId: owner.utteranceId,
					attribution: owner.ownerUserId
						? {
								kind: "known",
								speakerUserId: owner.ownerUserId,
								speakerName: owner.ownerName,
							}
						: { kind: "unknown", reason: "no_active_speaker" },
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
		this.emitReceiveHealth(this.receiveHealth.current());
		const player = this.options.deps.createPlayer(this.connection);
		this.mouth = new WaitingMouth({
			player,
			createResource: this.options.deps.createResource,
			assertLease: this.options.assertLease,
			onError: this.options.onError,
			maxQueueFrames: this.options.maxOutputQueueFrames,
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
				if (!this.stopped) {
					this.uplink?.tick();
					this.emitBargeObservation("sustained");
				}
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
					this.options.onFounderPresence?.(true);
					void this.emitPresence(true);
				} else if (event.fromChannelId === this.options.voiceChannelId) {
					this.options.onFounderPresence?.(false);
					void this.emitPresence(false);
				}
			},
		);
		const founderPresent =
			(await this.options.deps.userVoiceChannelId(
					client,
					this.options.guildId,
					this.options.founderUserId,
				)) === this.options.voiceChannelId;
		const humanCount =
			(await this.options.deps.voiceChannelHumanCount?.(
					client,
					this.options.guildId,
					this.options.voiceChannelId,
				)) ?? (founderPresent ? 1 : 0);
		const presence = { founderPresent, humanCount };
		this.emitPresenceSnapshot(presence);
		return presence;
	}

	speaker(): { userId: string; name: string } | null {
		const userId = this.attribution.consumeOwner(this.now());
		return userId ? { userId, name: this.names.get(userId) ?? userId } : null;
	}

	startSpeech(input: SpeechStart): SpeechStartReceipt {
		const reason = this.validateSpeechStart(input);
		if (reason) {
			return {
				outcome: "rejected",
				speechId: input.speechId,
				generation: input.generation,
				reason,
			};
		}
		try {
			this.mouth!.beginSpeech(input.speechId);
		} catch (error) {
			return {
				outcome: "rejected",
				speechId: input.speechId,
				generation: input.generation,
				reason: (error as Error).message,
			};
		}
		this.speech = {
			...input,
			nextSequence: 0,
			pcm24Bytes: 0,
			convert: this.createSpeechConverter(input.format),
		};
		return {
			outcome: "accepted",
			speechId: input.speechId,
			generation: input.generation,
		};
	}

	async writeSpeech(frame: SpeechFrame): Promise<FrameReceipt> {
		const active = this.speech;
		let reason: string | undefined;
		if (!active) reason = "speech_not_started";
		else if (
			frame.speechId !== active.speechId ||
			frame.generation !== active.generation
		)
			reason = "speech_identity_mismatch";
		else if (frame.sequence !== active.nextSequence)
			reason = "speech_sequence_invalid";
		else if (
			frame.pcm.length === 0 ||
			frame.pcm.length % (2 * active.format.channels) !== 0
		)
			reason = "speech_frame_invalid";
		if (reason) {
			return {
				outcome: "rejected",
				speechId: frame.speechId,
				generation: frame.generation,
				sequence: frame.sequence,
				reason,
			};
		}
		const pcm24Mono = active!.convert(frame.pcm);
		active!.nextSequence += 1;
		try {
			if (pcm24Mono.length > 0)
				await this.mouth!.writeSpeech(frame.speechId, pcm24Mono);
			active!.pcm24Bytes += pcm24Mono.length;
			return {
				outcome: "submitted",
				speechId: frame.speechId,
				generation: frame.generation,
				sequence: frame.sequence,
			};
		} catch (error) {
			return {
				outcome: "rejected",
				speechId: frame.speechId,
				generation: frame.generation,
				sequence: frame.sequence,
				reason: (error as Error).message,
			};
		}
	}

	async endSpeech(
		speechId: string,
		generation: number,
	): Promise<SubmittedReceipt> {
		const active = this.speech;
		if (
			!active ||
			active.speechId !== speechId ||
			active.generation !== generation
		) {
			return {
				outcome: "rejected",
				speechId,
				generation,
				reason: "speech_identity_mismatch",
			};
		}
		this.speech = undefined;
		this.tailUntil = Math.max(
			this.tailUntil,
			this.now() +
				Math.ceil((active.pcm24Bytes / 2 / 24_000) * 1_000) +
				this.playbackTailMarginMs(),
		);
		try {
			await this.mouth!.endSpeech(speechId);
			return { outcome: "submitted", speechId, generation };
		} catch (error) {
			return {
				outcome: "rejected",
				speechId,
				generation,
				reason: (error as Error).message,
			};
		}
	}

	async playSpeech(
		input: SpeechStart & { pcm: Buffer },
	): Promise<SubmittedReceipt> {
		const started = this.startSpeech(input);
		if (started.outcome === "rejected") return started;
		const frame = await this.writeSpeech({
			speechId: input.speechId,
			generation: input.generation,
			sequence: 0,
			pcm: input.pcm,
		});
		if (frame.outcome === "rejected") return frame;
		return this.endSpeech(input.speechId, input.generation);
	}

	async playClip(input: {
		speechId: string;
		generation: number;
		source:
			| { kind: "file"; path: string }
			| { kind: "encoded"; bytes: Buffer; format: "wav" | "mp3" };
		priority: "cue" | "speech";
	}): Promise<SubmittedReceipt> {
		let reason: string | undefined;
		if (!input.speechId) reason = "speech_id_required";
		else if (input.generation !== this.options.generation)
			reason = "speech_generation_stale";
		else if (!this.mouth) reason = "speech_room_not_ready";
		else if (this.speech || this.clipActive) reason = "speech_busy";
		else if (!this.audibleTail().drained) reason = "audible_tail_not_drained";
		else if (
			input.source.kind === "file" &&
			!this.options.allowedClipPaths?.includes(input.source.path)
		)
			reason = "clip_path_not_managed";
		if (reason) {
			return {
				outcome: "rejected",
				speechId: input.speechId,
				generation: input.generation,
				reason,
			};
		}
		const resource = this.options.deps.createResource(
			input.source.kind === "file"
				? input.source
				: { kind: "stream", stream: Readable.from(input.source.bytes) },
		);
		this.clipActive = true;
		this.clipSpeechId = input.speechId;
		try {
			await this.mouth!.playClip(input.speechId, resource);
			this.tailUntil = Math.max(
				this.tailUntil,
				this.now() + this.playbackTailMarginMs(),
			);
			return {
				outcome: "submitted",
				speechId: input.speechId,
				generation: input.generation,
			};
		} catch (error) {
			return {
				outcome: "rejected",
				speechId: input.speechId,
				generation: input.generation,
				reason: (error as Error).message,
			};
		} finally {
			this.clipActive = false;
			if (this.clipSpeechId === input.speechId) this.clipSpeechId = undefined;
		}
	}

	localPlaybackCancel(speechId: string, generation: number): void {
		if (generation !== this.options.generation) return;
		if (this.speech?.speechId === speechId) {
			this.speech = undefined;
			this.tailUntil = Math.max(
				this.tailUntil,
				this.now() + this.playbackTailMarginMs(),
			);
		}
		if (this.clipSpeechId === speechId) {
			this.tailUntil = Math.max(
				this.tailUntil,
				this.now() + this.playbackTailMarginMs(),
			);
		}
		this.mouth?.cancelSpeech(speechId);
	}

	audibleTail(): AudibleTailEstimate {
		const remainingMs = this.clipActive
			? null
			: Math.max(0, this.tailUntil - this.now());
		return {
			estimated: true,
			remainingMs,
			drained: remainingMs === 0 && !this.speech && !this.clipActive,
			observedAt: this.now(),
			sessionId: this.options.sessionId,
			generation: this.options.generation,
		};
	}

	/** Legacy name retained while voice-codex consumers move to RoomIO. */
	cancelSpeech(speechId: string): void {
		this.localPlaybackCancel(speechId, this.options.generation);
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
		this.emitBargeObservation("end");
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
		this.emitBargeObservation("end");
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
		this.emitBargeObservation("end");
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

	private async emitPresence(founderPresent: boolean): Promise<void> {
		try {
			const humanCount =
				(await this.options.deps.voiceChannelHumanCount?.(
					this.registry.client("voice"),
					this.options.guildId,
					this.options.voiceChannelId,
				)) ?? (founderPresent ? 1 : 0);
			this.emitPresenceSnapshot({ founderPresent, humanCount });
		} catch (error) {
			this.options.onError(error as Error);
		}
	}

	private startBargeObservation(startedAt: number): void {
		const utteranceId = this.uplink?.utteranceId;
		const ownerUserId = this.uplink?.owner;
		if (!utteranceId || this.activeBarge) return;
		this.activeBarge = {
			utteranceId,
			owner: ownerUserId
				? {
						kind: "known",
						speakerUserId: ownerUserId,
						speakerName: this.names.get(ownerUserId) ?? ownerUserId,
					}
				: { kind: "unknown", reason: "no_active_speaker" },
			startedAt,
		};
		this.emitBargeObservation("start");
	}

	private emitBargeObservation(
		phase: RoomBargeInEvent["phase"],
	): void {
		const active = this.activeBarge;
		if (!active) return;
		const observedAt = this.now();
		const event: RoomBargeInEvent = {
			sessionId: this.options.sessionId,
			generation: this.options.generation,
			utteranceId: active.utteranceId,
			owner: active.owner,
			startedAt: active.startedAt,
			observedAt,
			durationMs: Math.max(0, observedAt - active.startedAt),
			phase,
		};
		this.options.onBargeIn?.(event);
		for (const listener of this.bargeInListeners) listener(event);
		if (phase === "end") this.activeBarge = undefined;
	}

	private emitFrame(frame: RoomAudioFrame): void {
		this.options.onFrame?.(frame);
		for (const listener of this.frameListeners) listener(frame);
	}

	private emitPresenceSnapshot(presence: RoomPresence): void {
		this.options.onPresence?.(presence);
		for (const listener of this.presenceListeners) listener(presence);
	}

	private emitReceiveHealth(snapshot: ReceiveHealth): void {
		this.options.onReceiveHealth?.(snapshot);
		for (const listener of this.receiveHealthListeners) listener(snapshot);
	}

	private validateSpeechStart(input: SpeechStart): string | undefined {
		if (!input.speechId) return "speech_id_required";
		if (input.generation !== this.options.generation)
			return "speech_generation_stale";
		if (this.speech) return "speech_busy";
		if (
			input.format.encoding !== "pcm16" ||
			!((input.format.sampleRateHz === 16_000 && input.format.channels === 1) ||
				(input.format.sampleRateHz === 24_000 && input.format.channels === 1) ||
				(input.format.sampleRateHz === 48_000 && input.format.channels === 2))
		)
			return "speech_format_unsupported";
		return undefined;
	}

	private playbackTailMarginMs(): number {
		return Math.max(0, this.options.playbackTailMarginMs ?? 100);
	}

	private toPcm24Mono(input: Buffer, format: AudioFormat): Buffer {
		if (input.length === 0) return input;
		if (format.sampleRateHz === 24_000 && format.channels === 1) return input;
		if (format.sampleRateHz === 48_000 && format.channels === 2) {
			const output = Buffer.alloc(Math.floor(input.length / 8) * 2);
			for (
				let source = 0, target = 0;
				source + 7 < input.length;
				source += 8, target += 2
			) {
				const sum =
					input.readInt16LE(source) +
					input.readInt16LE(source + 2) +
					input.readInt16LE(source + 4) +
					input.readInt16LE(source + 6);
				output.writeInt16LE(Math.trunc(sum / 4), target);
			}
			return output;
		}
		const samples = input.length / 2;
		const outputSamples = Math.floor((samples * 3) / 2);
		const output = Buffer.alloc(outputSamples * 2);
		for (let index = 0; index < outputSamples; index += 1) {
			const sourcePosition = (index * 2) / 3;
			const lower = Math.floor(sourcePosition);
			const upper = Math.min(samples - 1, lower + 1);
			const fraction = sourcePosition - lower;
			const value = Math.round(
				input.readInt16LE(lower * 2) * (1 - fraction) +
					input.readInt16LE(upper * 2) * fraction,
			);
			output.writeInt16LE(value, index * 2);
		}
		return output;
	}

	private createSpeechConverter(format: AudioFormat): (input: Buffer) => Buffer {
		if (format.sampleRateHz === 48_000 && format.channels === 2) {
			const converter = new Downmix48to24();
			return (input) => converter.push(input);
		}
		return (input) => this.toPcm24Mono(input, format);
	}

	private clearTimer(which: "retry" | "stable"): void {
		const timer = which === "retry" ? this.retryTimer : this.stableTimer;
		if (timer) clearTimeout(timer);
		if (which === "retry") this.retryTimer = undefined;
		else this.stableTimer = undefined;
	}
}

export function createRoomIO(options: RoomIOOptions): BridgeRoomIO {
	return new BridgeRoomIO(options);
}
