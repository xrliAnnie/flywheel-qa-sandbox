/**
 * FLY-123 WS-D (P4 = no manual cap): runner admission by REAL resource
 * pressure, not a hardcoded N.
 *
 * The old `maxConcurrentRunners` (default 3, hard ceiling 20) is retired.
 * Annie's requirement: Codex runner count is uncapped — the only constraint
 * is runtime resource (machine load + memory). This controller is the
 * backpressure that replaces the N-cap: it defers a new runner ONLY when the
 * box is genuinely under load or low on memory, never because of a count.
 *
 * Thresholds scale with the machine (load is PER-CORE, memory is an absolute
 * floor) so a default never constitutes a hidden runner-count cap — a bigger
 * box admits more runners automatically. Both are env-tunable.
 *
 * Reasons are TYPED (`load_pressure` / `memory_pressure`) so HTTP/status code
 * never string-matches a "Max concurrent" message. There is deliberately NO
 * `explicit_limit` reason — P4 removed the manual cap entirely.
 *
 * MEMORY GATE IS OPT-IN (default OFF). `os.freemem()` is NOT a portable
 * "available memory" signal: on macOS it counts only truly-free pages and
 * excludes the large reclaimable inactive/speculative/purgeable pool (it
 * under-reports available memory by ~40× on a working box — a healthy 16 GiB
 * Mac reads ~100–200 MB free), and on Linux it returns `MemFree`, not the
 * kernel's `MemAvailable` reclaimable estimate. A naive free-memory floor on
 * those platforms would defer EVERY spawn (claude AND codex — the precheck is
 * vendor-independent) and halt the whole pipeline. So:
 *   - the memory floor defaults to 0 (disabled) — load-per-core is the
 *     always-on resource guard, matching the pre-FLY-123 (load-only) posture
 *     and the real saturation failure mode;
 *   - when an operator DOES set `FLYWHEEL_RUNNER_MIN_FREE_MEM_MB`, the floor is
 *     compared against a platform-aware AVAILABLE-memory metric
 *     (`availableMemBytes()`), not raw `os.freemem()`, so the knob is usable.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg } from "node:os";

export type AdmissionReason =
	| "load_pressure"
	| "memory_pressure"
	// FLY-1082 (Task 2.2): the fleet pressure-hold — an explicit, reversible
	// hand brake the swap-watermark ARC places while the machine is in an
	// OOM-warning episode. Checked before the resource math (an explicit hold
	// beats a live probe); lifted automatically when the watermark falls.
	| "pressure_hold";

export type AdmissionDecision =
	| { admit: true }
	| { admit: false; reason: AdmissionReason; detail: string };

/**
 * Thrown by the dispatcher when resource admission defers a runner. Typed so
 * the HTTP layer maps it to 429 with the reason (R1 MED #4) instead of
 * falling through to 500 on a string-match miss. `name` is set for robust
 * cross-module recognition without `instanceof` pitfalls.
 */
export class AdmissionDeferredError extends Error {
	readonly reason: AdmissionReason;
	readonly detail: string;
	constructor(reason: AdmissionReason, detail: string) {
		super(`Runner admission deferred (${reason}): ${detail}`);
		this.name = "AdmissionDeferredError";
		this.reason = reason;
		this.detail = detail;
	}
}

const MB = 1024 * 1024;

/**
 * Parse macOS `vm_stat` output → reclaimable bytes, or null if unparseable.
 *
 * Reclaimable = (free + inactive + speculative) × pageSize. `Pages purgeable`
 * is deliberately EXCLUDED: on macOS it is an *attribute* of resident pages
 * (purgeable-volatile pages live within the active/inactive queues), NOT a
 * mutually-exclusive queue — adding it would double-count and OVER-report
 * available memory, which for a defer-when-low floor is the dangerous
 * direction (admit while actually low). Excluding it (and file-backed) makes
 * the estimate conservative by construction: it can under-count but never
 * over-count. (Codex review finding.)
 */
export function parseDarwinReclaimableBytes(vmStat: string): number | null {
	const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1] ?? 0);
	if (!pageSize) return null;
	const pages = (re: RegExp): number | null => {
		const m = vmStat.match(re);
		return m ? Number(m[1]) : null;
	};
	const free = pages(/Pages free:\s+(\d+)\./);
	const inactive = pages(/Pages inactive:\s+(\d+)\./);
	const speculative = pages(/Pages speculative:\s+(\d+)\./);
	if (free == null || inactive == null || speculative == null) return null;
	return (free + inactive + speculative) * pageSize;
}

/** Parse Linux `/proc/meminfo` → `MemAvailable` bytes, or null if absent. */
export function parseLinuxAvailableBytes(meminfo: string): number | null {
	const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
	return m ? Number(m[1]) * 1024 : null;
}

/**
 * Platform-aware AVAILABLE (reclaimable) memory in bytes. Corrects the
 * `os.freemem()` blind spot (see file header):
 *   - linux  → `/proc/meminfo` `MemAvailable` (kernel's reclaimable estimate);
 *   - darwin → `vm_stat` free + inactive + speculative (see
 *              `parseDarwinReclaimableBytes` — conservative, purgeable/file-
 *              backed excluded to avoid double-counting);
 *   - other platform / unparseable output / probe failure → `os.freemem()`.
 * Best-effort: probe failures and unparseable output degrade to `os.freemem()`
 * (the final fallback; `os.freemem()` itself is a synchronous OS stat that is
 * not expected to throw). Only invoked when the memory gate is explicitly
 * enabled (`minFreeMemBytes > 0`).
 */
export function availableMemBytes(): number {
	try {
		if (process.platform === "linux") {
			const v = parseLinuxAvailableBytes(readFileSync("/proc/meminfo", "utf8"));
			if (v != null) return v;
		} else if (process.platform === "darwin") {
			const v = parseDarwinReclaimableBytes(
				execFileSync("vm_stat", { encoding: "utf8", timeout: 2000 }),
			);
			if (v != null) return v;
		}
	} catch {
		// fall through to os.freemem()
	}
	return freemem();
}

export interface RunnerAdmissionOptions {
	/** Defer when 1-min loadavg PER CORE exceeds this. Per-core so it scales
	 * with the machine (not a runner-count cap). Default 8.0 — a genuine
	 * saturation ceiling, not a throttle. */
	loadPerCore?: number;
	/** Defer when AVAILABLE memory drops below this many bytes. Default 0 =
	 * memory gate DISABLED (load-only admission). When > 0, compared against
	 * `availMemFn()` (platform-aware available memory), never raw os.freemem. */
	minFreeMemBytes?: number;
	// Injectable for deterministic tests.
	loadavgFn?: () => number[];
	/** Available-memory probe (bytes). Defaults to `availableMemBytes`. */
	availMemFn?: () => number;
	cpuCount?: number;
}

/** Parse a non-negative number env (0 allowed — disables the memory gate).
 * Garbage / negative → fallback. */
function parseNonNegEnv(raw: string | undefined, fallback: number): number {
	if (raw == null || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Parse a strictly-positive number env (a load ceiling must be > 0). */
function parsePosEnv(raw: string | undefined, fallback: number): number {
	if (raw == null || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class RunnerAdmissionController {
	private readonly loadPerCore: number;
	private readonly minFreeMemBytes: number;
	private readonly loadavgFn: () => number[];
	private readonly availMemFn: () => number;
	private readonly cpuCount: number;
	/** FLY-1082: fleet pressure-hold probe (null = no hold). Late-bound. */
	private pressureHoldProbe: (() => string | null) | null = null;

	constructor(opts: RunnerAdmissionOptions = {}) {
		this.loadPerCore = opts.loadPerCore ?? 8.0;
		// Default 0 = memory gate OFF (see file header — os.freemem-style floors
		// are not portable; load-per-core is the always-on guard).
		this.minFreeMemBytes = opts.minFreeMemBytes ?? 0;
		this.loadavgFn = opts.loadavgFn ?? loadavg;
		this.availMemFn = opts.availMemFn ?? availableMemBytes;
		this.cpuCount = Math.max(1, opts.cpuCount ?? cpus().length);
	}

	/** Build from env (FLYWHEEL_RUNNER_LOAD_PER_CORE, FLYWHEEL_RUNNER_MIN_FREE_MEM_MB).
	 * Memory floor defaults to 0 (disabled); set the MB env to opt in. */
	static fromEnv(
		env: NodeJS.ProcessEnv = process.env,
	): RunnerAdmissionController {
		return new RunnerAdmissionController({
			loadPerCore: parsePosEnv(env.FLYWHEEL_RUNNER_LOAD_PER_CORE, 8.0),
			minFreeMemBytes:
				parseNonNegEnv(env.FLYWHEEL_RUNNER_MIN_FREE_MEM_MB, 0) * MB,
		});
	}

	/** Test/helper: a controller that always admits (no resource pressure). */
	static alwaysAdmit(): RunnerAdmissionController {
		return new RunnerAdmissionController({
			loadavgFn: () => [0, 0, 0],
			availMemFn: () => Number.MAX_SAFE_INTEGER,
			cpuCount: 1,
		});
	}

	/** Test/helper: a controller that always defers (load_pressure). */
	static alwaysDefer(): RunnerAdmissionController {
		return new RunnerAdmissionController({
			loadPerCore: 0.001,
			loadavgFn: () => [100, 100, 100],
			availMemFn: () => Number.MAX_SAFE_INTEGER,
			cpuCount: 1,
		});
	}

	/**
	 * FLY-1082 (Task 2.2): late-bind the fleet pressure-hold probe. The
	 * controller is built at config-load time (no StateStore yet); plugin.ts
	 * attaches `() => detail | null` once the store exists. The probe returns a
	 * human-readable hold detail while the hold row is present, else null.
	 */
	setPressureHoldProbe(probe: (() => string | null) | null): void {
		this.pressureHoldProbe = probe;
	}

	/** Decide whether to admit one more runner right now. Count-independent —
	 * pure resource pressure (P4). The explicit fleet pressure-hold is checked
	 * FIRST (an ARC-placed hand brake beats the live probes), then memory
	 * (when enabled), then load. */
	tryAdmit(): AdmissionDecision {
		// FLY-1082: explicit hold — probe failures fail OPEN (a broken probe
		// must never halt dispatch; the resource guards below still apply).
		if (this.pressureHoldProbe) {
			let held: string | null = null;
			try {
				held = this.pressureHoldProbe();
			} catch {
				held = null;
			}
			if (held !== null) {
				return { admit: false, reason: "pressure_hold", detail: held };
			}
		}
		// Memory gate is opt-in: only when an operator set a positive floor.
		if (this.minFreeMemBytes > 0) {
			const avail = this.availMemFn();
			if (avail < this.minFreeMemBytes) {
				return {
					admit: false,
					reason: "memory_pressure",
					detail: `available ${Math.round(avail / MB)}MB < floor ${Math.round(this.minFreeMemBytes / MB)}MB`,
				};
			}
		}
		const load1 = this.loadavgFn()[0] ?? 0;
		const perCore = load1 / this.cpuCount;
		if (perCore > this.loadPerCore) {
			return {
				admit: false,
				reason: "load_pressure",
				detail: `load/core ${perCore.toFixed(2)} > ${this.loadPerCore} (load1 ${load1.toFixed(2)}, cores ${this.cpuCount})`,
			};
		}
		return { admit: true };
	}
}
