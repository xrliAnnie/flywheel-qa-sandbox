import { FrameQueue } from "../audio/FrameQueue.js";
import { JitterBuffer } from "../audio/JitterBuffer.js";
import { Downmix48to24 } from "../audio/Resample.js";
import { PCM24_MONO_SILENCE } from "../audio/Silence.js";
import type {
	UplinkGateMode,
	UplinkGateSummary,
	UplinkSpeechGate,
} from "./UplinkSpeechGate.js";

const PCM48_STEREO_FRAME_BYTES = 3_840;

type AppendOutcome =
	| "sent"
	| "sent:need-drain"
	| "dropped:backpressure"
	| "dropped:stale-generation"
	| "dropped:closed";

interface UplinkOptions {
	appendAudio(frame: Buffer, sessionGeneration: number): AppendOutcome;
	sessionGeneration: number;
	prebufferFrames: number;
	maxQueueFrames: number;
	record(row: { direction: "uplink"; outcome: AppendOutcome }): void;
	now?: () => number;
	onVoiceFrame?(frame: Buffer, atMs: number): void;
	speechGate?: Pick<
		UplinkSpeechGate,
		"begin" | "push" | "end" | "cancel" | "takeDue" | "takeCompleted"
	>;
	onGateSummary?(summary: UplinkGateSummary): void;
}

export class Uplink {
	private activeOwner: string | null = null;
	private downmix = new Downmix48to24();
	private readonly voiceFrames = new FrameQueue(PCM48_STEREO_FRAME_BYTES);
	private readonly frames = new FrameQueue(PCM24_MONO_SILENCE.length);
	private readonly jitter: JitterBuffer;
	private micOpen = true;
	private activeGateMode: UplinkGateMode | null = null;
	droppedOtherSpeaker = 0;
	droppedUnauthorized = 0;
	droppedMuted = 0;

	constructor(private readonly options: UplinkOptions) {
		this.jitter = new JitterBuffer({
			frameBytes: PCM24_MONO_SILENCE.length,
			prebufferFrames: options.prebufferFrames,
			maxFrames: options.maxQueueFrames,
		});
	}

	get owner(): string | null {
		return this.activeOwner;
	}

	get droppedOverflow(): number {
		return this.jitter.droppedOverflow;
	}

	beginUtterance(mode: UplinkGateMode, atMs: number): void {
		this.activeGateMode = mode;
		this.options.speechGate?.begin(mode, atMs);
		this.drainSpeechGate(atMs);
	}

	endUtterance(atMs: number): void {
		this.options.speechGate?.end(atMs);
		this.drainSpeechGate(atMs);
		this.activeGateMode = null;
	}

	speakingStart(userId: string, authorized: boolean): void {
		if (!authorized) {
			this.droppedUnauthorized += 1;
			return;
		}
		if (this.activeOwner === null) {
			this.activeOwner = userId;
			this.downmix = new Downmix48to24();
			this.voiceFrames.flush();
			this.frames.flush();
		}
	}

	speakingEnd(userId: string): void {
		if (this.activeOwner !== userId) return;
		this.activeOwner = null;
		this.voiceFrames.flush();
		this.frames.flush();
	}

	pushPcm48Stereo(userId: string, chunk: Buffer): void {
		if (this.activeOwner !== userId) {
			this.droppedOtherSpeaker += Math.max(1, Math.floor(chunk.length / 3_840));
			return;
		}
		if (!this.micOpen) {
			this.droppedMuted += Math.max(1, Math.floor(chunk.length / 3_840));
			return;
		}
		this.voiceFrames.push(chunk);
		for (
			let frame = this.voiceFrames.take();
			frame;
			frame = this.voiceFrames.take()
		) {
			this.options.onVoiceFrame?.(frame, (this.options.now ?? Date.now)());
			if (this.options.speechGate) {
				const atMs = (this.options.now ?? Date.now)();
				this.options.speechGate.push(frame, atMs);
				this.drainSpeechGate(atMs);
			} else {
				this.enqueueFrame(frame, true);
			}
		}
	}

	setMicOpen(open: boolean): void {
		if (this.micOpen === open) return;
		this.micOpen = open;
		if (!open) {
			this.options.speechGate?.cancel();
			this.downmix = new Downmix48to24();
			this.voiceFrames.flush();
			this.frames.flush();
			this.jitter.flush();
		} else if (this.activeGateMode) {
			const atMs = (this.options.now ?? Date.now)();
			this.options.speechGate?.begin(this.activeGateMode, atMs);
			this.drainSpeechGate(atMs);
		}
	}

	failOpenUtterance(atMs: number): void {
		if (!this.activeGateMode || !this.options.speechGate) return;
		this.activeGateMode = "passthrough";
		this.options.speechGate.cancel();
		this.options.speechGate.begin("passthrough", atMs);
		this.drainSpeechGate(atMs);
	}

	tick(): AppendOutcome {
		this.drainSpeechGate((this.options.now ?? Date.now)());
		const frame = this.micOpen
			? this.jitter.take()
			: Buffer.from(PCM24_MONO_SILENCE);
		const outcome = this.options.appendAudio(
			frame,
			this.options.sessionGeneration,
		);
		this.options.record({ direction: "uplink", outcome });
		return outcome;
	}

	private drainSpeechGate(atMs: number): void {
		const gate = this.options.speechGate;
		if (!gate) return;
		for (const decision of gate.takeDue(atMs)) {
			this.enqueueFrame(decision.frame, decision.speech);
		}
		for (const summary of gate.takeCompleted()) {
			this.options.onGateSummary?.(summary);
		}
	}

	private enqueueFrame(frame: Buffer, speech: boolean): void {
		const pcm24 = speech
			? this.downmix.push(frame)
			: Buffer.from(PCM24_MONO_SILENCE);
		this.frames.push(pcm24);
		for (let ready = this.frames.take(); ready; ready = this.frames.take()) {
			this.jitter.push(ready);
		}
	}
}
