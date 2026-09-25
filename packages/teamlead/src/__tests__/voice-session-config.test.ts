import { describe, expect, it } from "vitest";
import {
	parseHeadphoneBootstrapWindowMs,
	parseVoiceSessionTiming,
} from "../config.js";

describe("voice session timing config", () => {
	it("uses the reviewed lease and recovery defaults", () => {
		expect(parseVoiceSessionTiming({})).toEqual({
			leaseTtlMs: 15_000,
			leaseRenewMs: 4_000,
			leaseHttpTimeoutMs: 2_000,
			clockSkewGraceMs: 5_000,
			provisioningStaleMs: 120_000,
			endingTimeoutMs: 30_000,
			pollIntervalMs: 3_000,
		});
	});

	it("rejects a renewal budget that is not below half the TTL", () => {
		expect(() =>
			parseVoiceSessionTiming({
				FLYWHEEL_VOICE_LEASE_TTL_MS: "12000",
				FLYWHEEL_VOICE_LEASE_RENEW_MS: "4000",
				FLYWHEEL_VOICE_LEASE_HTTP_TIMEOUT_MS: "2000",
			}),
		).toThrow("renew + http timeout must be less than half the lease TTL");
	});

	it("rejects non-positive or non-integer values", () => {
		expect(() =>
			parseVoiceSessionTiming({ FLYWHEEL_VOICE_POLL_INTERVAL_MS: "0" }),
		).toThrow(/FLYWHEEL_VOICE_POLL_INTERVAL_MS/);
		expect(() =>
			parseVoiceSessionTiming({ FLYWHEEL_VOICE_ENDING_TIMEOUT_MS: "1.5" }),
		).toThrow(/FLYWHEEL_VOICE_ENDING_TIMEOUT_MS/);
	});
});

describe("headphone backfill window config (FLY-2863 F1)", () => {
	it("defaults to 24 hours and accepts a positive integer override", () => {
		expect(parseHeadphoneBootstrapWindowMs({})).toBe(86_400_000);
		expect(
			parseHeadphoneBootstrapWindowMs({
				FLYWHEEL_HEADPHONE_BOOTSTRAP_WINDOW_MS: "3600000",
			}),
		).toBe(3_600_000);
	});

	it("rejects a window that is not a positive integer", () => {
		for (const bad of ["0", "1.5", "24h", ""])
			expect(() =>
				parseHeadphoneBootstrapWindowMs({
					FLYWHEEL_HEADPHONE_BOOTSTRAP_WINDOW_MS: bad,
				}),
			).toThrow(/FLYWHEEL_HEADPHONE_BOOTSTRAP_WINDOW_MS/);
	});
});
