import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bucketFramesBySecond,
	classifyFrame,
	classSeconds,
	extractFeatures,
	frameToMono,
	hasQuietWindow,
	windowCoverage,
} from "../lib/voice-soak/audio-classify.mjs";
import {
	parseLiveCandidates,
	parseStatusReceipt,
	summarizeOrchestrationOverlap,
} from "../lib/voice-soak/bridge-orchestration.mjs";
import {
	BOX_B_NOTES_HZ,
	PCM_SAMPLE_RATE_HZ,
	PCM_SAMPLES_PER_CHANNEL,
	PCM48_STEREO_FRAME_BYTES,
} from "../lib/voice-soak/constants.mjs";
import {
	judgeAudioEligibility,
	judgeRecognition,
	tallyRounds,
} from "../lib/voice-soak/eligibility.mjs";
import {
	MIN_MAIN_RUN_DURATION_MS,
	resolveThreeConditions,
	resolveVerdict,
} from "../lib/voice-soak/manifest.mjs";
import {
	bothPresentCensus,
	validDiscordReadyReceipt,
	validLiveReceipt,
	voiceReadyCensus,
} from "../lib/voice-soak/receipts.mjs";

const THRESHOLDS = {
	calibrated: true,
	silenceFloor: 0.0015,
	bedTonalMin: 0.55,
	bedEnergyMax: 0.05,
	voiceEnergyMin: 0.01,
	voiceTonalMax: 0.45,
};

function buildFrame(sampleAt) {
	const frame = Buffer.alloc(PCM48_STEREO_FRAME_BYTES);
	for (let index = 0; index < PCM_SAMPLES_PER_CHANNEL; index += 1) {
		const value = Math.max(
			-32_768,
			Math.min(32_767, Math.round(sampleAt(index) * 32_768)),
		);
		frame.writeInt16LE(value, index * 4);
		frame.writeInt16LE(value, index * 4 + 2);
	}
	return frame;
}

const silenceFrame = () => buildFrame(() => 0);

const bedFrame = (amplitude = 0.06) =>
	buildFrame((index) => {
		// One of the box B notes, the way the bed actually renders it.
		const t = index / PCM_SAMPLE_RATE_HZ;
		return amplitude * Math.sin(2 * Math.PI * BOX_B_NOTES_HZ[2] * t);
	});

const voiceFrame = (amplitude = 0.2) => {
	let seed = 7;
	return buildFrame(() => {
		seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
		return amplitude * (seed / 0x3fffffff - 1);
	});
};

test("frameToMono rejects anything that is not exactly one 20ms stereo frame", () => {
	assert.throws(() => frameToMono(Buffer.alloc(3_839)), /exactly 3840 bytes/);
	assert.throws(() => frameToMono(Buffer.alloc(7_680)), /exactly 3840 bytes/);
	const { mono, channelsIdentical } = frameToMono(bedFrame());
	assert.equal(mono.length, PCM_SAMPLES_PER_CHANNEL);
	assert.equal(channelsIdentical, true);
});

test("the classifier separates silence, bed and voice", () => {
	assert.equal(
		classifyFrame(extractFeatures(silenceFrame()), THRESHOLDS),
		"silence",
	);
	assert.equal(classifyFrame(extractFeatures(bedFrame()), THRESHOLDS), "bed");
	assert.equal(
		classifyFrame(extractFeatures(voiceFrame()), THRESHOLDS),
		"voice",
	);
});

test("a bed-plus-voice duck transition never reads as bed", () => {
	// Mixer.ts ducks the bed as voice arrives, so a transition frame carries both
	// box B energy and speech. Filing such a frame as `bed` would let a real voice
	// overlap slip through the post-playback eligibility check.
	const bed = bedFrame(0.06);
	const voice = voiceFrame(0.12);
	const mixed = Buffer.alloc(PCM48_STEREO_FRAME_BYTES);
	for (let index = 0; index < PCM_SAMPLES_PER_CHANNEL; index += 1) {
		const offset = index * 4;
		const value = Math.max(
			-32_768,
			Math.min(
				32_767,
				bed.readInt16LE(offset) * 0.05 + voice.readInt16LE(offset),
			),
		);
		mixed.writeInt16LE(Math.round(value), offset);
		mixed.writeInt16LE(Math.round(value), offset + 2);
	}
	const label = classifyFrame(extractFeatures(mixed), THRESHOLDS);
	assert.ok(label === "voice" || label === "unknown", `got ${label}`);
});

test("an unclassifiable frame becomes unknown rather than being forced into a class", () => {
	// Loud but strongly tonal: matches neither the bed rule (too loud) nor the
	// voice rule (too tonal).
	const loudTone = bedFrame(0.4);
	assert.equal(classifyFrame(extractFeatures(loudTone), THRESHOLDS), "unknown");
});

function denseFrames(fromMonoMs, toMonoMs, audioClass) {
	const frames = [];
	for (let at = fromMonoMs; at <= toMonoMs; at += 20) {
		frames.push({ atMonoMs: at, audioClass });
	}
	return frames;
}

test("unknown blocks the quiet window exactly like voice does", () => {
	const blocked = hasQuietWindow(
		[
			...denseFrames(0, 2_000, "silence"),
			{ atMonoMs: 2_500, audioClass: "unknown" },
			...denseFrames(2_520, 3_000, "silence"),
		],
		{ windowMs: 3_000, nowMonoMs: 3_000 },
	);
	assert.equal(blocked.quiet, false);
	assert.equal(blocked.reason, "blocked_by_unknown");

	// Bed is not a reason to hold back: she is not speaking.
	const quiet = hasQuietWindow(denseFrames(0, 3_000, "bed"), {
		windowMs: 3_000,
		nowMonoMs: 3_000,
	});
	assert.equal(quiet.quiet, true);
});

test("a barely-observed window is never certified as quiet", () => {
	// The shape a real run produced: plenty of frames, all crammed into the last
	// 48ms, with nearly three seconds unobserved. Counting frames alone would
	// call this silence; it is really "we were not looking".
	const crammed = denseFrames(2_952, 3_000, "silence");
	assert.ok(crammed.length > 1);
	const verdict = hasQuietWindow(crammed, {
		windowMs: 3_000,
		nowMonoMs: 3_000,
	});
	assert.equal(verdict.quiet, false);
	assert.equal(verdict.reason, "insufficient_coverage");

	// A single mid-window gap longer than the limit is equally disqualifying.
	const gapped = [
		...denseFrames(0, 1_000, "silence"),
		...denseFrames(2_400, 3_000, "silence"),
	];
	assert.equal(
		hasQuietWindow(gapped, { windowMs: 3_000, nowMonoMs: 3_000 }).reason,
		"insufficient_coverage",
	);

	// Continuous observation of a quiet room does pass.
	assert.equal(
		hasQuietWindow(denseFrames(0, 3_000, "silence"), {
			windowMs: 3_000,
			nowMonoMs: 3_000,
		}).quiet,
		true,
	);
});

test("windowCoverage reports the largest unobserved stretch, edges included", () => {
	const late = windowCoverage(denseFrames(2_900, 3_000, "silence"), {
		startMonoMs: 0,
		endMonoMs: 3_000,
	});
	assert.equal(late.maxGapMs, 2_900);
	assert.ok(late.share < 0.1);

	const full = windowCoverage(denseFrames(0, 3_000, "silence"), {
		startMonoMs: 0,
		endMonoMs: 3_000,
	});
	assert.ok(full.share > 0.9);
	assert.ok(full.maxGapMs <= 20);
});

test("second buckets report holes and discard pre-T0 frames", () => {
	const frames = [];
	for (let index = 0; index < 50; index += 1) {
		frames.push({ atMonoMs: 10_000 + index * 20, audioClass: "voice" });
	}
	// Second 1 is starved: the downlink went away.
	frames.push({ atMonoMs: 11_500, audioClass: "silence" });
	for (let index = 0; index < 50; index += 1) {
		frames.push({ atMonoMs: 12_000 + index * 20, audioClass: "bed" });
	}
	frames.push({ atMonoMs: 9_000, audioClass: "voice" }); // before T0
	const { buckets, holes } = bucketFramesBySecond(frames, { t0MonoMs: 10_000 });
	assert.deepEqual(
		holes.map((hole) => hole.second),
		[1],
	);
	const totals = classSeconds(buckets);
	assert.equal(totals.frames.voice, 50);
	assert.equal(totals.frames.bed, 50);
	assert.equal(totals.seconds.voice, 1);
});

test("a downlink that stops before T1 leaves holes, not silence", () => {
	// The worst case must not read as the best one: if frames stop arriving four
	// seconds before the window closes, those seconds are unobserved and have to
	// be counted as such.
	const frames = [];
	for (let index = 0; index < 50; index += 1) {
		frames.push({ atMonoMs: index * 20, audioClass: "voice" });
	}
	const { holes } = bucketFramesBySecond(frames, {
		t0MonoMs: 0,
		endMonoMs: 5_000,
	});
	assert.deepEqual(
		holes.map((hole) => hole.second),
		[1, 2, 3, 4],
	);

	// Without a known end we can only speak for the seconds we saw.
	assert.equal(bucketFramesBySecond(frames, { t0MonoMs: 0 }).holes.length, 0);
});

test("bed-off arm: a normal probe with no bed is eligible", () => {
	const frames = Array.from({ length: 20 }, (_, index) => ({
		atMonoMs: 1_000 + index * 20,
		audioClass: "silence",
	}));
	const verdict = judgeAudioEligibility(
		{
			playbackCompleted: true,
			playbackStartedAtMonoMs: 1_000,
			playbackEndedAtMonoMs: 1_400,
		},
		{ arm: "off", frames, minBedFrames: 5 },
	);
	assert.equal(verdict.eligible, true);
});

test("bed-off arm: a bed signature escalates to instrumentation failure", () => {
	const frames = Array.from({ length: 20 }, (_, index) => ({
		atMonoMs: 1_000 + index * 20,
		audioClass: index < 6 ? "bed" : "silence",
	}));
	const verdict = judgeAudioEligibility(
		{
			playbackCompleted: true,
			playbackStartedAtMonoMs: 1_000,
			playbackEndedAtMonoMs: 1_400,
		},
		{ arm: "off", frames, minBedFrames: 5 },
	);
	assert.equal(verdict.eligible, false);
	assert.equal(verdict.reason, "bed_present_in_off_arm");
	assert.equal(verdict.instrumentFail, true);
});

test("an ordinary turn is judged on contamination, never on the bed", () => {
	const base = {
		playbackCompleted: true,
		playbackStartedAtMonoMs: 1_000,
		playbackEndedAtMonoMs: 1_400,
	};
	const quiet = Array.from({ length: 20 }, (_, index) => ({
		atMonoMs: 1_000 + index * 20,
		audioClass: "silence",
	}));
	// No bed anywhere, and that is fine: a plain turn claims nothing about it.
	assert.equal(
		judgeAudioEligibility(base, { arm: "turn", frames: quiet }).eligible,
		true,
	);
	// Bed present is equally fine.
	assert.equal(
		judgeAudioEligibility(base, {
			arm: "turn",
			frames: quiet.map((frame) => ({ ...frame, audioClass: "bed" })),
		}).eligible,
		true,
	);
	// But her speaking over our playback still disqualifies it.
	const contaminated = [...quiet];
	contaminated[10] = { atMonoMs: 1_200, audioClass: "voice" };
	assert.equal(
		judgeAudioEligibility(base, { arm: "turn", frames: contaminated }).reason,
		"voice_overlap",
	);
	assert.throws(
		() => judgeAudioEligibility(base, { arm: "sideways", frames: quiet }),
		/arm must be on, off or turn/,
	);
});

test("voice or unknown anywhere in the playback window disqualifies the round", () => {
	const base = {
		playbackCompleted: true,
		playbackStartedAtMonoMs: 1_000,
		playbackEndedAtMonoMs: 1_400,
	};
	const bedFrames = Array.from({ length: 20 }, (_, index) => ({
		atMonoMs: 1_000 + index * 20,
		audioClass: "bed",
	}));
	const withVoice = [...bedFrames];
	withVoice[19] = { atMonoMs: 1_380, audioClass: "voice" };
	assert.equal(
		judgeAudioEligibility(base, {
			arm: "on",
			frames: withVoice,
			minBedFrames: 5,
		}).reason,
		"voice_overlap",
	);
	const withUnknown = [...bedFrames];
	withUnknown[19] = { atMonoMs: 1_380, audioClass: "unknown" };
	assert.equal(
		judgeAudioEligibility(base, {
			arm: "on",
			frames: withUnknown,
			minBedFrames: 5,
		}).reason,
		"ambiguous_audio",
	);
});

test("recognition never decides its own denominator", () => {
	const round = {
		nonce: "kestrel-4417",
		playbackStartedAtMonoMs: 1_000,
		playbackEndedAtMonoMs: 1_400,
	};
	const options = { timeoutMs: 5_000 };

	// No transcript at all is a miss, not an excluded round.
	assert.equal(
		judgeRecognition(round, { ...options, userFinals: [] }).outcome,
		"miss",
	);

	// The wrong nonce is a miss, and we keep what was actually heard.
	const wrongNonce = judgeRecognition(round, {
		...options,
		userFinals: [{ atMonoMs: 2_000, text: "kestrel-9999", transcriptId: "t1" }],
	});
	assert.equal(wrongNonce.outcome, "miss");
	assert.equal(wrongNonce.observedText, "kestrel-9999");

	// Mismatched text is a miss too.
	assert.equal(
		judgeRecognition(round, {
			...options,
			userFinals: [
				{ atMonoMs: 2_000, text: "完全不相干的一句", transcriptId: "t2" },
			],
		}).outcome,
		"miss",
	);

	// And a real match is a hit.
	assert.equal(
		judgeRecognition(round, {
			...options,
			userFinals: [
				{
					atMonoMs: 2_000,
					text: "这句话里有 Kestrel-4417 哦",
					transcriptId: "t3",
				},
			],
		}).outcome,
		"hit",
	);
});

test("the tally closes: attempted = eligible + ineligible, eligible = hit + miss", () => {
	const tally = tallyRounds([
		{ eligible: true, recognition: "hit" },
		{ eligible: true, recognition: "miss" },
		{ eligible: true, recognition: "miss" },
		{ eligible: false, ineligibleReason: "voice_overlap" },
		{ eligible: false, ineligibleReason: "not_in_bed_window" },
	]);
	assert.equal(tally.attempted, 5);
	assert.equal(tally.audioEligible, 3);
	assert.equal(tally.ineligible, 2);
	assert.equal(tally.hit, 1);
	assert.equal(tally.miss, 2);
	assert.equal(tally.audioEligible, tally.hit + tally.miss);
	assert.equal(tally.attempted, tally.audioEligible + tally.ineligible);
	assert.equal(tally.ineligibleByReason.voice_overlap, 1);
});

test("live candidates are filtered on status, not session_status", () => {
	const payload = {
		sessions: [
			{ execution_id: "a", status: "running" },
			{ execution_id: "b", status: "ship_parked" },
			{ execution_id: "c", status: "pending" },
			{ execution_id: "self", status: "running" },
		],
	};
	const candidates = parseLiveCandidates(payload, {
		excludeExecutionIds: ["self"],
	});
	assert.deepEqual(
		candidates.map((candidate) => candidate.executionId),
		["a"],
	);
	// The field that only exists on the /status response must not filter the list.
	assert.equal(
		parseLiveCandidates({
			sessions: [{ execution_id: "a", session_status: "running" }],
		}).length,
		0,
	);
});

test("only a running session with an executing pane counts as orchestration", () => {
	assert.equal(
		parseStatusReceipt({
			execution_id: "a",
			status: "executing",
			session_status: "running",
		}).executing,
		true,
	);
	assert.equal(
		parseStatusReceipt({
			execution_id: "a",
			status: "waiting",
			session_status: "running",
		}).executing,
		false,
	);
	assert.equal(
		parseStatusReceipt({
			execution_id: "a",
			status: "executing",
			session_status: "ship_parked",
		}).executing,
		false,
	);
});

test("sampling errors are instrumentation faults, never zero live sessions", () => {
	const summary = summarizeOrchestrationOverlap([
		{ atMonoMs: 1_000, executionId: "a", executing: true },
		{ atMonoMs: 31_000, executionId: "a", executing: true },
		{ atMonoMs: 61_000, instrumentationError: "http_500" },
	]);
	assert.equal(summary.instrumentationFaults, 1);
	assert.equal(summary.executingSamples, 2);
	assert.equal(summary.qualifyingOverlap, true);
	assert.equal(summary.intervals.length, 1);

	const none = summarizeOrchestrationOverlap([
		{ atMonoMs: 1_000, instrumentationError: "auth" },
	]);
	assert.equal(none.qualifyingOverlap, false);
	assert.equal(none.executingSamples, 0);
});

test("pre-join census does not wait for the emitter, post-join census requires both", () => {
	const preJoin = {
		botVoiceChannels: { voice: "chan", emitter: null },
		channelMemberIds: ["voice"],
	};
	assert.equal(
		voiceReadyCensus(preJoin, {
			voiceBotId: "voice",
			channelId: "chan",
			allowedMemberIds: ["voice", "emitter"],
		}),
		true,
	);
	assert.equal(
		bothPresentCensus(preJoin, {
			voiceBotId: "voice",
			emitterBotId: "emitter",
			channelId: "chan",
		}),
		false,
	);

	const joined = {
		botVoiceChannels: { voice: "chan", emitter: "chan" },
		channelMemberIds: ["voice", "emitter"],
	};
	assert.equal(
		bothPresentCensus(joined, {
			voiceBotId: "voice",
			emitterBotId: "emitter",
			channelId: "chan",
		}),
		true,
	);

	const intruder = {
		botVoiceChannels: { voice: "chan", emitter: "chan" },
		channelMemberIds: ["voice", "emitter", "stranger"],
	};
	assert.equal(
		bothPresentCensus(intruder, {
			voiceBotId: "voice",
			emitterBotId: "emitter",
			channelId: "chan",
		}),
		false,
	);
});

test("a stale receipt from a previous boot is rejected", () => {
	const bootStartedAt = Date.parse("2026-09-06T12:00:00.000Z");
	assert.equal(
		validLiveReceipt(
			{
				threadId: "t",
				processGeneration: 1,
				lastLiveAt: "2026-09-06T11:59:59.000Z",
			},
			bootStartedAt,
		),
		false,
	);
	assert.equal(
		validLiveReceipt(
			{
				threadId: "t",
				processGeneration: 1,
				lastLiveAt: "2026-09-06T12:00:01.000Z",
			},
			bootStartedAt,
		),
		true,
	);
	assert.equal(
		validDiscordReadyReceipt(
			{ lastAnnouncedAt: "2026-09-06T11:00:00.000Z" },
			bootStartedAt,
		),
		false,
	);
});

test("a cleanup failure discovered late still overturns a VALID run", () => {
	const clean = resolveVerdict({
		monotonicDurationMs: MIN_MAIN_RUN_DURATION_MS,
		requireMinDuration: true,
		cleanupErrors: [],
	});
	assert.equal(clean.verdict, "VALID");

	const dirty = resolveVerdict({
		monotonicDurationMs: MIN_MAIN_RUN_DURATION_MS,
		requireMinDuration: true,
		cleanupErrors: ["owned identities remained connected"],
	});
	assert.equal(dirty.verdict, "INVALID");
	assert.ok(dirty.reasons.some((reason) => reason.startsWith("cleanup:")));

	const short = resolveVerdict({
		monotonicDurationMs: MIN_MAIN_RUN_DURATION_MS - 1,
		requireMinDuration: true,
		cleanupErrors: [],
	});
	assert.equal(short.verdict, "INVALID");
	assert.ok(short.reasons.includes("below_min_duration"));
});

test("a run without an executing overlap keeps the third condition open", () => {
	const partial = resolveThreeConditions({
		completedTurns: 9,
		monotonicDurationMs: MIN_MAIN_RUN_DURATION_MS,
		qualifyingOverlap: false,
	});
	assert.equal(partial.allSatisfied, false);
	assert.deepEqual(partial.missing, ["realOrchestrationInFlight"]);

	const full = resolveThreeConditions({
		completedTurns: 9,
		monotonicDurationMs: MIN_MAIN_RUN_DURATION_MS,
		qualifyingOverlap: true,
	});
	assert.equal(full.allSatisfied, true);
});
