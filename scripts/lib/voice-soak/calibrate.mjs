// FLY-2383: turning labelled pilot windows into classifier thresholds.
//
// The thresholds are a property of the ruler, not a judgement about the product.
// They exist so that "bed" and "voice" mean something specific, and they are
// frozen into the run bundle before the main run starts.
const QUANTILE = (values, q) => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.round((sorted.length - 1) * q)),
	);
	return sorted[index];
};

export function summarizeWindow(frames) {
	return {
		frames: frames.length,
		energy: {
			p05: QUANTILE(
				frames.map((f) => f.energy),
				0.05,
			),
			p50: QUANTILE(
				frames.map((f) => f.energy),
				0.5,
			),
			p95: QUANTILE(
				frames.map((f) => f.energy),
				0.95,
			),
		},
		tonalRatio: {
			p05: QUANTILE(
				frames.map((f) => f.tonalRatio),
				0.05,
			),
			p50: QUANTILE(
				frames.map((f) => f.tonalRatio),
				0.5,
			),
			p95: QUANTILE(
				frames.map((f) => f.tonalRatio),
				0.95,
			),
		},
	};
}

/**
 * Derive thresholds from labelled windows, then refuse them if the classes are
 * not actually separable. A ruler that cannot tell bed from voice is worse than
 * no ruler, because it produces confident numbers.
 *
 * The shape the pilot data actually supports:
 *
 *   below the floor        silence
 *   above the bed ceiling  voice — she is talking
 *   quiet and strongly tonal   bed — the box B notes
 *   quiet and not tonal        unknown, and treated as possibly-voice
 *
 * The bed is deliberately sparse and quiet ("更疏、更慢、最安静"), so roughly a
 * tenth of its frames sit at digital silence between notes. That is a fact about
 * the sound, not a defect in the detector.
 */
export function deriveThresholds(labelled) {
	const silence = labelled.silence ?? [];
	const bed = labelled.bed ?? [];
	const voice = labelled.voice ?? [];
	if (silence.length === 0 || bed.length === 0 || voice.length === 0) {
		return {
			calibrated: false,
			error: "calibration needs labelled silence, bed and voice windows",
		};
	}
	const silenceEnergyP95 = summarizeWindow(silence).energy.p95;
	const provisionalFloor = Math.max(
		silenceEnergyP95,
		QUANTILE(
			bed.map((frame) => frame.energy),
			0.05,
		),
	);
	const audible = (frames) =>
		frames.filter((frame) => frame.energy > provisionalFloor);
	const bedAudible = audible(bed);
	const voiceAudible = audible(voice);
	if (bedAudible.length === 0 || voiceAudible.length === 0) {
		return {
			calibrated: false,
			error: "no audible frames in the bed or voice window",
		};
	}

	const silenceFloor = Math.max(
		provisionalFloor,
		QUANTILE(
			bedAudible.map((frame) => frame.energy),
			0.05,
		) * 0.4,
	);
	const bedEnergyMax =
		QUANTILE(
			bedAudible.map((frame) => frame.energy),
			0.95,
		) * 1.4;
	const bedTonalMin = 0.9;
	const voiceEnergyMin = bedEnergyMax;
	// Above the bed's energy ceiling, tonality no longer distinguishes anything:
	// a sustained vowel is as tonal as a bell.
	const voiceTonalMax = 1;
	const thresholds = {
		calibrated: true,
		silenceFloor,
		bedTonalMin,
		bedEnergyMax,
		voiceEnergyMin,
		voiceTonalMax,
	};

	const bedTonalShare =
		bedAudible.filter((frame) => frame.tonalRatio >= bedTonalMin).length /
		bedAudible.length;
	const voiceAsBedShare =
		voiceAudible.filter(
			(frame) =>
				frame.energy <= bedEnergyMax && frame.tonalRatio >= bedTonalMin,
		).length / voiceAudible.length;

	const problems = [];
	if (!(silenceEnergyP95 < bedEnergyMax)) {
		problems.push("silence is not quieter than the bed ceiling");
	}
	if (!(silenceFloor < voiceEnergyMin)) {
		problems.push("silence floor is not below the voice energy minimum");
	}
	if (bedTonalShare < 0.6) {
		problems.push(
			`the tonal detector only finds the bed in ${(bedTonalShare * 100).toFixed(1)}% of audible bed frames`,
		);
	}
	if (voiceAsBedShare > 0.05) {
		problems.push(
			`${(voiceAsBedShare * 100).toFixed(1)}% of audible voice frames would read as bed`,
		);
	}
	if (problems.length > 0) {
		return { calibrated: false, error: problems.join("; "), problems };
	}
	return {
		...thresholds,
		separability: {
			bedTonalShare: Number(bedTonalShare.toFixed(4)),
			voiceAsBedShare: Number(voiceAsBedShare.toFixed(4)),
			audibleBedFrames: bedAudible.length,
			audibleVoiceFrames: voiceAudible.length,
		},
		derivedFrom: {
			silence: summarizeWindow(silence),
			bed: summarizeWindow(bedAudible),
			voice: summarizeWindow(voiceAudible),
		},
	};
}

/**
 * Check the frozen thresholds against windows that took no part in choosing
 * them.
 *
 * This is deliberately not a per-frame accuracy test. A "voice window" contains
 * real pauses between syllables, and the bed is sparse by design, so demanding
 * that every frame reproduce its window's label would only measure how willing
 * we are to guess. `unknown` is allowed everywhere — a lot of it is acceptable
 * and gets reported.
 *
 * What must hold are the directions where a mistake would change a conclusion:
 *
 *   voice read as bed        bounded, not forbidden: the confusion is real and
 *                            its measured rate is published (appendix §6)
 *   bed never read as bed    then "bed confirmed" means nothing
 *   silence read as either   then the detector is chasing its own noise floor
 *   onset not read as voice  then a real overlap slips past the eligibility check
 */
export { QUALIFICATION_POLICY_ID } from "./constants.mjs";

/**
 * The qualification policy, versioned because it changed twice under scrutiny.
 *
 *   v1  plan §1.5.3: transition frames may only be voice|unknown.
 *       Unreachable — speech contains real inter-syllable silence, so it failed
 *       for reasons unrelated to the risk it guarded.
 *   v2  Lead 2026-09-07 03:0x: bed must be zero per frame in the transition.
 *       Also unreachable. 18 of 1,603 frames inside the coarse response window
 *       read as bed: they are quiet and strongly tonal, reaching tonalRatio 1.0,
 *       which puts them in the same two-feature region as a box B note. The
 *       window contains real inter-syllable pauses and carries no frame-level
 *       speech label, so this says nothing about what those frames are — only
 *       that these two features cannot separate them. Retracted by the Lead on
 *       that evidence.
 *   v3  Lead 2026-09-07 04:19 (current): protection is window-level — any voice
 *       or unknown frame in a playback window rejects it — and the frame-level
 *       confusion rate is published as a known ceiling rather than suppressed.
 *
 * The retracted rules are kept because a rule overturned by measurement is
 * itself evidence; only reading the survivor gives no way to tell whether it was
 * reasoned or merely landed on.
 */
export const HOLDOUT_RULES = Object.freeze({
	silence: { maxBedShare: 0.01, maxVoiceShare: 0.01 },
	bed: { minBedShare: 0.5, maxVoiceShare: 0.02 },
	// The ceiling is reported, not asserted away: `maxBedShare` here bounds what
	// we are willing to call a working detector, and §6 of the appendix publishes
	// the rate actually observed.
	voice: { maxBedShare: 0.05, minVoiceShare: 0.3 },
	// Onset frames. The danger is failing to notice her quickly; a frame that is
	// genuinely still bed just before she speaks is not an error.
	transition: { minVoiceShare: 0.5, maxBedShare: 0.05 },
});

export function validateHoldout(thresholds, holdout, classify) {
	const failures = [];
	const shares = {};
	for (const [label, frames] of Object.entries(holdout)) {
		const rule = HOLDOUT_RULES[label];
		if (!rule || frames.length === 0) continue;
		const counts = { voice: 0, bed: 0, silence: 0, unknown: 0 };
		for (const frame of frames) counts[classify(frame, thresholds)] += 1;
		const bedShare = counts.bed / frames.length;
		const voiceShare = counts.voice / frames.length;
		shares[label] = {
			frames: frames.length,
			counts,
			bedShare: Number(bedShare.toFixed(4)),
			voiceShare: Number(voiceShare.toFixed(4)),
		};
		if (rule.maxBedShare !== undefined && bedShare > rule.maxBedShare) {
			failures.push({
				label,
				rule: "maxBedShare",
				observed: bedShare,
				limit: rule.maxBedShare,
			});
		}
		if (rule.maxVoiceShare !== undefined && voiceShare > rule.maxVoiceShare) {
			failures.push({
				label,
				rule: "maxVoiceShare",
				observed: voiceShare,
				limit: rule.maxVoiceShare,
			});
		}
		if (rule.minBedShare !== undefined && bedShare < rule.minBedShare) {
			failures.push({
				label,
				rule: "minBedShare",
				observed: bedShare,
				limit: rule.minBedShare,
			});
		}
		if (rule.minVoiceShare !== undefined && voiceShare < rule.minVoiceShare) {
			failures.push({
				label,
				rule: "minVoiceShare",
				observed: voiceShare,
				limit: rule.minVoiceShare,
			});
		}
	}
	return { passed: failures.length === 0, failures, shares };
}
