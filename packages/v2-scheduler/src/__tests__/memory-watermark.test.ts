import { describe, expect, it } from "vitest";
import {
	deriveMemoryThresholds,
	MemoryWatermark,
	parseVmStat,
} from "../memory-watermark.js";

const GIB = 1024 ** 3;

function vmStat(args: {
	pageSize?: number;
	free: number;
	inactive: number;
	speculative?: number;
	swapouts: number;
}): string {
	return [
		`Mach Virtual Memory Statistics: (page size of ${args.pageSize ?? 16_384} bytes)`,
		`Pages free: ${args.free}.`,
		`Pages inactive: ${args.inactive}.`,
		`Pages speculative: ${args.speculative ?? 0}.`,
		`Swapouts: ${args.swapouts}.`,
	].join("\n");
}

describe("v2 memory watermark", () => {
	it("calibrates a 48GiB/16KiB host to the frozen absolute thresholds", () => {
		expect(deriveMemoryThresholds(48 * GIB, 16_384)).toEqual({
			ramBytes: 48 * GIB,
			pageSizeBytes: 16_384,
			freeTriggerBytes: Math.floor(48 * GIB * 0.08),
			freeClearBytes: Math.floor(48 * GIB * 0.15),
			swapoutMinPagesPerTick: 3072,
		});
	});

	it("keeps the 2GiB/4GiB floors on a 16GiB host", () => {
		const thresholds = deriveMemoryThresholds(16 * GIB, 16_384);
		expect(thresholds.freeTriggerBytes).toBe(2 * GIB);
		expect(thresholds.freeClearBytes).toBe(4 * GIB);
		expect(thresholds.swapoutMinPagesPerTick).toBe(2048);
	});

	it("parses reclaimable pages and rejects incomplete or mismatched readings", () => {
		expect(
			parseVmStat(
				vmStat({
					free: 10,
					inactive: 20,
					speculative: 5,
					swapouts: 99,
				}),
				16_384,
			),
		).toEqual({
			reclaimableBytes: 35 * 16_384,
			swapoutsTotal: 99,
		});
		expect(parseVmStat("Pages free: 1.\nSwapouts: 2.", 16_384)).toBeNull();
		expect(
			parseVmStat(
				vmStat({
					pageSize: 4096,
					free: 10,
					inactive: 20,
					swapouts: 99,
				}),
				16_384,
			),
		).toBeNull();
	});

	it("treats unknown and a fresh swapout baseline as unsafe, then uses hysteresis", () => {
		const thresholds = deriveMemoryThresholds(48 * GIB, 16_384);
		const watermark = new MemoryWatermark(thresholds);
		expect(watermark.observe(null)).toEqual({
			health: "unknown",
			pressureTriggered: true,
			swapoutDelta: null,
		});
		expect(
			watermark.observe({
				reclaimableBytes: thresholds.freeClearBytes + 1,
				swapoutsTotal: 100,
			}),
		).toEqual({
			health: "unknown",
			pressureTriggered: true,
			swapoutDelta: null,
		});
		expect(
			watermark.observe({
				reclaimableBytes: thresholds.freeClearBytes + 1,
				swapoutsTotal: 100 + thresholds.swapoutMinPagesPerTick,
			}),
		).toEqual({
			health: "healthy",
			pressureTriggered: false,
			swapoutDelta: thresholds.swapoutMinPagesPerTick,
		});
		expect(
			watermark.observe({
				reclaimableBytes: thresholds.freeTriggerBytes - 1,
				swapoutsTotal: 100 + thresholds.swapoutMinPagesPerTick,
			}).health,
		).toBe("pressure");
		expect(
			watermark.observe({
				reclaimableBytes: thresholds.freeTriggerBytes + 1,
				swapoutsTotal: 100 + thresholds.swapoutMinPagesPerTick,
			}).health,
		).toBe("pressure");
		expect(
			watermark.observe({
				reclaimableBytes: thresholds.freeClearBytes,
				swapoutsTotal: 100 + thresholds.swapoutMinPagesPerTick,
			}).health,
		).toBe("healthy");
	});
});
