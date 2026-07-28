import { DEFAULT_SCHEDULER_CONFIG, type SchedulerConfig } from "./config.js";

export interface MemoryThresholds {
	ramBytes: number;
	pageSizeBytes: number;
	freeTriggerBytes: number;
	freeClearBytes: number;
	swapoutMinPagesPerTick: number;
}

export interface MemorySample {
	reclaimableBytes: number;
	swapoutsTotal: number;
}

export type MemoryHealth = "healthy" | "pressure" | "unknown";

export interface MemoryObservation {
	health: MemoryHealth;
	pressureTriggered: boolean;
	swapoutDelta: number | null;
}

function requirePositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer`);
	}
}

export function deriveMemoryThresholds(
	ramBytes: number,
	pageSizeBytes: number,
	config: Pick<
		SchedulerConfig,
		| "freeTriggerPercent"
		| "freeClearPercent"
		| "freeTriggerFloorBytes"
		| "freeClearFloorBytes"
		| "swapoutRamDivisor"
		| "swapoutFloorPages"
	> = DEFAULT_SCHEDULER_CONFIG,
): MemoryThresholds {
	requirePositiveInteger(ramBytes, "ramBytes");
	requirePositiveInteger(pageSizeBytes, "pageSizeBytes");
	return {
		ramBytes,
		pageSizeBytes,
		freeTriggerBytes: Math.max(
			Math.floor((ramBytes * config.freeTriggerPercent) / 100),
			config.freeTriggerFloorBytes,
		),
		freeClearBytes: Math.max(
			Math.floor((ramBytes * config.freeClearPercent) / 100),
			config.freeClearFloorBytes,
		),
		swapoutMinPagesPerTick: Math.max(
			config.swapoutFloorPages,
			Math.floor(ramBytes / config.swapoutRamDivisor / pageSizeBytes),
		),
	};
}

function parseCount(output: string, label: string): number | null {
	const match = new RegExp(`^${label}:\\s+([0-9]+)\\.$`, "m").exec(output);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isSafeInteger(value) ? value : null;
}

export function parseVmStat(
	output: string,
	expectedPageSizeBytes: number,
): MemorySample | null {
	requirePositiveInteger(expectedPageSizeBytes, "expectedPageSizeBytes");
	const header = /page size of ([0-9]+) bytes/.exec(output);
	if (!header || Number(header[1]) !== expectedPageSizeBytes) return null;
	const free = parseCount(output, "Pages free");
	const inactive = parseCount(output, "Pages inactive");
	const speculative = parseCount(output, "Pages speculative");
	const swapouts = parseCount(output, "Swapouts");
	if (
		free === null ||
		inactive === null ||
		speculative === null ||
		swapouts === null
	) {
		return null;
	}
	const pages = free + inactive + speculative;
	if (!Number.isSafeInteger(pages)) return null;
	return {
		reclaimableBytes: pages * expectedPageSizeBytes,
		swapoutsTotal: swapouts,
	};
}

export class MemoryWatermark {
	private health: MemoryHealth = "unknown";
	private lastSwapoutsTotal: number | null = null;

	constructor(private readonly thresholds: MemoryThresholds) {}

	observe(sample: MemorySample | null): MemoryObservation {
		if (
			!sample ||
			!Number.isSafeInteger(sample.reclaimableBytes) ||
			sample.reclaimableBytes < 0 ||
			!Number.isSafeInteger(sample.swapoutsTotal) ||
			sample.swapoutsTotal < 0
		) {
			this.health = "unknown";
			return {
				health: "unknown",
				pressureTriggered: true,
				swapoutDelta: null,
			};
		}

		let swapoutDelta: number | null = null;
		if (this.lastSwapoutsTotal !== null) {
			const delta = sample.swapoutsTotal - this.lastSwapoutsTotal;
			swapoutDelta = delta >= 0 ? delta : null;
		}
		this.lastSwapoutsTotal = sample.swapoutsTotal;

		const lowFree = sample.reclaimableBytes < this.thresholds.freeTriggerBytes;
		const activeSwapout =
			swapoutDelta === null ||
			swapoutDelta > this.thresholds.swapoutMinPagesPerTick;
		if (lowFree || (swapoutDelta !== null && activeSwapout)) {
			this.health = "pressure";
			return {
				health: this.health,
				pressureTriggered: true,
				swapoutDelta,
			};
		}

		const provenClear =
			sample.reclaimableBytes >= this.thresholds.freeClearBytes &&
			!activeSwapout;
		if (provenClear) {
			this.health = "healthy";
		} else if (this.health !== "healthy") {
			this.health = this.health === "pressure" ? "pressure" : "unknown";
		}
		return {
			health: this.health,
			pressureTriggered: this.health !== "healthy",
			swapoutDelta,
		};
	}
}
