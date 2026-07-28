import { describe, expect, it } from "vitest";
import {
	DEFAULT_SCHEDULER_CONFIG,
	resolveSchedulerConfig,
	validateSchedulerConfig,
} from "../config.js";

describe("SchedulerConfig", () => {
	it("freezes one conservative default object", () => {
		expect(DEFAULT_SCHEDULER_CONFIG).toMatchObject({
			heartbeatStaleMs: 30_000,
			heartbeatConfirmMs: 15_000,
			hardTimeoutMs: 55_000,
			restartConcurrencyMax: 1,
			pressureDecreaseWindowMs: 2000,
			healthyIncreaseWindowMs: 180_000,
			freeTriggerPercent: 8,
			freeClearPercent: 15,
			freeTriggerFloorBytes: 2 * 1024 ** 3,
			freeClearFloorBytes: 4 * 1024 ** 3,
			swapoutRamDivisor: 1024,
			swapoutFloorPages: 2048,
		});
	});

	it("allows only the explicit concurrency tuning env and validates it canonically", () => {
		expect(
			resolveSchedulerConfig({
				FLYWHEEL_V2_RESTART_CONCURRENCY_MAX: "4",
			}).restartConcurrencyMax,
		).toBe(4);
		expect(() =>
			resolveSchedulerConfig({
				FLYWHEEL_V2_RESTART_CONCURRENCY_MAX: "04",
			}),
		).toThrow(/canonical positive integer/i);
		expect(() =>
			resolveSchedulerConfig({
				FLYWHEEL_V2_RESTART_CONCURRENCY_MAX: "0",
			}),
		).toThrow();
	});

	it("rejects contradictory timeout, retry, and watermark values", () => {
		expect(() =>
			validateSchedulerConfig({
				...DEFAULT_SCHEDULER_CONFIG,
				repairLeaseMs: DEFAULT_SCHEDULER_CONFIG.hardTimeoutMs - 1,
			}),
		).toThrow(/lease/i);
		expect(() =>
			validateSchedulerConfig({
				...DEFAULT_SCHEDULER_CONFIG,
				retryBaseMs: 10,
				retryCapMs: 9,
			}),
		).toThrow(/retry/i);
		expect(() =>
			validateSchedulerConfig({
				...DEFAULT_SCHEDULER_CONFIG,
				freeTriggerPercent: 16,
				freeClearPercent: 15,
			}),
		).toThrow(/free/i);
	});
});
