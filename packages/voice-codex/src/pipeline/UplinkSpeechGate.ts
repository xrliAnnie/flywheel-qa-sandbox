const PCM48_STEREO_FRAME_BYTES = 3_840;
const FRAME_SAMPLES_16K = 320;
const SILERO_CHUNK_SAMPLES = 512;
const END_HOLD_MS = 20;
const RESAMPLE_HISTORY_SAMPLES = 30;
// Fixed 31-tap Hamming-windowed sinc, 7kHz cutoff at 48kHz input.
const RESAMPLE_FIR = new Float32Array([
	0.0015674095098604291, 0.0005295786413238137, -0.001784090690413418,
	-0.004449530112900912, -0.004087755523218975, 0.002552268308978699,
	0.012991610302216934, 0.016939508203684308, 0.003488242958693894,
	-0.0255729393857612, -0.048568835470756286, -0.03371101813582201,
	0.03701280785836393, 0.1475223656645097, 0.24983161491042905,
	0.2914775259216239, 0.24983161491042905, 0.1475223656645097,
	0.03701280785836394, -0.03371101813582202, -0.04856883547075631,
	-0.025572939385761207, 0.0034882429586938963, 0.016939508203684315,
	0.012991610302216938, 0.002552268308978699, -0.004087755523218974,
	-0.004449530112900913, -0.0017840906904134173, 0.0005295786413238137,
	0.0015674095098604291,
]);

export type UplinkGateMode = "gated" | "passthrough";
export type UplinkGateDegradedReason =
	| "startup"
	| "score_error"
	| "queue_overflow"
	| "inference_lag";

export interface UplinkGateDegradedEvent {
	reason: UplinkGateDegradedReason;
	consecutive: number;
	sessionPermanent: boolean;
	message?: string;
}

export interface UplinkGateFrame {
	frame: Buffer;
	speech: boolean;
}

export interface UplinkGateSummary {
	mode: UplinkGateMode;
	opened: boolean;
	openAtMs?: number;
	framesTotal: number;
	framesSilenced: number;
	framesPassed: number;
	maxProb: number;
	minSpeechMs: number;
	threshold: number;
	degraded?: UplinkGateDegradedReason;
	framesSilencedBeforeDegrade?: number;
	endedWithScoreInFlight: boolean;
	heldMs: number;
	scoreCount: number;
	scoreMsP50: number | null;
	scoreMsP99: number | null;
}

interface UplinkSpeechGateOptions {
	score(
		chunk16k: Float32Array,
		priorState: unknown,
	): Promise<{ probability: number; next: unknown }>;
	initialState(): unknown;
	minSpeechMs: number;
	threshold: number;
	now?: () => number;
	measureNow?: () => number;
	startupFailure?: string;
	onOpened?(event: { token: number; openAtMs: number }): void;
	onDegraded?(event: UplinkGateDegradedEvent): void;
}

interface DelayedFrame {
	frame: Buffer;
	requiredChunk: number;
	backfilled: boolean;
}

interface PendingChunk {
	sequence: number;
	samples: Float32Array;
}

interface Chain {
	token: number;
	mode: UplinkGateMode;
	state: unknown;
	delay: DelayedFrame[];
	sampleResidue: number[];
	resampleHistory: Float32Array;
	queue: PendingChunk[];
	inFlight: PendingChunk | null;
	decisions: Map<number, boolean>;
	nextChunk: number;
	opened: boolean;
	everOpened: boolean;
	openAtMs?: number;
	positiveChunks: number;
	negativeMs: number;
	maxProb: number;
	framesTotal: number;
	framesSilenced: number;
	framesPassed: number;
	endedAtMs?: number;
	holdDeadlineMs?: number;
	endedWithScoreInFlight: boolean;
	degraded?: UplinkGateDegradedReason;
	framesSilencedBeforeDegrade?: number;
	scoreDurationsMs: number[];
}

function positiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
}

export function uplinkGateDelayFrames(minSpeechMs: number): number {
	positiveInteger(minSpeechMs, "minSpeechMs");
	const positiveChunks = Math.ceil(minSpeechMs / 32);
	return (
		Math.ceil(
			(511 + SILERO_CHUNK_SAMPLES * positiveChunks) / FRAME_SAMPLES_16K,
		) + 1
	);
}

function probability(value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error("speech probability must be between 0 and 1");
	}
}

function percentile(values: readonly number[], proportion: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(proportion * sorted.length) - 1] ?? 0;
}

function downsampleFrame(frame: Buffer, history: Float32Array): Float32Array {
	if (frame.length !== PCM48_STEREO_FRAME_BYTES) {
		throw new Error(
			`uplink speech gate requires one ${PCM48_STEREO_FRAME_BYTES}-byte frame`,
		);
	}
	const mono = new Float32Array(FRAME_SAMPLES_16K * 3);
	for (let index = 0; index < mono.length; index += 1) {
		const sourceOffset = index * 4;
		const left = frame.readInt16LE(sourceOffset);
		const right = frame.readInt16LE(sourceOffset + 2);
		mono[index] = (left + right) / (2 * 32_768);
	}
	const extended = new Float32Array(history.length + mono.length);
	extended.set(history);
	extended.set(mono, history.length);
	const output = new Float32Array(FRAME_SAMPLES_16K);
	for (let index = 0; index < output.length; index += 1) {
		const sourceIndex = history.length + index * 3;
		let filtered = 0;
		for (let tap = 0; tap < RESAMPLE_FIR.length; tap += 1) {
			filtered += (RESAMPLE_FIR[tap] ?? 0) * (extended[sourceIndex - tap] ?? 0);
		}
		output[index] = filtered;
	}
	history.set(mono.subarray(mono.length - history.length));
	return output;
}

export class UplinkSpeechGate {
	private chain: Chain | null = null;
	private readonly ready: UplinkGateFrame[] = [];
	private readonly completed: UplinkGateSummary[] = [];
	private tokenValue = 0;
	private readonly now: () => number;
	private readonly measureNow: () => number;
	private readonly positiveChunksRequired: number;
	private readonly maxPendingChunks: number;
	private transientFailures = 0;
	private permanentDegraded: {
		reason: UplinkGateDegradedReason;
		message?: string;
	} | null;
	private startupReported = false;
	readonly delayFrames: number;

	constructor(private readonly options: UplinkSpeechGateOptions) {
		positiveInteger(options.minSpeechMs, "minSpeechMs");
		if (
			!Number.isFinite(options.threshold) ||
			options.threshold <= 0 ||
			options.threshold >= 1
		) {
			throw new Error("threshold must be between 0 and 1");
		}
		this.now = options.now ?? Date.now;
		this.measureNow = options.measureNow ?? (() => performance.now());
		this.positiveChunksRequired = Math.ceil(options.minSpeechMs / 32);
		this.delayFrames = uplinkGateDelayFrames(options.minSpeechMs);
		this.maxPendingChunks = this.delayFrames + 8;
		this.permanentDegraded = options.startupFailure
			? { reason: "startup", message: options.startupFailure }
			: null;
	}

	get token(): number {
		return this.tokenValue;
	}

	get mode(): UplinkGateMode | null {
		return this.chain?.mode ?? null;
	}

	begin(mode: UplinkGateMode, atMs: number): void {
		if (this.chain) this.finalize(this.chain, atMs);
		const permanent = mode === "gated" ? this.permanentDegraded : null;
		this.chain = {
			token: this.tokenValue,
			mode,
			state: this.options.initialState(),
			delay: [],
			sampleResidue: [],
			resampleHistory: new Float32Array(RESAMPLE_HISTORY_SAMPLES),
			queue: [],
			inFlight: null,
			decisions: new Map(),
			nextChunk: 0,
			opened: mode === "passthrough",
			everOpened: mode === "passthrough",
			positiveChunks: 0,
			negativeMs: 0,
			maxProb: 0,
			framesTotal: 0,
			framesSilenced: 0,
			framesPassed: 0,
			endedWithScoreInFlight: false,
			scoreDurationsMs: [],
			...(permanent
				? { degraded: permanent.reason, framesSilencedBeforeDegrade: 0 }
				: {}),
		};
		if (permanent?.reason === "startup" && !this.startupReported) {
			this.startupReported = true;
			this.options.onDegraded?.({
				reason: "startup",
				consecutive: 1,
				sessionPermanent: true,
				...(permanent.message === undefined
					? {}
					: { message: permanent.message }),
			});
		}
	}

	push(frame: Buffer, _atMs: number): void {
		const chain = this.chain;
		if (!chain) throw new Error("uplink speech gate has no active chain");
		if (chain.endedAtMs !== undefined) {
			throw new Error("uplink speech gate chain has ended");
		}
		chain.framesTotal += 1;
		if (chain.mode === "passthrough" || chain.degraded !== undefined) {
			this.emitFrame(chain, frame, true);
			return;
		}
		const samples = downsampleFrame(frame, chain.resampleHistory);
		for (const sample of samples) chain.sampleResidue.push(sample);
		const sampleEnd =
			chain.nextChunk * SILERO_CHUNK_SAMPLES + chain.sampleResidue.length;
		chain.delay.push({
			frame,
			requiredChunk: Math.floor((sampleEnd - 1) / SILERO_CHUNK_SAMPLES),
			backfilled: false,
		});
		while (chain.sampleResidue.length >= SILERO_CHUNK_SAMPLES) {
			if (
				chain.queue.length + (chain.inFlight ? 1 : 0) >=
				this.maxPendingChunks
			) {
				this.markDegraded(chain, "queue_overflow");
				chain.queue.length = 0;
				chain.sampleResidue.length = 0;
				break;
			}
			const chunk = new Float32Array(
				chain.sampleResidue.splice(0, SILERO_CHUNK_SAMPLES),
			);
			chain.queue.push({ sequence: chain.nextChunk, samples: chunk });
			chain.nextChunk += 1;
		}
		this.startNext(chain);
	}

	end(atMs: number): void {
		const chain = this.chain;
		if (!chain || chain.endedAtMs !== undefined) return;
		chain.endedAtMs = atMs;
		if (chain.degraded !== undefined) {
			this.finalize(chain, atMs);
			return;
		}
		if (chain.inFlight || chain.queue.length > 0) {
			chain.endedWithScoreInFlight = chain.inFlight !== null;
			chain.holdDeadlineMs = atMs + END_HOLD_MS;
			this.startNext(chain);
			return;
		}
		this.finalize(chain, atMs);
	}

	cancel(): void {
		if (!this.chain) return;
		this.chain = null;
		this.ready.length = 0;
		this.tokenValue += 1;
	}

	takeDue(atMs: number): UplinkGateFrame[] {
		const chain = this.chain;
		if (
			chain?.endedAtMs !== undefined &&
			chain.holdDeadlineMs !== undefined &&
			atMs >= chain.holdDeadlineMs
		) {
			this.finalize(chain, chain.holdDeadlineMs);
		}
		const active = this.chain;
		if (active && active.endedAtMs === undefined && active.mode === "gated") {
			while (active.delay.length > this.delayFrames) {
				const delayed = active.delay.shift();
				if (!delayed) break;
				const committed = active.decisions.get(delayed.requiredChunk);
				if (committed === undefined) {
					active.delay.unshift(delayed);
					this.markDegraded(active, "inference_lag");
					break;
				}
				this.emitFrame(
					active,
					delayed.frame,
					active.degraded !== undefined ||
						delayed.backfilled ||
						committed === true,
				);
			}
		}
		return this.ready.splice(0);
	}

	takeCompleted(): UplinkGateSummary[] {
		return this.completed.splice(0);
	}

	private startNext(chain: Chain): void {
		if (this.chain !== chain || chain.inFlight || chain.degraded !== undefined)
			return;
		const next = chain.queue.shift();
		if (!next) {
			if (chain.endedAtMs !== undefined) {
				this.finalize(
					chain,
					Math.min(this.now(), chain.holdDeadlineMs ?? Infinity),
				);
			}
			return;
		}
		chain.inFlight = next;
		const token = chain.token;
		const scoreStartedAt = this.measureNow();
		let scoreSettled = false;
		const recordScoreDuration = () => {
			if (scoreSettled) return;
			scoreSettled = true;
			const durationMs = this.measureNow() - scoreStartedAt;
			if (Number.isFinite(durationMs) && durationMs >= 0) {
				chain.scoreDurationsMs.push(Math.round(durationMs * 1_000) / 1_000);
			}
		};
		void this.options
			.score(next.samples, chain.state)
			.then((result) => {
				recordScoreDuration();
				if (
					this.chain !== chain ||
					chain.token !== token ||
					chain.inFlight !== next
				) {
					return;
				}
				if (chain.degraded !== undefined) {
					chain.inFlight = null;
					if (chain.endedAtMs !== undefined) this.finalize(chain, this.now());
					return;
				}
				probability(result.probability);
				chain.state = result.next;
				chain.maxProb = Math.max(chain.maxProb, result.probability);
				if (result.probability > this.options.threshold) {
					chain.positiveChunks += 1;
					chain.negativeMs = 0;
				} else {
					chain.positiveChunks = 0;
					if (result.probability < this.options.threshold - 0.15) {
						chain.negativeMs += 32;
					} else {
						chain.negativeMs = 0;
					}
				}
				if (
					!chain.opened &&
					chain.positiveChunks >= this.positiveChunksRequired
				) {
					chain.opened = true;
					if (!chain.everOpened) {
						chain.everOpened = true;
						chain.openAtMs = this.now();
						this.options.onOpened?.({
							token: chain.token,
							openAtMs: chain.openAtMs,
						});
					}
					for (const delayed of chain.delay) delayed.backfilled = true;
				}
				if (chain.opened && chain.negativeMs >= 100) chain.opened = false;
				chain.decisions.set(next.sequence, chain.opened);
				chain.inFlight = null;
				this.startNext(chain);
			})
			.catch(() => {
				recordScoreDuration();
				if (this.chain !== chain || chain.token !== token) return;
				chain.inFlight = null;
				this.markDegraded(chain, "score_error");
				if (chain.endedAtMs !== undefined) {
					this.finalize(
						chain,
						Math.min(this.now(), chain.holdDeadlineMs ?? Infinity),
					);
				}
			});
	}

	private finalize(chain: Chain, atMs: number): void {
		if (this.chain !== chain) return;
		const speech =
			chain.mode === "passthrough" ||
			chain.degraded !== undefined ||
			chain.opened;
		for (const delayed of chain.delay) {
			this.emitFrame(chain, delayed.frame, speech || delayed.backfilled);
		}
		const heldMs =
			chain.endedAtMs !== undefined && chain.endedWithScoreInFlight
				? Math.max(0, Math.min(END_HOLD_MS, atMs - chain.endedAtMs))
				: 0;
		this.completed.push({
			mode: chain.mode,
			opened: chain.everOpened,
			...(chain.openAtMs === undefined ? {} : { openAtMs: chain.openAtMs }),
			framesTotal: chain.framesTotal,
			framesSilenced: chain.framesSilenced,
			framesPassed: chain.framesPassed,
			maxProb: chain.maxProb,
			minSpeechMs: this.options.minSpeechMs,
			threshold: this.options.threshold,
			...(chain.degraded === undefined
				? {}
				: {
						degraded: chain.degraded,
						framesSilencedBeforeDegrade: chain.framesSilencedBeforeDegrade ?? 0,
					}),
			endedWithScoreInFlight: chain.endedWithScoreInFlight,
			heldMs,
			scoreCount: chain.scoreDurationsMs.length,
			scoreMsP50:
				chain.scoreDurationsMs.length === 0
					? null
					: percentile(chain.scoreDurationsMs, 0.5),
			scoreMsP99:
				chain.scoreDurationsMs.length === 0
					? null
					: percentile(chain.scoreDurationsMs, 0.99),
		});
		if (
			chain.mode === "gated" &&
			chain.degraded === undefined &&
			this.permanentDegraded === null
		) {
			this.transientFailures = 0;
		}
		this.tokenValue += 1;
		this.chain = null;
	}

	private emitFrame(chain: Chain, frame: Buffer, speech: boolean): void {
		this.ready.push({ frame, speech });
		if (speech) chain.framesPassed += 1;
		else chain.framesSilenced += 1;
	}

	private markDegraded(
		chain: Chain,
		reason: Exclude<UplinkGateDegradedReason, "startup">,
	): void {
		if (chain.degraded !== undefined) return;
		chain.degraded = reason;
		chain.framesSilencedBeforeDegrade = chain.framesSilenced;
		for (const delayed of chain.delay.splice(0)) {
			this.emitFrame(chain, delayed.frame, true);
		}
		this.transientFailures += 1;
		const sessionPermanent = this.transientFailures >= 3;
		if (sessionPermanent) this.permanentDegraded = { reason };
		this.options.onDegraded?.({
			reason,
			consecutive: this.transientFailures,
			sessionPermanent,
		});
	}
}
