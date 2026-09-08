import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFrame } from "../lib/voice-soak/audio-classify.mjs";
import {
	deriveThresholds,
	HOLDOUT_RULES,
	QUALIFICATION_POLICY_ID,
	summarizeWindow,
	validateHoldout,
} from "../lib/voice-soak/calibrate.mjs";

// Shapes taken from the real pilot distributions: the bed is quiet and strongly
// tonal, her voice is louder and broadband, silence is digital zero.
const silenceWindow = () =>
	Array.from({ length: 200 }, () => ({ energy: 0, tonalRatio: 0 }));

const bedWindow = () =>
	Array.from({ length: 200 }, (_, index) => {
		// Roughly a tenth of bed frames sit at digital silence between notes.
		if (index % 10 === 0) return { energy: 0, tonalRatio: 0 };
		return { energy: 0.004 + (index % 7) * 0.002, tonalRatio: 1 };
	});

const voiceWindow = () =>
	Array.from({ length: 200 }, (_, index) => {
		// Real speech has pauses between syllables.
		if (index % 5 === 0) return { energy: 0.0002, tonalRatio: 0.01 };
		return { energy: 0.05 + (index % 9) * 0.008, tonalRatio: 0.2 };
	});

test("calibration refuses to proceed without all three labelled windows", () => {
	assert.equal(
		deriveThresholds({ silence: silenceWindow(), bed: bedWindow(), voice: [] })
			.calibrated,
		false,
	);
	assert.match(
		deriveThresholds({ silence: [], bed: bedWindow(), voice: voiceWindow() })
			.error,
		/needs labelled/,
	);
});

test("separable windows produce thresholds that reproduce their own labels", () => {
	const thresholds = deriveThresholds({
		silence: silenceWindow(),
		bed: bedWindow(),
		voice: voiceWindow(),
	});
	assert.equal(thresholds.calibrated, true);
	assert.ok(thresholds.silenceFloor < thresholds.voiceEnergyMin);
	assert.equal(
		classifyFrame({ energy: 0, tonalRatio: 0 }, thresholds),
		"silence",
	);
	assert.equal(
		classifyFrame({ energy: 0.008, tonalRatio: 1 }, thresholds),
		"bed",
	);
	assert.equal(
		classifyFrame({ energy: 0.09, tonalRatio: 0.2 }, thresholds),
		"voice",
	);
	// Quiet and not tonal is genuinely undecidable, and stays that way.
	assert.equal(
		classifyFrame({ energy: 0.006, tonalRatio: 0.05 }, thresholds),
		"unknown",
	);
});

test("calibration fails when her voice would be read as the waiting bed", () => {
	// A voice window that is quiet and tonal throughout — indistinguishable from
	// the bed. Better to have no ruler than one that cannot tell them apart.
	const tonalQuietVoice = Array.from({ length: 200 }, () => ({
		energy: 0.006,
		tonalRatio: 1,
	}));
	const thresholds = deriveThresholds({
		silence: silenceWindow(),
		bed: bedWindow(),
		voice: tonalQuietVoice,
	});
	assert.equal(thresholds.calibrated, false);
	assert.match(thresholds.error, /would read as bed/);
});

test("calibration fails when the tonal detector cannot find the bed", () => {
	// Same energy spread as the real bed, but the notes are not there.
	const untonalBed = bedWindow().map((frame) => ({
		...frame,
		tonalRatio: frame.energy > 0 ? 0.05 : 0,
	}));
	const thresholds = deriveThresholds({
		silence: silenceWindow(),
		bed: untonalBed,
		voice: voiceWindow(),
	});
	assert.equal(thresholds.calibrated, false);
	assert.match(thresholds.error, /only finds the bed/);
});

test("the holdout allows unknown everywhere but guards the dangerous directions", () => {
	const thresholds = deriveThresholds({
		silence: silenceWindow(),
		bed: bedWindow(),
		voice: voiceWindow(),
	});
	const clean = validateHoldout(
		thresholds,
		{
			silence: silenceWindow(),
			bed: bedWindow(),
			voice: voiceWindow(),
			transition: Array.from({ length: 20 }, () => ({
				energy: 0.09,
				tonalRatio: 0.2,
			})),
		},
		classifyFrame,
	);
	assert.equal(clean.passed, true);
	// A large share of unknown is acceptable and reported, not a failure.
	assert.ok(clean.shares.voice.counts.silence > 0);

	// An onset we fail to notice is a failure: that is how a real overlap slips
	// past the post-playback eligibility check.
	const missedOnset = validateHoldout(
		thresholds,
		{
			transition: Array.from({ length: 20 }, () => ({
				energy: 0.006,
				tonalRatio: 0.05,
			})),
		},
		classifyFrame,
	);
	assert.equal(missedOnset.passed, false);
	assert.equal(missedOnset.failures[0].rule, "minVoiceShare");
});

test("the holdout rules bound the confusion rather than deny it", () => {
	// voice-read-as-bed is real and measured; the rule caps what we will call a
	// working detector, and the appendix publishes the observed rate. Denying it
	// outright made calibration unreachable — see QUALIFICATION_POLICY_ID.
	assert.equal(QUALIFICATION_POLICY_ID, "fly2383/window-level/v3");
	assert.equal(HOLDOUT_RULES.voice.maxBedShare, 0.05);
	assert.equal(HOLDOUT_RULES.transition.maxBedShare, 0.05);
	assert.equal(HOLDOUT_RULES.transition.minVoiceShare, 0.5);
	assert.equal(HOLDOUT_RULES.bed.minBedShare, 0.5);
	assert.equal(HOLDOUT_RULES.silence.maxBedShare, 0.01);
});

test("window summaries survive a window with a single frame", () => {
	const summary = summarizeWindow([{ energy: 0.5, tonalRatio: 0.25 }]);
	assert.equal(summary.frames, 1);
	assert.equal(summary.energy.p50, 0.5);
	assert.equal(summary.tonalRatio.p95, 0.25);
});
