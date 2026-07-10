/**
 * FLY-1082 (Task 2.1): the machine swap-watermark sensor — the OOM early
 * warning the 2026-07-09 incident never got (swap climbed for 30+ minutes
 * before the Bridge died; nothing was reading it).
 *
 * Deliberately a STANDALONE module: FLY-1072 (dispatch watermark gating /
 * concurrency control) consumes the SAME readings through these exports —
 * the sensor exists exactly once. This module is pure detection + hysteresis;
 * the ticket/ARC wiring lives in fleet-sensors.ts.
 *
 * Hysteresis + 2-tick confirmation (FLY-1048 multi-frame precedent): the
 * HIGH threshold (default 80%) must hold for 2 consecutive ticks to trigger,
 * and the episode clears only below the LOW threshold (default 65%) — an
 * oscillating watermark never re-fires inside one episode.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SwapUsage {
	totalBytes: number;
	usedBytes: number;
	/** used/total in percent; null when total is 0 (no swap configured). */
	usedPct: number | null;
}

/**
 * Parse `sysctl vm.swapusage` output, e.g.
 * `vm.swapusage: total = 16384.00M  used = 14815.75M  free = 1568.25M  (encrypted)`.
 * Returns null on any unrecognized shape (fail-quiet: the sensor skips the
 * tick rather than alerting on garbage).
 */
export function parseVmSwapUsage(out: string): SwapUsage | null {
	const num = (label: string): number | null => {
		const m = out.match(new RegExp(`${label}\\s*=\\s*([\\d.]+)([KMGT]?)`, "i"));
		if (!m) return null;
		const scale =
			{ "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[
				(m[2] ?? "").toUpperCase()
			] ?? 1;
		const v = Number(m[1]);
		return Number.isFinite(v) ? v * scale : null;
	};
	const total = num("total");
	const used = num("used");
	if (total == null || used == null) return null;
	return {
		totalBytes: total,
		usedBytes: used,
		usedPct: total > 0 ? (used / total) * 100 : null,
	};
}

/**
 * Read the current swap usage. `FLYWHEEL_SWAP_SENSOR_CMD` overrides the real
 * `sysctl vm.swapusage` with an arbitrary shell command emitting the SAME
 * output format — the QA injection seam (fake readings without touching real
 * memory). Any probe/parse failure returns null (skip the tick).
 */
export async function readSwapUsage(
	env: NodeJS.ProcessEnv = process.env,
): Promise<SwapUsage | null> {
	try {
		const override = env.FLYWHEEL_SWAP_SENSOR_CMD?.trim();
		const { stdout } = override
			? await execFileAsync("/bin/sh", ["-c", override], { timeout: 5000 })
			: await execFileAsync("sysctl", ["vm.swapusage"], { timeout: 5000 });
		return parseVmSwapUsage(stdout);
	} catch {
		return null;
	}
}

/** Env-tunable thresholds (percent). HIGH default 80, LOW default 65. */
export function swapThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): {
	highPct: number;
	lowPct: number;
} {
	const read = (name: string, fallback: number): number => {
		const v = Number(env[name]);
		return Number.isFinite(v) && v > 0 && v <= 100 ? v : fallback;
	};
	const highPct = read("FLYWHEEL_SWAP_PRESSURE_HIGH_PCT", 80);
	let lowPct = read("FLYWHEEL_SWAP_PRESSURE_LOW_PCT", 65);
	// A LOW above HIGH would make the hysteresis band inverted (instant
	// clear) — clamp to HIGH so misconfiguration degrades to plain threshold.
	if (lowPct > highPct) lowPct = highPct;
	return { highPct, lowPct };
}

export type SwapPressureEvent = "none" | "trigger" | "clear";

/**
 * The hysteresis state machine. `tick()` is fed one reading per watchdog poll:
 *  - normal → 2 consecutive readings ≥ HIGH → "trigger" (enter pressure);
 *  - pressure → reading < LOW → "clear" (exit); anything in between → "none";
 *  - a null/undefined reading never changes state (probe failure ≠ recovery).
 */
export class SwapPressureMonitor {
	private consecutiveHigh = 0;
	private pressure = false;
	/** Stamp of the trigger instant — the episode identity for dedup. */
	private episodeStartedAt: number | null = null;

	constructor(
		private readonly thresholds: { highPct: number; lowPct: number },
		private readonly confirmTicks = 2,
	) {}

	get inPressure(): boolean {
		return this.pressure;
	}

	get episodeStart(): number | null {
		return this.episodeStartedAt;
	}

	tick(usage: SwapUsage | null | undefined, nowMs: number): SwapPressureEvent {
		const pct = usage?.usedPct;
		if (pct == null) return "none"; // probe failure / no swap — hold state
		if (this.pressure) {
			if (pct < this.thresholds.lowPct) {
				this.pressure = false;
				this.consecutiveHigh = 0;
				this.episodeStartedAt = null;
				return "clear";
			}
			return "none"; // still in the episode — never re-trigger
		}
		if (pct >= this.thresholds.highPct) {
			this.consecutiveHigh++;
			if (this.consecutiveHigh >= this.confirmTicks) {
				this.pressure = true;
				this.episodeStartedAt = nowMs;
				return "trigger";
			}
			return "none";
		}
		this.consecutiveHigh = 0;
		return "none";
	}
}
