/**
 * EdgeTtsBackend — the announce face (plan.md r2 §4 step 3). A Lead "speaks":
 * reads a report / standup. Speech-out only (announce=true, converse=false).
 * The TtsEngine (edge-tts) is itself pluggable (Azure fallback slot).
 */
import { randomUUID } from "node:crypto";
import type { AudioPlayer, Playback } from "../../audio/FilePlayer.js";
import { mapProcessError } from "../../errors.js";
import {
	type AnnouncerOptions,
	type AnnouncerSession,
	type SpeakResult,
	type TranscriptSink,
	type TtsEngine,
	type VoiceBackend,
	type VoiceBackendCapabilities,
	VoiceError,
	type VoiceRef,
} from "../../types.js";

const EDGE_TTS_CAPABILITIES: VoiceBackendCapabilities = {
	announce: true,
	converse: false,
	bargeIn: false,
	toolCallScheduling: "none",
	transcriptGranularity: "final-only",
	supportsResume: false,
	voiceCloning: false,
	audioOut: [{ encoding: "mp3", sampleRateHz: 24_000, channels: 1 }],
};

export interface EdgeTtsBackendOptions {
	tts: TtsEngine;
	player: AudioPlayer;
	defaultVoice: string;
	now?: () => number;
}

export class EdgeTtsBackend implements VoiceBackend {
	readonly id = "edge-tts";
	readonly capabilities = EDGE_TTS_CAPABILITIES;

	constructor(private readonly opts: EdgeTtsBackendOptions) {}

	async createAnnouncer(opts: AnnouncerOptions): Promise<AnnouncerSession> {
		return new EdgeTtsAnnouncerSession(
			this.id,
			this.opts.tts,
			this.opts.player,
			opts.voice ?? this.opts.defaultVoice,
			opts.transcriptSink,
			this.opts.now ?? Date.now,
		);
	}
}

interface Pending {
	text: string;
	signal?: AbortSignal;
	resolve: (r: SpeakResult) => void;
	reject: (e: unknown) => void;
}

/**
 * AnnouncerSession — serial speak queue. Each speak() synthesizes then plays,
 * in order. interrupt() (or a per-speak AbortSignal) kills the current playback
 * + in-flight TTS and, for interrupt(), rejects every queued speak (clear queue).
 */
class EdgeTtsAnnouncerSession implements AnnouncerSession {
	readonly sessionId = randomUUID();
	private readonly pending: Pending[] = [];
	private running = false;
	private closed = false;
	private currentAbort?: AbortController;
	private currentPlayback?: Playback;

	constructor(
		private readonly backendId: string,
		private readonly tts: TtsEngine,
		private readonly player: AudioPlayer,
		private readonly voice: VoiceRef,
		private readonly sink: TranscriptSink | undefined,
		private readonly now: () => number,
	) {}

	speak(
		text: string,
		opts: { signal?: AbortSignal } = {},
	): Promise<SpeakResult> {
		if (this.closed) {
			return Promise.reject(
				new VoiceError("backend-protocol", "announcer closed"),
			);
		}
		if (!text.trim()) {
			return Promise.reject(
				new VoiceError("subprocess-failed", "announcer: empty text"),
			);
		}
		return new Promise<SpeakResult>((resolve, reject) => {
			this.pending.push({ text, signal: opts.signal, resolve, reject });
			void this.drain();
		});
	}

	interrupt(): void {
		this.currentAbort?.abort();
		this.currentPlayback?.interrupt();
		const dropped = this.pending.splice(0);
		for (const d of dropped) {
			d.reject(new VoiceError("cancelled", "announcer interrupted"));
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.interrupt();
	}

	private async drain(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (this.pending.length > 0) {
				const item = this.pending.shift() as Pending;
				try {
					item.resolve(await this.runSpeak(item.text, item.signal));
				} catch (err) {
					item.reject(err);
				}
			}
		} finally {
			this.running = false;
		}
	}

	private async runSpeak(
		text: string,
		extSignal?: AbortSignal,
	): Promise<SpeakResult> {
		const ac = new AbortController();
		this.currentAbort = ac;
		const onExt = () => ac.abort();
		if (extSignal) {
			if (extSignal.aborted) ac.abort();
			else extSignal.addEventListener("abort", onExt);
		}
		try {
			if (ac.signal.aborted)
				throw new VoiceError("cancelled", "announcer cancelled before synth");
			// Honest end-to-end "first response" anchor: measure from the moment
			// this utterance starts being processed (synth begins) until sound
			// actually starts playing. This MUST include the TTS synth wait — the
			// founder cannot hear anything before synthesis finishes. Reading the
			// player's local spawn metric alone (Playback.spawnMs) omits that wait
			// and lies about perceived latency (FLY-543 QA regression).
			const speakStart = this.now();
			const { audio, format, ttsFirstByteMs } = await this.tts.synthesize(
				text,
				this.voice,
				{
					signal: ac.signal,
				},
			);
			if (ac.signal.aborted)
				throw new VoiceError("cancelled", "announcer cancelled after synth");
			const playback = this.player.play(audio, format);
			this.currentPlayback = playback;
			const playStart = this.now();
			const playbackStartMs = playStart - speakStart;
			const { interrupted } = await playback.done;
			this.currentPlayback = undefined;
			if (interrupted)
				throw new VoiceError("cancelled", "announcer playback interrupted");
			const durationMs = this.now() - playStart;
			this.sink?.append({
				ts: new Date().toISOString(),
				sessionId: this.sessionId,
				backendId: this.backendId,
				face: "announce",
				role: "assistant",
				text,
				final: true,
			});
			return {
				ttsFirstByteMs,
				playbackStartMs,
				durationMs,
			};
		} catch (err) {
			throw err instanceof VoiceError
				? err
				: mapProcessError(err, "edge-tts announcer");
		} finally {
			if (extSignal) extSignal.removeEventListener("abort", onExt);
			this.currentAbort = undefined;
		}
	}
}
