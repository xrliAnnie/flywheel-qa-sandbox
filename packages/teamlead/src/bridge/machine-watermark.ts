/**
 * FLY-1082 (Task 2.1) → FLY-1142: the machine memory-pressure sensor — the
 * OOM early warning the 2026-07-09 incident never got.
 *
 * FLY-1142 root-cure: the first generation watched the sysctl swap watermark
 * (swap used-%). macOS swap usage is MONOTONIC — it never shrinks without
 * a reboot — so one OOM scar left the watermark above LOW forever and the
 * 2026-07-10 pressure-hold stayed stranded for 8+ hours on a measurably
 * healthy machine (41–50% free, zero swapout). The sensor now reads REAL
 * pressure from `vm_stat`:
 *
 *  - free%        = (Pages free + Pages inactive) / Σ(all seven visible
 *                   buckets) — a pure page-count ratio, so the 16384-vs-4096
 *                   page-size trap (vm_stat header vs `sysctl hw.pagesize`)
 *                   never enters the formula;
 *  - swapout-delta = the `Swapouts` cumulative counter's increment between
 *                   two watchdog ticks — "is the machine thrashing NOW",
 *                   which (unlike the watermark) returns to zero.
 *
 * Deliberately a STANDALONE module: pure detection + hysteresis; the
 * ticket/ARC wiring lives in fleet-sensors.ts.
 *
 * Trigger is OR (either low free% or sustained swapout), sustained for 2
 * consecutive ticks (FLY-1048 multi-frame precedent). Release is AND with
 * three-state health evidence: clear/lift happens ONLY on a sample that
 * PROVES health (free% ≥ HIGH and delta ≤ MIN with delta computable) —
 * an unknown delta (first sample after restart, counter regression, probe
 * failure) is `healthy = null` and never releases anything.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One vm_stat reading reduced to the sensor's business fields. */
export interface MemoryPressure {
	/** (free+inactive)/Σ(7 buckets) × 100 — pure page-count ratio. */
	freePct: number;
	/** Cumulative `Swapouts` counter (monotonic; the DELTA is the signal). */
	swapoutsTotal: number;
	/** From the vm_stat header — diagnostics only, never enters freePct. */
	pageSize: number | null;
}

const VM_STAT_BUCKETS = [
	"Pages free",
	"Pages active",
	"Pages inactive",
	"Pages speculative",
	"Pages throttled",
	"Pages wired down",
	"Pages occupied by compressor",
] as const;

/**
 * Parse `vm_stat` output. Every bucket + Swapouts must parse to a finite
 * non-negative count and the denominator must be positive, else the WHOLE
 * reading is null (fail-quiet: the sensor skips the tick rather than acting
 * on a partial denominator).
 */
export function parseVmStat(out: string): MemoryPressure | null {
	const count = (label: string): number | null => {
		// Anchored full-label match so e.g. "Pages stored in compressor" can
		// never stand in for "Pages occupied by compressor".
		const m = out.match(new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m"));
		if (!m) return null;
		const v = Number(m[1]);
		return Number.isFinite(v) ? v : null;
	};
	const buckets: number[] = [];
	for (const label of VM_STAT_BUCKETS) {
		const v = count(label);
		if (v == null) return null;
		buckets.push(v);
	}
	const swapouts = count("Swapouts");
	if (swapouts == null) return null;
	const total = buckets.reduce((a, b) => a + b, 0);
	if (!(total > 0) || !Number.isFinite(total)) return null;
	const free = buckets[0]!;
	const inactive = buckets[2]!;
	const pageSizeMatch = out.match(/page size of (\d+) bytes/);
	const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : null;
	return {
		freePct: ((free + inactive) / total) * 100,
		swapoutsTotal: swapouts,
		pageSize: Number.isFinite(pageSize as number) ? pageSize : null,
	};
}

/**
 * Read the current memory pressure. `FLYWHEEL_SWAP_SENSOR_CMD` overrides the
 * real `vm_stat` with an arbitrary shell command emitting the SAME (vm_stat)
 * output format — the QA injection seam (fake readings without touching real
 * memory). Any probe/parse failure returns null (skip the tick).
 */
export async function readMemoryPressure(
	env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryPressure | null> {
	try {
		const override = env.FLYWHEEL_SWAP_SENSOR_CMD?.trim();
		const { stdout } = override
			? await execFileAsync("/bin/sh", ["-c", override], { timeout: 5000 })
			: await execFileAsync("vm_stat", [], { timeout: 5000 });
		return parseVmStat(stdout);
	} catch {
		return null;
	}
}

/**
 * Env-tunable thresholds. Percent knobs share the percent validator
 * (0 < v ≤ 100, else default); the swapout floor has its OWN validator —
 * a page-count noise floor is a non-negative integer where 0 and values
 * far above 100 are both perfectly legal.
 *
 * Defaults (provisional, calibrated against the 2026-07-10 box: healthy
 * 41–50% free, normal heavy load 21–22%, real OOM thrash single digits):
 * LOW 8 / HIGH 15 / MIN 0.
 */
export function memPressureThresholdsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): {
	freeLowPct: number;
	freeHighPct: number;
	swapoutMinPages: number;
} {
	const pct = (name: string, fallback: number): number => {
		const v = Number(env[name]);
		return Number.isFinite(v) && v > 0 && v <= 100 ? v : fallback;
	};
	const rawMin = Number(env.FLYWHEEL_MEM_SWAPOUT_MIN_PAGES);
	const swapoutMinPages = Number.isInteger(rawMin) && rawMin >= 0 ? rawMin : 0;
	const freeHighPct = pct("FLYWHEEL_MEM_FREE_HIGH_PCT", 15);
	let freeLowPct = pct("FLYWHEEL_MEM_FREE_LOW_PCT", 8);
	// An inverted band (LOW ≥ HIGH) would clear the moment free% crosses the
	// trigger line — clamp to HIGH so misconfiguration degrades to a plain
	// threshold instead of a flapping episode.
	if (freeLowPct > freeHighPct) freeLowPct = freeHighPct;
	return { freeLowPct, freeHighPct, swapoutMinPages };
}

/** One tick's full verdict — fleet-sensors consumes this, not raw numbers. */
export interface MemoryEvaluation {
	event: "none" | "trigger" | "clear";
	freePct: number | null;
	/** Swapouts increment since the previous computable sample; null = unknown. */
	swapoutDelta: number | null;
	/** OR of the two danger dimensions (see class doc). */
	danger: boolean;
	/**
	 * Three-state health: true = PROVEN healthy (free% ≥ HIGH and delta ≤ MIN),
	 * false = proven not-healthy (hysteresis band / active swapout),
	 * null = no evidence (unknown delta / failed reading). Only `true` may
	 * release a hold — unknown never fail-opens.
	 */
	healthy: boolean | null;
	inPressure: boolean;
}

/**
 * The three-state hysteresis machine. `tick()` is fed one reading per
 * watchdog poll (~30s):
 *  - normal → danger (free% < LOW OR delta > MIN) for 2 consecutive ticks →
 *    "trigger" (enter pressure);
 *  - pressure → healthy === true → "clear" (exit); healthy false/null →
 *    stay in the episode (never re-trigger inside it);
 *  - a null reading never changes state (probe failure ≠ recovery), and the
 *    swapout baseline survives the gap (the next delta just spans it).
 *
 * There is NO consecutive-healthy requirement: recovery = the FIRST sample
 * whose delta is computable and healthy. The restart case ("second sample
 * lifts") falls out of the baseline mechanics (first sample delta unknown),
 * not an extra rule.
 */
export class MemoryPressureMonitor {
	/** The monitor owns the Swapouts baseline — nobody else touches it. */
	private lastSwapoutsTotal: number | null = null;
	private lastEval: MemoryEvaluation | null = null;
	private consecutiveDanger = 0;
	private pressure = false;
	/** Stamp of the trigger instant — the episode identity for dedup. */
	private episodeStartedAt: number | null = null;

	constructor(
		private readonly thresholds: {
			freeLowPct: number;
			freeHighPct: number;
			swapoutMinPages: number;
		},
		private readonly confirmTicks = 2,
	) {}

	get inPressure(): boolean {
		return this.pressure;
	}

	get episodeStart(): number | null {
		return this.episodeStartedAt;
	}

	/** Latest verdict — the fleet recovery probe reads the three-state health. */
	get lastEvaluation(): MemoryEvaluation | null {
		return this.lastEval;
	}

	tick(p: MemoryPressure | null | undefined, nowMs: number): MemoryEvaluation {
		if (p == null) {
			// Probe/parse failure: hold state, keep the baseline. healthy=null —
			// a failed reading is NO evidence of recovery.
			const ev: MemoryEvaluation = {
				event: "none",
				freePct: null,
				swapoutDelta: null,
				danger: false,
				healthy: null,
				inPressure: this.pressure,
			};
			this.lastEval = ev;
			return ev;
		}
		const { freeLowPct, freeHighPct, swapoutMinPages } = this.thresholds;
		// Delta: unknown on the first sample and on counter regression (reboot /
		// wrap) — both re-baseline without pretending to know.
		let swapoutDelta: number | null = null;
		if (this.lastSwapoutsTotal != null) {
			const d = p.swapoutsTotal - this.lastSwapoutsTotal;
			swapoutDelta = d >= 0 ? d : null;
		}
		this.lastSwapoutsTotal = p.swapoutsTotal;

		const danger =
			p.freePct < freeLowPct ||
			(swapoutDelta != null && swapoutDelta > swapoutMinPages);
		const healthy: boolean | null =
			swapoutDelta == null
				? null
				: p.freePct >= freeHighPct && swapoutDelta <= swapoutMinPages;

		let event: MemoryEvaluation["event"] = "none";
		if (this.pressure) {
			if (healthy === true) {
				this.pressure = false;
				this.consecutiveDanger = 0;
				this.episodeStartedAt = null;
				event = "clear";
			}
		} else if (danger) {
			this.consecutiveDanger++;
			if (this.consecutiveDanger >= this.confirmTicks) {
				this.pressure = true;
				this.episodeStartedAt = nowMs;
				event = "trigger";
			}
		} else {
			this.consecutiveDanger = 0;
		}

		const ev: MemoryEvaluation = {
			event,
			freePct: p.freePct,
			swapoutDelta,
			danger,
			healthy,
			inPressure: this.pressure,
		};
		this.lastEval = ev;
		return ev;
	}
}
