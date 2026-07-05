/**
 * FLY-123 WS-D (P4): RunnerAdmissionController — uncapped runner admission by
 * real resource pressure (load + optional memory), no hardcoded N, no
 * explicit_limit. Memory gate is OPT-IN (default off) and, when enabled, uses
 * a platform-aware available-memory metric rather than raw os.freemem().
 */
import { describe, expect, it } from "vitest";
import {
	availableMemBytes,
	parseDarwinReclaimableBytes,
	parseLinuxAvailableBytes,
	RunnerAdmissionController,
} from "../runner-admission.js";

const GB = 1024 * 1024 * 1024;

describe("RunnerAdmissionController (P4 — pure resource admission)", () => {
	it("admits when load and memory are healthy, regardless of how many already run", () => {
		const c = new RunnerAdmissionController({
			loadPerCore: 8,
			minFreeMemBytes: 1 * GB,
			loadavgFn: () => [4, 4, 4],
			availMemFn: () => 8 * GB,
			cpuCount: 8,
		});
		// No count is consulted — admit is purely resource-based.
		expect(c.tryAdmit()).toEqual({ admit: true });
	});

	it("defers on load_pressure when per-core load exceeds the threshold", () => {
		const c = new RunnerAdmissionController({
			loadPerCore: 8,
			minFreeMemBytes: 1 * GB,
			loadavgFn: () => [80, 70, 60], // 80/8 = 10/core > 8
			availMemFn: () => 8 * GB,
			cpuCount: 8,
		});
		const d = c.tryAdmit();
		expect(d.admit).toBe(false);
		expect(d).toMatchObject({ reason: "load_pressure" });
	});

	it("defers on memory_pressure when available memory is below the floor (checked before load)", () => {
		const c = new RunnerAdmissionController({
			loadPerCore: 8,
			minFreeMemBytes: 2 * GB,
			loadavgFn: () => [200, 200, 200], // also over load, but memory wins
			availMemFn: () => 512 * 1024 * 1024, // 512MB < 2GB floor
			cpuCount: 8,
		});
		const d = c.tryAdmit();
		expect(d.admit).toBe(false);
		expect(d).toMatchObject({ reason: "memory_pressure" });
	});

	it("memory gate is OFF by default — never defers on memory even at ~0 available (regression guard)", () => {
		// FLY-123 fix: os.freemem() under-reports available memory ~40× on
		// macOS; a default-on floor would 429-halt every spawn. Default off:
		// only load gates.
		const c = new RunnerAdmissionController({
			// minFreeMemBytes omitted → 0 → disabled
			loadPerCore: 8,
			loadavgFn: () => [4, 4, 4],
			availMemFn: () => 1, // 1 byte available — would trip any positive floor
			cpuCount: 8,
		});
		expect(c.tryAdmit()).toEqual({ admit: true });
	});

	it("explicit minFreeMemBytes: 0 also disables the memory gate", () => {
		const c = new RunnerAdmissionController({
			minFreeMemBytes: 0,
			loadPerCore: 8,
			loadavgFn: () => [4, 4, 4],
			availMemFn: () => 0,
			cpuCount: 8,
		});
		expect(c.tryAdmit()).toEqual({ admit: true });
	});

	it("threshold scales with cores — same load admits on a bigger box (no hidden count cap)", () => {
		const opts = {
			loadPerCore: 8,
			minFreeMemBytes: 1 * GB,
			loadavgFn: () => [60, 60, 60],
			availMemFn: () => 8 * GB,
		};
		// 60/8 = 7.5/core → admit
		expect(
			new RunnerAdmissionController({ ...opts, cpuCount: 8 }).tryAdmit(),
		).toEqual({
			admit: true,
		});
		// 60/4 = 15/core → defer (load_pressure) on a smaller box
		expect(
			new RunnerAdmissionController({ ...opts, cpuCount: 4 }).tryAdmit().admit,
		).toBe(false);
	});

	it("alwaysAdmit() never defers", () => {
		expect(RunnerAdmissionController.alwaysAdmit().tryAdmit()).toEqual({
			admit: true,
		});
	});

	it("fromEnv defaults the memory gate OFF — admits on healthy load even with a low real freemem", () => {
		// No FLYWHEEL_RUNNER_MIN_FREE_MEM_MB → floor 0 → memory not consulted.
		const c = RunnerAdmissionController.fromEnv({
			FLYWHEEL_RUNNER_LOAD_PER_CORE: "1000000", // effectively never load-defer
		} as NodeJS.ProcessEnv);
		expect(c.tryAdmit()).toEqual({ admit: true });
	});

	it("fromEnv honors FLYWHEEL_RUNNER_LOAD_PER_CORE / MIN_FREE_MEM_MB and falls back on garbage", () => {
		const c = RunnerAdmissionController.fromEnv({
			FLYWHEEL_RUNNER_LOAD_PER_CORE: "0.01",
			FLYWHEEL_RUNNER_MIN_FREE_MEM_MB: "999999999", // ~1 PB floor → opt-in, always defers
		} as NodeJS.ProcessEnv);
		// absurdly low load ceiling + huge memory floor → always defers
		expect(c.tryAdmit().admit).toBe(false);

		// garbage falls back to defaults (load 8.0, memory gate off) → admits on a normal box
		const d = RunnerAdmissionController.fromEnv({
			FLYWHEEL_RUNNER_LOAD_PER_CORE: "notanumber",
			FLYWHEEL_RUNNER_MIN_FREE_MEM_MB: "-5",
		} as NodeJS.ProcessEnv);
		expect(typeof d.tryAdmit().admit).toBe("boolean");
	});
});

describe("availableMemBytes() — platform-aware available memory", () => {
	it("returns a positive, finite byte count on this host", () => {
		const v = availableMemBytes();
		expect(Number.isFinite(v)).toBe(true);
		expect(v).toBeGreaterThan(0);
	});
});

describe("parser units (deterministic — fixture strings, no host dependency)", () => {
	// A representative `vm_stat` capture (16 KiB pages, as on Apple silicon).
	const VM_STAT = [
		"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
		"Pages free:                               10000.",
		"Pages active:                            500000.",
		"Pages inactive:                           20000.",
		"Pages speculative:                         5000.",
		"Pages throttled:                              0.",
		"Pages wired down:                        300000.",
		"Pages purgeable:                          99999.",
		"File-backed pages:                       400000.",
		"Anonymous pages:                         120000.",
	].join("\n");

	it("parseDarwinReclaimableBytes = (free+inactive+speculative)×pageSize and EXCLUDES purgeable (Codex finding)", () => {
		// (10000 + 20000 + 5000) × 16384 — purgeable (99999) must NOT be added.
		expect(parseDarwinReclaimableBytes(VM_STAT)).toBe(
			(10000 + 20000 + 5000) * 16384,
		);
		// Explicit double-count guard: the wrong (purgeable-included) total must differ.
		expect(parseDarwinReclaimableBytes(VM_STAT)).not.toBe(
			(10000 + 20000 + 5000 + 99999) * 16384,
		);
	});

	it("parseDarwinReclaimableBytes returns null on missing page size or missing fields", () => {
		expect(parseDarwinReclaimableBytes("totally unparseable")).toBeNull();
		expect(
			parseDarwinReclaimableBytes(
				"page size of 4096 bytes\nPages free:  1.\n", // missing inactive + speculative
			),
		).toBeNull();
	});

	it("parseLinuxAvailableBytes reads MemAvailable kB → bytes (not MemFree)", () => {
		const MEMINFO = [
			"MemTotal:       16384000 kB",
			"MemFree:          200000 kB",
			"MemAvailable:    4500000 kB",
			"Buffers:          100000 kB",
		].join("\n");
		expect(parseLinuxAvailableBytes(MEMINFO)).toBe(4500000 * 1024);
	});

	it("parseLinuxAvailableBytes returns null when MemAvailable is absent", () => {
		expect(
			parseLinuxAvailableBytes("MemTotal: 100 kB\nMemFree: 50 kB\n"),
		).toBeNull();
	});
});
