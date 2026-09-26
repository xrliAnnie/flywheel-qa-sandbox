/**
 * FLY-927 (Task 1.4, T1): fixed-window token bucket + overflow summary.
 */
import { describe, expect, it } from "vitest";
import { ALERT_ECHO_START } from "../../LeadWatchdog.js";
import {
	createAlertRateLimiter,
	formatOverflowSummary,
	rateLimitPerMinuteFromEnv,
} from "../alert-rate-limiter.js";

describe("createAlertRateLimiter", () => {
	it("allows exactly perMinute acquisitions within one window", () => {
		const rl = createAlertRateLimiter(20);
		const t0 = 1_000_000_000_000; // arbitrary epoch
		for (let i = 0; i < 20; i++) {
			expect(rl.tryAcquire(t0 + i * 100)).toBe(true);
		}
		expect(rl.tryAcquire(t0 + 5_000)).toBe(false);
	});

	it("window rollover refills the bucket", () => {
		const rl = createAlertRateLimiter(2);
		const t0 = 1_000_000_020_000;
		expect(rl.tryAcquire(t0)).toBe(true);
		expect(rl.tryAcquire(t0)).toBe(true);
		expect(rl.tryAcquire(t0)).toBe(false);
		// next minute window
		expect(rl.tryAcquire(t0 + 60_000)).toBe(true);
	});

	it("overflow counts accumulate per kind and clear only on clearOverflow", () => {
		const rl = createAlertRateLimiter(1);
		expect(rl.peekOverflow()).toBeNull();
		rl.noteOverflow("rate_limit");
		rl.noteOverflow("rate_limit");
		rl.noteOverflow("usage_limit");
		expect(rl.peekOverflow()).toEqual(
			new Map([
				["rate_limit", 2],
				["usage_limit", 1],
			]),
		);
		// peek does not clear
		expect(rl.peekOverflow()?.size).toBe(2);
		rl.clearOverflow();
		expect(rl.peekOverflow()).toBeNull();
	});
});

describe("formatOverflowSummary", () => {
	it("renders total + per-kind counts, sorted", () => {
		const s = formatOverflowSummary(
			new Map([
				["usage_limit", 1],
				["rate_limit", 2],
			]),
		);
		expect(s).toBe(
			"🎫 速率攒批:3 条告警已入队(rate_limit×2、usage_limit×1),将随队列陆续投递。",
		);
	});

	it("is echo-strippable (🎫 branch) and carries NO (leadId / kind) anchor", () => {
		const s = formatOverflowSummary(new Map([["rate_limit", 5]]));
		expect(ALERT_ECHO_START.test(s)).toBe(true); // 🎫 branch strips it
		expect(s).not.toMatch(/\(\s*[a-z0-9-]+\s*\/\s*[a-z_]+\s*\)/); // no alert anchor
	});
});

describe("rateLimitPerMinuteFromEnv", () => {
	it("unset / invalid / non-positive → null (no limiting)", () => {
		expect(rateLimitPerMinuteFromEnv({})).toBeNull();
		expect(
			rateLimitPerMinuteFromEnv({ FLYWHEEL_ALERT_RATE_PER_MIN: "abc" }),
		).toBeNull();
		expect(
			rateLimitPerMinuteFromEnv({ FLYWHEEL_ALERT_RATE_PER_MIN: "0" }),
		).toBeNull();
		expect(
			rateLimitPerMinuteFromEnv({ FLYWHEEL_ALERT_RATE_PER_MIN: "-3" }),
		).toBeNull();
	});
	it("positive integer parses", () => {
		expect(
			rateLimitPerMinuteFromEnv({ FLYWHEEL_ALERT_RATE_PER_MIN: "20" }),
		).toBe(20);
	});
});
