// FLY-2383: two orthogonal stages, deliberately kept apart.
//
// Stage one asks whether the audio conditions for a probe actually held. Stage
// two asks whether Raya heard it. They must never be collapsed: if the nonce
// match were also an eligibility condition, every miss would drop out of the
// denominator and the recognition rate would read 100% by construction.
import { windowCoverage } from "./audio-classify.mjs";

export const INELIGIBLE_REASONS = Object.freeze([
	"incomplete_playback",
	"voice_overlap",
	"ambiguous_audio",
	"barge_acted",
	"not_in_bed_window",
	"bed_present_in_off_arm",
	"sampling_fault",
]);

function framesWithin(frames, startMonoMs, endMonoMs) {
	return frames.filter(
		(frame) => frame.atMonoMs >= startMonoMs && frame.atMonoMs <= endMonoMs,
	);
}

/**
 * Stage one. Knows nothing about transcripts.
 *
 * `arm` is "on" (bed expected), "off" (bed expected absent), or "turn" (an
 * ordinary turn, which says nothing about the bed). The three need different
 * rules: reusing the bed-present rule on the bed-off arm would mark every healthy
 * control probe `not_in_bed_window` and leave the control with an empty
 * denominator, and reusing it on an ordinary turn would label every one of them
 * with a reason that does not apply.
 */
export function judgeAudioEligibility(round, options) {
	const {
		arm,
		frames,
		bargeActed = false,
		samplingFault = false,
		minBedFrames,
		tailMs = 0,
		minCoverageShare = 0.6,
		maxCoverageGapMs = 750,
	} = options;
	if (arm !== "on" && arm !== "off" && arm !== "turn") {
		throw new Error("arm must be on, off or turn");
	}
	if (
		arm !== "turn" &&
		(!Number.isSafeInteger(minBedFrames) || minBedFrames <= 0)
	) {
		throw new Error("minBedFrames must be a frozen positive integer");
	}

	if (samplingFault) return { eligible: false, reason: "sampling_fault" };
	if (!round.playbackCompleted) {
		return { eligible: false, reason: "incomplete_playback" };
	}
	if (bargeActed) return { eligible: false, reason: "barge_acted" };

	const startMonoMs = round.playbackStartedAtMonoMs;
	const endMonoMs = round.playbackEndedAtMonoMs + tailMs;
	const window = framesWithin(frames, startMonoMs, endMonoMs);
	if (window.length === 0) return { eligible: false, reason: "sampling_fault" };
	// A playback window we barely observed cannot certify that she stayed quiet
	// through it. Thin coverage is a sampling fault, not a clean round.
	const coverage = windowCoverage(frames, { startMonoMs, endMonoMs });
	if (
		coverage.share < minCoverageShare ||
		coverage.maxGapMs > maxCoverageGapMs
	) {
		return { eligible: false, reason: "sampling_fault", coverage };
	}

	if (window.some((frame) => frame.audioClass === "voice")) {
		return { eligible: false, reason: "voice_overlap" };
	}
	if (window.some((frame) => frame.audioClass === "unknown")) {
		return { eligible: false, reason: "ambiguous_audio" };
	}

	const bedFrames = window.filter((frame) => frame.audioClass === "bed").length;
	// An ordinary turn makes no claim about the bed either way. It only has to be
	// uncontaminated: she must not have started speaking over our playback, which
	// would cancel her response and spoil both halves of the turn tally.
	if (arm === "turn")
		return { eligible: true, reason: null, bedFrames, coverage };
	if (arm === "on") {
		if (bedFrames < minBedFrames) {
			return { eligible: false, reason: "not_in_bed_window" };
		}
		return { eligible: true, reason: null, bedFrames, coverage };
	}

	// Bed-off arm: any bed signature here means the classifier or the negative
	// control is broken. That invalidates the ruler, so it is escalated rather
	// than filed as an ordinary ineligible round.
	if (bedFrames > 0) {
		return {
			eligible: false,
			reason: "bed_present_in_off_arm",
			instrumentFail: true,
			bedFrames,
		};
	}
	return { eligible: true, reason: null, bedFrames: 0, coverage };
}

/**
 * Stage two. Only ever called for rounds that already passed stage one.
 *
 * A round with no transcript at all, a transcript carrying the wrong nonce, and
 * a transcript whose text does not match are all misses — they stay in the
 * denominator.
 */
export function judgeRecognition(round, options) {
	const { userFinals, timeoutMs } = options;
	// How a nonce counts as present is caller-supplied: a spoken transcript
	// rewrites the token (spacing it out, or using Chinese numerals), so plain
	// substring matching on the raw text is not the right test everywhere.
	const matches =
		options.matches ??
		((text, nonce) => normalise(text).includes(normalise(nonce)));
	const deadline = round.playbackEndedAtMonoMs + timeoutMs;
	const candidates = userFinals.filter(
		(entry) =>
			entry.atMonoMs >= round.playbackStartedAtMonoMs &&
			entry.atMonoMs <= deadline,
	);
	const matched = candidates.find((entry) => matches(entry.text, round.nonce));
	if (matched) {
		return {
			outcome: "hit",
			transcriptId: matched.transcriptId ?? null,
			observedText: matched.text,
		};
	}
	return {
		outcome: "miss",
		transcriptId: null,
		// Keep whatever was actually heard, including nothing.
		observedText: candidates.map((entry) => entry.text).join(" | ") || null,
	};
}

function normalise(text) {
	return String(text ?? "")
		.normalize("NFKC")
		.replace(/\s+/gu, "")
		.toLowerCase();
}

/**
 * The ledger has to reconstruct: attempted = audioEligible + ineligible, and
 * audioEligible = hit + miss. A report that cannot close these identities is
 * hiding a round somewhere.
 */
export function tallyRounds(rounds) {
	const ineligibleByReason = Object.fromEntries(
		INELIGIBLE_REASONS.map((reason) => [reason, 0]),
	);
	let audioEligible = 0;
	let hit = 0;
	let miss = 0;
	for (const round of rounds) {
		if (round.eligible) {
			audioEligible += 1;
			if (round.recognition === "hit") hit += 1;
			else if (round.recognition === "miss") miss += 1;
			else throw new Error(`eligible round has no recognition outcome`);
			continue;
		}
		if (!INELIGIBLE_REASONS.includes(round.ineligibleReason)) {
			throw new Error(`unknown ineligible reason: ${round.ineligibleReason}`);
		}
		ineligibleByReason[round.ineligibleReason] += 1;
	}
	const attempted = rounds.length;
	const ineligible = attempted - audioEligible;
	if (audioEligible !== hit + miss) {
		throw new Error("audioEligible must equal hit + miss");
	}
	if (attempted !== audioEligible + ineligible) {
		throw new Error("attempted must equal audioEligible + ineligible");
	}
	return {
		attempted,
		audioEligible,
		ineligible,
		hit,
		miss,
		ineligibleByReason,
	};
}
