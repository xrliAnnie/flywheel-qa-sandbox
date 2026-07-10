/**
 * FLY-1082 (Task 2.1): swap watermark parsing + hysteresis state machine.
 */
import { describe, expect, it } from "vitest";
import {
	parseVmSwapUsage,
	SwapPressureMonitor,
	swapThresholdsFromEnv,
} from "../machine-watermark.js";

// Real `sysctl vm.swapusage` output captured on the production box (2026-07-09
// incident-era shape).
const REAL =
	"vm.swapusage: total = 15360.00M  used = 14140.00M  free = 1220.00M  (encrypted)";

describe("parseVmSwapUsage", () => {
	it("parses the real sysctl output", () => {
		const u = parseVmSwapUsage(REAL);
		expect(u).not.toBeNull();
		expect(u!.totalBytes).toBe(15360 * 1024 ** 2);
		expect(u!.usedBytes).toBe(14140 * 1024 ** 2);
		expect(u!.usedPct).toBeCloseTo((14140 / 15360) * 100, 3);
	});

	it("incident-day watermark (14815/16384M) reads ~90.4%", () => {
		const u = parseVmSwapUsage(
			"vm.swapusage: total = 16384.00M  used = 14815.75M  free = 1568.25M  (encrypted)",
		);
		expect(u!.usedPct).toBeGreaterThan(90);
	});

	it("zero-total swap yields usedPct null (no swap configured)", () => {
		const u = parseVmSwapUsage(
			"vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M",
		);
		expect(u).not.toBeNull();
		expect(u!.usedPct).toBeNull();
	});

	it("garbage returns null", () => {
		expect(parseVmSwapUsage("nonsense")).toBeNull();
		expect(parseVmSwapUsage("")).toBeNull();
	});
});

describe("swapThresholdsFromEnv", () => {
	it("defaults 80/65", () => {
		expect(swapThresholdsFromEnv({} as NodeJS.ProcessEnv)).toEqual({
			highPct: 80,
			lowPct: 65,
		});
	});

	it("env overrides + inverted band clamps LOW to HIGH", () => {
		expect(
			swapThresholdsFromEnv({
				FLYWHEEL_SWAP_PRESSURE_HIGH_PCT: "70",
				FLYWHEEL_SWAP_PRESSURE_LOW_PCT: "90",
			} as unknown as NodeJS.ProcessEnv),
		).toEqual({ highPct: 70, lowPct: 70 });
	});

	it("garbage envs fall back to defaults", () => {
		expect(
			swapThresholdsFromEnv({
				FLYWHEEL_SWAP_PRESSURE_HIGH_PCT: "nope",
				FLYWHEEL_SWAP_PRESSURE_LOW_PCT: "-3",
			} as unknown as NodeJS.ProcessEnv),
		).toEqual({ highPct: 80, lowPct: 65 });
	});
});

describe("SwapPressureMonitor (hysteresis + 2-tick confirm)", () => {
	const usage = (pct: number) => ({
		totalBytes: 100,
		usedBytes: pct,
		usedPct: pct,
	});

	it("triggers only on the 2nd consecutive high tick", () => {
		const m = new SwapPressureMonitor({ highPct: 80, lowPct: 65 });
		expect(m.tick(usage(85), 1)).toBe("none");
		expect(m.tick(usage(86), 2)).toBe("trigger");
		expect(m.inPressure).toBe(true);
		expect(m.episodeStart).toBe(2);
	});

	it("a single spike does not trigger (counter resets)", () => {
		const m = new SwapPressureMonitor({ highPct: 80, lowPct: 65 });
		expect(m.tick(usage(85), 1)).toBe("none");
		expect(m.tick(usage(50), 2)).toBe("none");
		expect(m.tick(usage(85), 3)).toBe("none"); // counter restarted
		expect(m.inPressure).toBe(false);
	});

	it("oscillation inside the band never re-triggers; clears only below LOW", () => {
		const m = new SwapPressureMonitor({ highPct: 80, lowPct: 65 });
		m.tick(usage(85), 1);
		expect(m.tick(usage(85), 2)).toBe("trigger");
		expect(m.tick(usage(70), 3)).toBe("none"); // between LOW and HIGH — hold
		expect(m.tick(usage(90), 4)).toBe("none"); // back above HIGH — same episode
		expect(m.tick(usage(60), 5)).toBe("clear");
		expect(m.inPressure).toBe(false);
		expect(m.episodeStart).toBeNull();
	});

	it("probe failure (null) never changes state", () => {
		const m = new SwapPressureMonitor({ highPct: 80, lowPct: 65 });
		m.tick(usage(85), 1);
		m.tick(usage(85), 2); // trigger
		expect(m.tick(null, 3)).toBe("none");
		expect(m.inPressure).toBe(true); // failure ≠ recovery
	});

	it("a new episode after clear triggers again (fresh episode stamp)", () => {
		const m = new SwapPressureMonitor({ highPct: 80, lowPct: 65 });
		m.tick(usage(85), 1);
		m.tick(usage(85), 2);
		m.tick(usage(50), 3); // clear
		m.tick(usage(85), 4);
		expect(m.tick(usage(85), 5)).toBe("trigger");
		expect(m.episodeStart).toBe(5);
	});
});
