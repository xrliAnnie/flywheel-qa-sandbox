import { pathToFileURL } from "node:url";

export const MINT_EXCEEDS_DRAIN_ALERT_CYCLES = 2;

function nonNegativeInteger(value, field) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`retention_rate_invalid:${field}`);
	}
	return value;
}

function timestampMs(value, field) {
	const parsed = Date.parse(value ?? "");
	if (!Number.isFinite(parsed)) {
		throw new Error(`retention_rate_invalid:${field}`);
	}
	return parsed;
}

function roundedRate(value) {
	return Math.round(value * 1_000_000) / 1_000_000;
}

export function deriveFly2139RetentionRates({ current, previous, apply }) {
	const candidateCount = nonNegativeInteger(
		current?.candidateCount,
		"current_candidate_count",
	);
	const observedAtMs = timestampMs(current?.observedAt, "current_observed_at");
	let previousCandidateCount = null;
	let elapsedHours = null;
	let mintRatePerHour = null;
	let previousDrainRate = null;
	let previousStreak = 0;

	if (previous) {
		previousCandidateCount = nonNegativeInteger(
			previous.candidateCount,
			"previous_candidate_count",
		);
		const previousObservedAtMs = timestampMs(
			previous.observedAt,
			"previous_observed_at",
		);
		const elapsedMs = observedAtMs - previousObservedAtMs;
		if (elapsedMs <= 0) throw new Error("retention_rate_non_monotonic_time");
		elapsedHours = roundedRate(elapsedMs / 3_600_000);
		mintRatePerHour = roundedRate(
			Math.max(0, candidateCount - previousCandidateCount) /
				(elapsedMs / 3_600_000),
		);
		if (
			previous.drainRatePerHour !== null &&
			previous.drainRatePerHour !== undefined
		) {
			if (
				typeof previous.drainRatePerHour !== "number" ||
				!Number.isFinite(previous.drainRatePerHour) ||
				previous.drainRatePerHour < 0
			) {
				throw new Error("retention_rate_invalid:previous_drain_rate");
			}
			previousDrainRate = previous.drainRatePerHour;
		}
		previousStreak = nonNegativeInteger(
			previous.mintExceedsDrainStreak ?? 0,
			"previous_streak",
		);
	}

	let drainRatePerHour = previousDrainRate;
	let drainRateSource =
		previousDrainRate === null ? "unavailable" : "previous_apply";
	if (apply) {
		const deletedCount = nonNegativeInteger(
			apply.deletedCount,
			"deleted_count",
		);
		if (
			typeof apply.durationMs !== "number" ||
			!Number.isFinite(apply.durationMs) ||
			apply.durationMs <= 0
		) {
			throw new Error("retention_rate_invalid:apply_duration_ms");
		}
		drainRatePerHour = roundedRate(
			(deletedCount * 3_600_000) / apply.durationMs,
		);
		drainRateSource = "current_apply";
	}

	const mintExceedsDrain =
		mintRatePerHour === null || drainRatePerHour === null
			? null
			: mintRatePerHour > drainRatePerHour;
	const mintExceedsDrainStreak =
		mintExceedsDrain === true ? previousStreak + 1 : 0;

	// 460 families/hour minted versus 300 drained is a calibration example, not
	// a threshold. Alerting is based on the observed ordering for two cycles.
	return {
		candidateCount,
		observedAt: current.observedAt,
		previousCandidateCount,
		elapsedHours,
		mintRatePerHour,
		drainRatePerHour,
		drainRateSource,
		mintExceedsDrain,
		mintExceedsDrainStreak,
		alert: mintExceedsDrainStreak >= MINT_EXCEEDS_DRAIN_ALERT_CYCLES,
	};
}

function parseCliJson(argv, name, required = false) {
	const index = argv.indexOf(name);
	if (index === -1) {
		if (required) throw new Error(`missing_argument:${name}`);
		return undefined;
	}
	if (!argv[index + 1]) throw new Error(`missing_argument:${name}`);
	return JSON.parse(argv[index + 1]);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const argv = process.argv.slice(2);
		const result = deriveFly2139RetentionRates({
			current: parseCliJson(argv, "--current-json", true),
			previous: parseCliJson(argv, "--previous-json"),
			apply: parseCliJson(argv, "--apply-json"),
		});
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		process.stderr.write(
			`fly2139_retention_rate_error: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
