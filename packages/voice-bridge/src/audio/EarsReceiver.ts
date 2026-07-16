/**
 * EarsReceiver — the huddle's single receive pipeline (FLY-545 P3).
 *
 * One "ears" bot subscribes every admitted speaker in the VC and streams
 * decoded, downmixed 16kHz mono PCM to `onFrame` (→ Gemini Live sendAudio).
 * All Discord specifics are injected seams so the pipeline is fully
 * unit-testable (voice-core transport-injection pattern):
 *
 *   - `speaking` / `subscribe`: the @discordjs/voice receiver, pre-bound with
 *     EndBehaviorType.Manual (a live meeting must not auto-end on silence).
 *   - `createDecoder`: prism opus Decoder factory (48k stereo s16le out).
 *   - `isHuman`: member filter — subscribing ONLY humans is the structural
 *     echo guard (a bot's own playback can never loop back in).
 *     `allowUserIds` admits named non-human ids for QA test injection.
 *
 * Backchannel gate (PRD §15; signal source pinned by Codex R1 #6 to
 * receiver.speaking start/end pairs): a speaking start arms a timer
 * (default 350ms). End first → the burst was a backchannel ("嗯/对/laugh"),
 * do nothing. Timer fires while still speaking → `onBargeIn` exactly once
 * for that burst. The caller stops playback + interrupts the session there.
 *
 * Barge-in holdoff (QA FLY-1006 round-3 ①): real human speech is a train of
 * Discord speaking start/end pairs — breaths and mid-sentence pauses end one
 * burst and start the next. Without a holdoff, EVERY resumed burst ≥350ms
 * re-fires `onBargeIn` (Annie P6: 8+ per utterance → barge-in storm). After a
 * fire, the gate stays LATCHED until the speaker has been CONTINUOUSLY silent
 * for `bargeInHoldoffMs` (default 1000ms) — one utterance, at most one
 * barge-in. A genuine new interruption starts from silence ≥ holdoff, so it
 * still fires normally.
 */
import { StereoDownmixDecimator } from "./resample.js";

export interface SpeakingEvents {
	on(event: "start" | "end", cb: (userId: string) => void): void;
}

export interface EarsReceiverOptions {
	speaking: SpeakingEvents;
	/** subscribe a user's opus stream (Manual end behavior, pre-bound). */
	subscribe: (userId: string) => NodeJS.ReadableStream;
	/** opus decoder factory (one per subscription) → 48k stereo s16le. */
	createDecoder: () => NodeJS.ReadWriteStream;
	/** member filter: true for human (non-bot) members. */
	isHuman: (userId: string) => boolean;
	/** QA test-injection seam: additionally admit these non-human ids. */
	allowUserIds?: string[];
	/** sustained-speech threshold for a real barge-in (default 350ms). */
	backchannelMs?: number;
	/** QA R3 P1 noise gate: minimum mean RMS (s16 samples) over the gate
	 * window for a barge-in — footsteps/ambient bursts that trip Discord's
	 * speaking flag but carry little energy re-arm instead of interrupting.
	 * 0 (the default) disables the floor — modes opt in (/glaw passes the
	 * huddle config's 700 default; the shared room path keeps its shipped
	 * behavior). */
	bargeInMinRms?: number;
	/** continuous-silence duration that ends an utterance and re-arms the
	 * barge-in gate after a fire (default 1000ms). */
	bargeInHoldoffMs?: number;
	/** 16kHz mono s16le output frames. */
	onFrame: (frame: Buffer, userId: string) => void;
	/** sustained speech crossed the gate — stop playback + interrupt. */
	onBargeIn: (userId: string) => void;
	onSpeakingStart?: (userId: string) => void;
	onSpeakingEnd?: (userId: string) => void;
	/** pipeline failures surface here — never swallowed. */
	onError?: (err: Error, userId: string) => void;
}

const DEFAULT_BACKCHANNEL_MS = 350;
const DEFAULT_BARGE_IN_MIN_RMS = 0;
const DEFAULT_BARGE_HOLDOFF_MS = 1000;

interface Capture {
	opus: NodeJS.ReadableStream;
	decoder: NodeJS.ReadWriteStream;
}

export class EarsReceiver {
	private readonly captures = new Map<string, Capture>();
	private readonly gates = new Map<string, NodeJS.Timeout>();
	/** per-user energy accumulated while a gate is armed (noise floor). */
	private readonly gateEnergy = new Map<
		string,
		{ sumSquares: number; samples: number }
	>();
	/** users whose current utterance already fired a barge-in (holdoff latch). */
	private readonly latched = new Set<string>();
	/** pending continuous-silence timers that clear the latch. */
	private readonly unlatchTimers = new Map<string, NodeJS.Timeout>();
	private readonly allow: Set<string>;
	private readonly backchannelMs: number;
	private readonly bargeInMinRms: number;
	private readonly bargeInHoldoffMs: number;
	private detached = false;

	constructor(private readonly opts: EarsReceiverOptions) {
		this.allow = new Set(opts.allowUserIds ?? []);
		this.backchannelMs = opts.backchannelMs ?? DEFAULT_BACKCHANNEL_MS;
		this.bargeInMinRms = opts.bargeInMinRms ?? DEFAULT_BARGE_IN_MIN_RMS;
		this.bargeInHoldoffMs = opts.bargeInHoldoffMs ?? DEFAULT_BARGE_HOLDOFF_MS;
	}

	/** wire speaking listeners. Call once per receiver lifetime. */
	attach(): void {
		this.opts.speaking.on("start", (userId) => this.onStart(userId));
		this.opts.speaking.on("end", (userId) => this.onEnd(userId));
	}

	detach(): void {
		this.detached = true;
		for (const timer of this.gates.values()) clearTimeout(timer);
		this.gates.clear();
		for (const timer of this.unlatchTimers.values()) clearTimeout(timer);
		this.unlatchTimers.clear();
		this.latched.clear();
		for (const cap of this.captures.values()) {
			destroyQuietly(cap.opus);
			destroyQuietly(cap.decoder);
		}
		this.captures.clear();
	}

	private admitted(userId: string): boolean {
		return this.opts.isHuman(userId) || this.allow.has(userId);
	}

	private onStart(userId: string): void {
		if (this.detached || !this.admitted(userId)) return;
		this.opts.onSpeakingStart?.(userId);
		if (this.latched.has(userId)) {
			// resumed speech within the holdoff — same utterance, no re-arm; the
			// pending continuous-silence clock (if any) restarts from her NEXT end.
			const unlatch = this.unlatchTimers.get(userId);
			if (unlatch) {
				clearTimeout(unlatch);
				this.unlatchTimers.delete(userId);
			}
		} else {
			this.armGate(userId);
		}
		this.ensureSubscribed(userId);
	}

	private onEnd(userId: string): void {
		if (this.detached || !this.admitted(userId)) return;
		this.opts.onSpeakingEnd?.(userId);
		// end before the gate fired → the burst was a backchannel: disarm.
		const gate = this.gates.get(userId);
		if (gate) {
			clearTimeout(gate);
			this.gates.delete(userId);
		}
		this.gateEnergy.delete(userId);
		// latched: the utterance ends only after CONTINUOUS silence ≥ holdoff.
		if (this.latched.has(userId) && !this.unlatchTimers.has(userId)) {
			const timer = setTimeout(() => {
				this.unlatchTimers.delete(userId);
				this.latched.delete(userId);
			}, this.bargeInHoldoffMs);
			this.unlatchTimers.set(userId, timer);
		}
	}

	private armGate(userId: string): void {
		if (this.gates.has(userId)) return; // flutter re-start within one burst
		this.gateEnergy.set(userId, { sumSquares: 0, samples: 0 });
		const timer = setTimeout(() => {
			this.gates.delete(userId);
			const acc = this.gateEnergy.get(userId);
			this.gateEnergy.delete(userId);
			if (this.bargeInMinRms > 0 && acc && acc.samples > 0) {
				const rms = Math.sqrt(acc.sumSquares / acc.samples);
				if (rms < this.bargeInMinRms) {
					// sustained but QUIET (footsteps, keyboard, room tone) —
					// not speech: re-arm so genuine speech that follows can
					// still barge in, but never interrupt on this burst — and
					// never latch (a quiet burst is not an utterance).
					this.armGate(userId);
					return;
				}
			}
			this.latched.add(userId); // holdoff: one barge-in per utterance
			this.opts.onBargeIn(userId);
		}, this.backchannelMs);
		this.gates.set(userId, timer);
	}

	/** accumulate a decoded 16k mono s16le frame into the armed gate window. */
	private trackGateEnergy(userId: string, frame: Buffer): void {
		const acc = this.gateEnergy.get(userId);
		if (!acc) return;
		// sample every other s16 (stride 4 bytes) — enough for an RMS floor.
		for (let i = 0; i + 1 < frame.length; i += 4) {
			const v = frame.readInt16LE(i);
			acc.sumSquares += v * v;
			acc.samples++;
		}
	}

	/** speaking-start dedup: VAD flutter re-fires start while the Manual
	 * subscription is already live — one capture per user (FLY-960 A-1). */
	private ensureSubscribed(userId: string): void {
		if (this.captures.has(userId)) return;
		let opus: NodeJS.ReadableStream;
		let decoder: NodeJS.ReadWriteStream;
		try {
			opus = this.opts.subscribe(userId);
			decoder = this.opts.createDecoder();
		} catch (err) {
			this.opts.onError?.(asError(err), userId);
			return;
		}
		this.captures.set(userId, { opus, decoder });
		const downmix = new StereoDownmixDecimator();
		decoder.on("data", (pcm48: Buffer) => {
			const frame = downmix.push(pcm48);
			if (frame.length > 0) {
				this.trackGateEnergy(userId, frame);
				this.opts.onFrame(frame, userId);
			}
		});
		const fail = (err: Error) => {
			this.captures.delete(userId);
			destroyQuietly(opus);
			destroyQuietly(decoder);
			this.opts.onError?.(err, userId);
		};
		opus.on("error", fail);
		decoder.on("error", fail);
		opus.pipe(decoder);
	}
}

function destroyQuietly(stream: unknown): void {
	const s = stream as { destroy?: () => void; destroyed?: boolean };
	if (typeof s.destroy === "function" && !s.destroyed) s.destroy();
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
