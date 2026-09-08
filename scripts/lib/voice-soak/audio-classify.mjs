// FLY-2383: turn one 20ms downlink PCM frame into a class we are willing to defend.
//
// Counting Opus packets cannot answer "is Raya talking": the downlink is a
// continuous stream and voice, the waiting bed and encoded silence all become
// packets. So we decode, and classify on two features. `unknown` is a first-class
// outcome — a frame we cannot place is never quietly filed as safe.
import {
	AUDIO_CLASSES,
	BOX_B_NOTES_HZ,
	FRAMES_PER_SECOND,
	PCM_SAMPLE_RATE_HZ,
	PCM_SAMPLES_PER_CHANNEL,
	PCM48_STEREO_FRAME_BYTES,
	QUALIFICATION_POLICY_ID,
	THRESHOLD_KEYS,
} from "./constants.mjs";

const INT16_FULL_SCALE = 32_768;

/**
 * Interleaved stereo -> one mono series of PCM_SAMPLES_PER_CHANNEL samples.
 *
 * The bed is identical on both channels, but the frame is L,R,L,R... Treating
 * those 1,920 interleaved samples as a 48kHz mono series would misplace every
 * target frequency by an octave, so the downmix is pinned here rather than
 * left to the caller.
 */
export function frameToMono(frame) {
	if (!Buffer.isBuffer(frame) || frame.length !== PCM48_STEREO_FRAME_BYTES) {
		throw new Error(
			`PCM frame must be exactly ${PCM48_STEREO_FRAME_BYTES} bytes`,
		);
	}
	const mono = new Float64Array(PCM_SAMPLES_PER_CHANNEL);
	let channelsIdentical = true;
	for (let index = 0; index < PCM_SAMPLES_PER_CHANNEL; index += 1) {
		const offset = index * 4;
		const left = frame.readInt16LE(offset);
		const right = frame.readInt16LE(offset + 2);
		if (left !== right) channelsIdentical = false;
		mono[index] = (left + right) / 2 / INT16_FULL_SCALE;
	}
	return { mono, channelsIdentical };
}

/**
 * Generalised Goertzel: the bin index is deliberately not rounded. At N=960 the
 * bin spacing is 50Hz, so rounding 261.63Hz to the nearest bin would measure
 * 250Hz instead and leak badly across all five notes.
 */
export function goertzelPower(samples, frequencyHz, sampleRateHz) {
	const omega = (2 * Math.PI * frequencyHz) / sampleRateHz;
	const coefficient = 2 * Math.cos(omega);
	let previous = 0;
	let previousTwo = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const current = samples[index] + coefficient * previous - previousTwo;
		previousTwo = previous;
		previous = current;
	}
	return (
		previous * previous +
		previousTwo * previousTwo -
		coefficient * previous * previousTwo
	);
}

export function extractFeatures(frame, options = {}) {
	const notes = options.notesHz ?? BOX_B_NOTES_HZ;
	const sampleRateHz = options.sampleRateHz ?? PCM_SAMPLE_RATE_HZ;
	const { mono, channelsIdentical } = frameToMono(frame);

	let sumSquares = 0;
	for (let index = 0; index < mono.length; index += 1) {
		sumSquares += mono[index] * mono[index];
	}
	const energy = Math.sqrt(sumSquares / mono.length);

	// Total power in the same normalisation the Goertzel accumulator uses, so the
	// ratio below is dimensionless.
	const totalPower = (sumSquares * mono.length) / 4;
	let tonalPower = 0;
	for (const noteHz of notes) {
		tonalPower += goertzelPower(mono, noteHz, sampleRateHz);
	}
	const tonalRatio =
		totalPower > 0 ? Math.max(0, Math.min(1, tonalPower / totalPower)) : 0;

	return { energy, tonalRatio, channelsIdentical };
}

export function defaultThresholds() {
	// Placeholders only. The run refuses to use these: §1.5.3 requires calibration
	// from labelled pilot windows plus a holdout, and the bed-off arm as a negative
	// control, before any main run may start.
	return {
		calibrated: false,
		silenceFloor: 0.0015,
		bedTonalMin: 0.55,
		bedEnergyMax: 0.05,
		voiceEnergyMin: 0.01,
		voiceTonalMax: 0.45,
	};
}

/**
 * A threshold file is only usable if it was qualified under the current policy
 * AND actually contains usable numbers.
 *
 * `calibrated: true` alone is not enough: a file qualified under a retracted
 * rule classifies identically but was accepted by a different test, and a file
 * missing its numbers would sail through a boolean check and then silently
 * classify everything as unknown.
 */
export function assertThresholdsCalibrated(thresholds) {
	if (!thresholds?.calibrated) {
		throw new Error(
			"audio classifier thresholds are not calibrated; run the pilot and the bed-off negative control first",
		);
	}
	if (thresholds.qualificationPolicyId !== QUALIFICATION_POLICY_ID) {
		throw new Error(
			`thresholds were qualified under ${thresholds.qualificationPolicyId ?? "no policy"}, but this run requires ${QUALIFICATION_POLICY_ID}`,
		);
	}
	for (const key of THRESHOLD_KEYS) {
		if (!Number.isFinite(thresholds[key])) {
			throw new Error(`threshold ${key} is missing or not a finite number`);
		}
	}
	if (!(thresholds.silenceFloor < thresholds.voiceEnergyMin)) {
		throw new Error("silenceFloor must be below voiceEnergyMin");
	}
	if (!(thresholds.bedEnergyMax >= thresholds.silenceFloor)) {
		throw new Error("bedEnergyMax must be at or above silenceFloor");
	}
	if (!(thresholds.bedTonalMin > 0 && thresholds.bedTonalMin <= 1)) {
		throw new Error("bedTonalMin must lie in (0, 1]");
	}
	return thresholds;
}

/**
 * Four outcomes, in priority order. Anything that does not clearly land in one of
 * the three known classes is `unknown`, and callers must treat `unknown` as
 * possibly-voice rather than as safe.
 */
export function classifyFrame(features, thresholds) {
	if (features.energy < thresholds.silenceFloor) return "silence";
	if (
		features.tonalRatio >= thresholds.bedTonalMin &&
		features.energy <= thresholds.bedEnergyMax
	) {
		return "bed";
	}
	if (
		features.energy >= thresholds.voiceEnergyMin &&
		features.tonalRatio <= thresholds.voiceTonalMax
	) {
		return "voice";
	}
	return "unknown";
}

export function emptyClassCounts() {
	return Object.fromEntries(AUDIO_CLASSES.map((name) => [name, 0]));
}

/**
 * Fold classified frames into one-second buckets relative to T0.
 *
 * Incremental on purpose: a half-hour run produces around ninety thousand
 * frames, and holding them all in memory to bucket them at the end puts the
 * biggest allocation at the worst moment — right as the run is trying to write
 * its manifest. Frames are folded in as they are read and then discarded.
 *
 * A bucket holding fewer than `minFramesPerSecond` frames is a hole: the
 * downlink stopped arriving, or our own sampling stalled. Either way it is a
 * transport fact worth reporting, and never something to smooth over.
 */
export function createSecondBucketAccumulator(options = {}) {
	const t0MonoMs = options.t0MonoMs ?? 0;
	const endMonoMs = options.endMonoMs ?? null;
	const minFramesPerSecond =
		options.minFramesPerSecond ?? Math.floor(FRAMES_PER_SECOND * 0.8);
	const buckets = new Map();
	return {
		add(frame) {
			// Frames outside [T0, T1) belong to startup or teardown, not to the
			// observation.
			if (endMonoMs !== null && frame.atMonoMs >= endMonoMs) return;
			const second = Math.floor((frame.atMonoMs - t0MonoMs) / 1_000);
			if (second < 0) return; // pre-T0 frames are discarded, not counted
			let bucket = buckets.get(second);
			if (!bucket) {
				bucket = { second, frames: 0, counts: emptyClassCounts() };
				buckets.set(second, bucket);
			}
			bucket.frames += 1;
			bucket.counts[frame.audioClass] += 1;
		},
		finish() {
			const ordered = [...buckets.values()].sort((a, b) => a.second - b.second);
			// When the window's end is known, count right up to it. Otherwise a
			// downlink that stopped some seconds before T1 would leave those
			// seconds out of the tally entirely — the most complete silence would
			// report as no holes at all.
			const lastSecond =
				endMonoMs !== null
					? Math.ceil((endMonoMs - t0MonoMs) / 1_000) - 1
					: ordered.length > 0
						? ordered[ordered.length - 1].second
						: -1;
			const holes = [];
			for (let second = 0; second <= lastSecond; second += 1) {
				const bucket = buckets.get(second);
				if (!bucket || bucket.frames < minFramesPerSecond) {
					holes.push({ second, frames: bucket?.frames ?? 0 });
				}
			}
			return { buckets: ordered, holes, minFramesPerSecond };
		},
	};
}

export function bucketFramesBySecond(frames, options = {}) {
	const accumulator = createSecondBucketAccumulator(options);
	for (const frame of frames) accumulator.add(frame);
	return accumulator.finish();
}

export function classSeconds(buckets) {
	const totals = emptyClassCounts();
	for (const bucket of buckets) {
		for (const name of AUDIO_CLASSES) totals[name] += bucket.counts[name];
	}
	const totalFrames = Object.values(totals).reduce((sum, n) => sum + n, 0);
	const seconds = Object.fromEntries(
		AUDIO_CLASSES.map((name) => [
			name,
			Number((totals[name] / FRAMES_PER_SECOND).toFixed(3)),
		]),
	);
	const share = Object.fromEntries(
		AUDIO_CLASSES.map((name) => [
			name,
			totalFrames > 0 ? Number((totals[name] / totalFrames).toFixed(4)) : 0,
		]),
	);
	return { frames: totals, seconds, share, totalFrames };
}

/**
 * How well is a stretch of time actually observed?
 *
 * Silence and "we were not looking" are indistinguishable if you only count the
 * frames you happen to have. A window can hold 149 frames and still be blind for
 * 2.9 of its 3 seconds if they all arrive in the last 48ms — which is exactly
 * what one real run did. Coverage is therefore measured, not assumed.
 */
export function windowCoverage(frames, options) {
	const { startMonoMs, endMonoMs } = options;
	const spanMs = endMonoMs - startMonoMs;
	const inWindow = frames
		.filter(
			(frame) => frame.atMonoMs >= startMonoMs && frame.atMonoMs <= endMonoMs,
		)
		.sort((a, b) => a.atMonoMs - b.atMonoMs);
	if (spanMs <= 0 || inWindow.length === 0) {
		return { frames: inWindow.length, spanMs, share: 0, maxGapMs: spanMs };
	}
	const expected = (spanMs / 1_000) * FRAMES_PER_SECOND;
	// The largest unobserved stretch, counting the run-up to the first frame and
	// the run-out after the last.
	let maxGapMs = inWindow[0].atMonoMs - startMonoMs;
	for (let index = 1; index < inWindow.length; index += 1) {
		maxGapMs = Math.max(
			maxGapMs,
			inWindow[index].atMonoMs - inWindow[index - 1].atMonoMs,
		);
	}
	maxGapMs = Math.max(
		maxGapMs,
		endMonoMs - inWindow[inWindow.length - 1].atMonoMs,
	);
	return {
		frames: inWindow.length,
		spanMs,
		share: expected > 0 ? inWindow.length / expected : 0,
		maxGapMs,
	};
}

/**
 * Did Raya hold still long enough to speak into?
 *
 * `unknown` blocks the window exactly like `voice` does — a frame we could not
 * classify is not evidence of quiet. So does poor coverage: a window we barely
 * observed cannot testify that nothing happened in it.
 */
export function hasQuietWindow(frames, options) {
	const {
		windowMs,
		nowMonoMs,
		minCoverageShare = 0.6,
		maxGapMs = 750,
	} = options;
	const since = nowMonoMs - windowMs;
	const inWindow = frames.filter((frame) => frame.atMonoMs >= since);
	if (inWindow.length === 0) return { quiet: false, reason: "no_frames" };
	const blocking = inWindow.find(
		(frame) => frame.audioClass === "voice" || frame.audioClass === "unknown",
	);
	if (blocking) {
		return { quiet: false, reason: `blocked_by_${blocking.audioClass}` };
	}
	const coverage = windowCoverage(frames, {
		startMonoMs: since,
		endMonoMs: nowMonoMs,
	});
	if (coverage.share < minCoverageShare || coverage.maxGapMs > maxGapMs) {
		return { quiet: false, reason: "insufficient_coverage", coverage };
	}
	return { quiet: true, reason: null, coverage };
}
