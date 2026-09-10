import { fileURLToPath } from "node:url";
import {
	BotRegistry,
	type DiscordDeps,
	type RegistryClientLike,
} from "flywheel-voice-bridge";
import { AudioClock } from "./audio/AudioClock.js";
import { WaitingMouth } from "./audio.js";
import {
	createInitialSileroState,
	type SileroState,
	SileroVad,
} from "./pipeline/SileroVad.js";
import { Uplink } from "./pipeline/Uplink.js";
import { UplinkSpeechGate } from "./pipeline/UplinkSpeechGate.js";
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
>;

type VoiceClient = RegistryClientLike & { user?: { id?: string } };
type Capture = {
	opus: NodeJS.ReadableStream;
	decoder: NodeJS.ReadWriteStream;
};

export interface DiscordVoiceRoomOptions {
	createVad?(): Promise<Pick<SileroVad, "score" | "close">>;
	onDiagnostic?(record: Record<string, unknown>): void;
	deps: RoomDeps;
	token: string;
	guildId: string;
	voiceChannelId: string;
	threadId: string;
	founderUserId: string;
	qaAllowUserIds: string[];
	onAudio(frame: Buffer): void;
	onFounderPresence(present: boolean): void;
	onError(error: Error): void;
	now?: () => number;
}

export class DiscordVoiceRoom {
	private readonly registry: BotRegistry<VoiceClient, unknown>;
	private readonly allowed: Set<string>;
	private readonly names = new Map<string, string>();
	private readonly now: () => number;
	private readonly attribution: SpeakerAttribution;
	private connection?: unknown;
	private unsubscribePresence?: () => void;
	private capture?: Capture;
	private activeSpeaker?: string;
	private mouth?: WaitingMouth;
	private vad?: Pick<SileroVad, "score" | "close">;
	private uplink?: Uplink;
	private clock?: AudioClock;
	private stopped = false;

	constructor(private readonly options: DiscordVoiceRoomOptions) {
		this.registry = new BotRegistry<VoiceClient, unknown>({
			createClient: options.deps.createClient as () => VoiceClient,
			joinVoice: options.deps.joinVoice,
		});
		this.allowed = new Set([options.founderUserId, ...options.qaAllowUserIds]);
		this.now = options.now ?? Date.now;
		this.attribution = new SpeakerAttribution();
	}

	async start(): Promise<{ founderPresent: boolean }> {
		this.vad = await (
			this.options.createVad ??
			(() =>
				SileroVad.create(
					fileURLToPath(new URL("../models/silero_vad.onnx", import.meta.url)),
				))
		)();
		await this.checkActive();
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
			appendAudio: (frame) => {
				this.options.onAudio(frame);
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
		await this.checkActive();
		const client = this.registry.client("voice");
		this.connection = await this.registry.join("voice", {
			guildId: this.options.guildId,
			channelId: this.options.voiceChannelId,
			selfMute: false,
			selfDeaf: false,
		});
		await this.checkActive();
		const player = this.options.deps.createPlayer(this.connection);
		this.mouth = new WaitingMouth({
			player,
			createResource: this.options.deps.createResource,
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

	feedOutputAudio(frame: Buffer): void {
		this.mouth?.feed(frame);
	}

	finishOutputAudio(): void {
		this.mouth?.finish();
	}

	flushOutputAudio(): void {
		this.mouth?.flush();
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
		this.clock?.stop();
		this.uplink?.setMicOpen(false);
		this.unsubscribePresence?.();
		this.unsubscribePresence = undefined;
		this.closeCapture();
		this.mouth?.stop();
		this.mouth = undefined;
		if (this.connection) this.options.deps.leaveVoice(this.connection);
		this.connection = undefined;
		await this.registry.destroyAll();
		const vad = this.vad;
		this.vad = undefined;
		await vad?.close();
	}

	private async checkActive(): Promise<void> {
		if (this.stopped) {
			await this.stop();
			throw new Error("voice_room_stopped");
		}
	}

	private speakingStart(userId: string): void {
		if (this.stopped || !this.allowed.has(userId) || this.activeSpeaker) return;
		this.activeSpeaker = userId;
		this.attribution.speakingStart(userId, this.now());
		this.uplink?.speakingStart(userId, true);
		this.uplink?.beginUtterance("gated", this.now());
		void this.options.deps
			.memberDisplayName(
				this.registry.client("voice"),
				this.options.guildId,
				userId,
			)
			.then((name) => {
				if (name) this.names.set(userId, name);
			});
		const opus = this.options.deps.subscribeManual(this.connection!)(userId);
		const decoder = this.options.deps.createDecoder();
		decoder.on("data", (chunk: Buffer) => {
			if (!this.stopped) this.uplink?.pushPcm48Stereo(userId, chunk);
		});
		const fail = (error: Error) => {
			this.closeCapture();
			this.options.onError(error);
		};
		opus.on("error", fail);
		decoder.on("error", fail);
		opus.pipe(decoder);
		this.capture = { opus, decoder };
	}

	private speakingEnd(userId: string): void {
		if (this.activeSpeaker !== userId) return;
		this.uplink?.endUtterance(this.now());
		this.uplink?.speakingEnd(userId);
		this.attribution.speakingEnd(userId, this.now());
		this.activeSpeaker = undefined;
		this.closeCapture();
	}

	private closeCapture(): void {
		const capture = this.capture;
		this.capture = undefined;
		for (const stream of capture ? [capture.opus, capture.decoder] : []) {
			const candidate = stream as { destroy?: () => void; destroyed?: boolean };
			if (!candidate.destroyed) candidate.destroy?.();
		}
	}
}
