import { describe, expect, it } from "vitest";
import { deriveFly2139RetentionRates } from "../../../../scripts/lib/fly-2139-retention-rates.mjs";

describe("FLY-2139 retention throughput observation", () => {
	it("alerts only after mint exceeds drain for two consecutive cycles", () => {
		const result = deriveFly2139RetentionRates({
			current: {
				candidateCount: 460,
				observedAt: "2026-08-29T01:00:00.000Z",
			},
			previous: {
				candidateCount: 0,
				observedAt: "2026-08-29T00:00:00.000Z",
				drainRatePerHour: 300,
				mintExceedsDrainStreak: 1,
			},
		});

		expect(result).toMatchObject({
			candidateCount: 460,
			observedAt: "2026-08-29T01:00:00.000Z",
			previousCandidateCount: 0,
			elapsedHours: 1,
			mintRatePerHour: 460,
			drainRatePerHour: 300,
			drainRateSource: "previous_apply",
			mintExceedsDrain: true,
			mintExceedsDrainStreak: 2,
			alert: true,
		});
	});

	it("uses the current apply receipt for drain rate and resets a recovered streak", () => {
		const result = deriveFly2139RetentionRates({
			current: {
				candidateCount: 100,
				observedAt: "2026-08-29T02:00:00.000Z",
			},
			previous: {
				candidateCount: 50,
				observedAt: "2026-08-29T01:00:00.000Z",
				drainRatePerHour: 10,
				mintExceedsDrainStreak: 3,
			},
			apply: { deletedCount: 100, durationMs: 30 * 60 * 1_000 },
		});

		expect(result).toMatchObject({
			mintRatePerHour: 50,
			drainRatePerHour: 200,
			drainRateSource: "current_apply",
			mintExceedsDrain: false,
			mintExceedsDrainStreak: 0,
			alert: false,
		});
	});

	it("keeps rates unavailable until it has two observations and one apply", () => {
		expect(
			deriveFly2139RetentionRates({
				current: {
					candidateCount: 25,
					observedAt: "2026-08-29T02:00:00.000Z",
				},
			}),
		).toMatchObject({
			mintRatePerHour: null,
			drainRatePerHour: null,
			mintExceedsDrain: null,
			mintExceedsDrainStreak: 0,
			alert: false,
		});
	});
});
