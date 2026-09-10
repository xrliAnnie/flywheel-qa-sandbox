import { describe, expect, it } from "vitest";
import { parseVoiceSessionTiming } from "../config.js";

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
