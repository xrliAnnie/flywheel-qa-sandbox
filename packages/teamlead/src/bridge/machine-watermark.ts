import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PRESSURE_SAMPLE_INTERVAL_MS = 30_000;
export const PRESSURE_READ_TIMEOUT_MS = 5_000;

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
	signal?: AbortSignal,
): Promise<MemoryPressure | null> {
	try {
		const override = env.FLYWHEEL_SWAP_SENSOR_CMD?.trim();
		const { stdout } = override
			? await execFileAsync("/bin/sh", ["-c", override], {
					timeout: PRESSURE_READ_TIMEOUT_MS,
					signal,
					killSignal: "SIGKILL",
				})
			: await execFileAsync("vm_stat", [], {
					timeout: PRESSURE_READ_TIMEOUT_MS,
					signal,
					killSignal: "SIGKILL",
				});
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
	const freeLowPct = pct("FLYWHEEL_MEM_FREE_LOW_PCT", 8);
	// HIGH remains parse-compatible for existing diagnostics; admission uses LOW only.
	return { freeLowPct, freeHighPct, swapoutMinPages };
}

/** Admission consumes this evidence at its own current time, never a latched hold. */
export interface PressureSnapshot {
	sampledAtMs: number | null;
	source: "vm_stat";
	freePct: number | null;
	swapoutDeltaPages: number | null;
	baselineAtMs: number | null;
	state: "healthy" | "pressure" | "warming" | "unknown";
	reason: string;
	evidenceValidUntilMs: number | null;
}
export interface PressureSample extends MemoryPressure {
	sampledAtMs: number;
}
export interface PressureMonitorState {
	samples: PressureSample[];
	pressureEvidenceAtMs: number | null;
	pressureValidUntilMs: number | null;
	established: boolean;
	consecutiveDanger: number;
}
export interface MemoryEvaluation {
	event: "none" | "trigger" | "clear";
	freePct: number | null;
	swapoutDelta: number | null;
	danger: boolean;
	healthy: boolean | null;
	inPressure: boolean;
}
export class MemoryPressureMonitor {
	private samples: PressureSample[] = [];
	private pressureEvidenceAtMs: number | null = null;
	private pressureValidUntilMs: number | null = null;
	private established: boolean;
	private consecutiveDanger = 0;
	private lastEval: MemoryEvaluation | null = null;
	private episodeStartedAt: number | null = null;
	private readonly maxAgeMs: number;
	private readonly warmupUntilMs: number;
	constructor(
		private readonly thresholds: {
			freeLowPct: number;
			freeHighPct: number;
			swapoutMinPages: number;
		},
		private readonly confirmTicks = 2,
		options?: {
			warmupUntilMs: number;
			maxAgeMs?: number;
			restored?: PressureMonitorState;
		},
	) {
		this.maxAgeMs = options?.maxAgeMs ?? 3 * PRESSURE_SAMPLE_INTERVAL_MS;
		this.warmupUntilMs = options?.warmupUntilMs ?? 0;
		// Legacy standalone callers have no boot admission contract.
		this.established = !options;
		if (options?.restored) {
			const r = options.restored;
			this.samples = r.samples.slice(-2);
			this.pressureEvidenceAtMs = r.pressureEvidenceAtMs;
			this.pressureValidUntilMs = r.pressureValidUntilMs;
			this.established = r.established;
			this.consecutiveDanger = r.consecutiveDanger;
		}
	}
	get inPressure(): boolean {
		return this.pressureEvidenceAtMs !== null;
	}
	get episodeStart(): number | null {
		return this.episodeStartedAt;
	}
	get lastEvaluation(): MemoryEvaluation | null {
		return this.lastEval;
	}
	exportState(): PressureMonitorState {
		return {
			samples: this.samples.map((s) => ({ ...s })),
			pressureEvidenceAtMs: this.pressureEvidenceAtMs,
			pressureValidUntilMs: this.pressureValidUntilMs,
			established: this.established,
			consecutiveDanger: this.consecutiveDanger,
		};
	}
	private delta(): number | null {
		const [a, b] = this.samples;
		if (
			!a ||
			!b ||
			b.sampledAtMs - a.sampledAtMs > this.maxAgeMs ||
			b.sampledAtMs < a.sampledAtMs ||
			b.swapoutsTotal < a.swapoutsTotal
		)
			return null;
		return b.swapoutsTotal - a.swapoutsTotal;
	}
	evaluatePressure(nowMs: number): PressureSnapshot {
		const last = this.samples.at(-1);
		const delta = this.delta();
		const pressureUntil =
			this.pressureEvidenceAtMs === null
				? null
				: Math.min(
						this.pressureValidUntilMs ?? 0,
						this.pressureEvidenceAtMs + this.maxAgeMs,
					);
		const fresh =
			!!last &&
			nowMs >= last.sampledAtMs &&
			nowMs < last.sampledAtMs + this.maxAgeMs;
		let state: PressureSnapshot["state"];
		let reason: string;
		if (
			pressureUntil !== null &&
			nowMs < pressureUntil &&
			nowMs >= this.pressureEvidenceAtMs!
		) {
			state = "pressure";
			reason = "confirmed_pressure";
		} else if (fresh && delta !== null && this.established) {
			state = "healthy";
			reason =
				last!.freePct < this.thresholds.freeLowPct ||
				delta > this.thresholds.swapoutMinPages
					? "danger_unconfirmed"
					: "non_danger";
		} else if (!this.established && nowMs < this.warmupUntilMs) {
			state = "warming";
			reason = "sampling_warmup";
		} else {
			state = "unknown";
			reason = "pressure_evidence_unavailable";
		}
		// An expired pressure verdict cannot become healthy merely because its last reading is still present.
		if (this.pressureEvidenceAtMs !== null && state === "healthy") {
			state = "unknown";
			reason = "pressure_evidence_expired";
		}
		return {
			sampledAtMs: last?.sampledAtMs ?? null,
			source: "vm_stat",
			freePct: last?.freePct ?? null,
			swapoutDeltaPages: delta,
			baselineAtMs:
				this.samples.length === 2 ? this.samples[0]!.sampledAtMs : null,
			state,
			reason,
			evidenceValidUntilMs:
				state === "pressure"
					? pressureUntil
					: fresh && delta !== null
						? last!.sampledAtMs + this.maxAgeMs
						: null,
		};
	}
	tick(p: MemoryPressure | null | undefined, nowMs: number): MemoryEvaluation {
		const wasPressure = this.evaluatePressure(nowMs).state === "pressure";
		if (p == null) {
			this.consecutiveDanger = 0;
			this.lastEval = {
				event: "none",
				freePct: null,
				swapoutDelta: null,
				danger: false,
				healthy: null,
				inPressure: wasPressure,
			};
			return this.lastEval;
		}
		this.samples.push({ ...p, sampledAtMs: nowMs });
		this.samples = this.samples.slice(-2);
		const swapoutDelta = this.delta();
		const danger =
			p.freePct < this.thresholds.freeLowPct ||
			(swapoutDelta !== null && swapoutDelta > this.thresholds.swapoutMinPages);
		const healthy = swapoutDelta === null ? null : !danger;
		let event: MemoryEvaluation["event"] = "none";
		if (healthy === true) {
			if (this.pressureEvidenceAtMs !== null) event = "clear";
			this.pressureEvidenceAtMs = null;
			this.pressureValidUntilMs = null;
			this.episodeStartedAt = null;
			this.consecutiveDanger = 0;
			this.established = true;
		} else if (danger) {
			this.consecutiveDanger = Math.min(
				this.confirmTicks,
				this.consecutiveDanger + 1,
			);
			if (
				wasPressure ||
				this.consecutiveDanger >= this.confirmTicks ||
				(!this.established && swapoutDelta !== null)
			) {
				if (!wasPressure) {
					event = "trigger";
					this.episodeStartedAt = nowMs;
				}
				this.pressureEvidenceAtMs = nowMs;
				this.pressureValidUntilMs = nowMs + this.maxAgeMs;
				this.established = true;
			}
		} else {
			this.consecutiveDanger = 0;
		}
		this.lastEval = {
			event,
			freePct: p.freePct,
			swapoutDelta,
			danger,
			healthy,
			inPressure: this.evaluatePressure(nowMs).state === "pressure",
		};
		return this.lastEval;
	}
}
