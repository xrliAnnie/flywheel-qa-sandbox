/**
 * FLY-1142: real-memory-pressure parsing + the three-state hysteresis machine.
 *
 * The 2026-07-10 incident: macOS swap usage is monotonic (never shrinks
 * without a reboot), so the old swap-% sensor could never clear a
 * pressure-hold once an OOM scarred the watermark — dispatch stayed blocked
 * for 8+ hours on a machine that was measurably healthy. The sensor now reads
 * vm_stat: free% (pages free+inactive over all visible pages) and
 * swapout-delta (Swapouts counter increment between ticks = actively
 * thrashing NOW).
 */
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type MemoryPressure,
	MemoryPressureMonitor,
	memPressureThresholdsFromEnv,
	parseVmStat,
	readMemoryPressure,
} from "../machine-watermark.js";

// Real `vm_stat` capture shape from the production box (Apple silicon, 16 KiB
// pages — NOT the 4 KiB `sysctl hw.pagesize` reports; the free% formula must
// not care either way).
const BUCKETS = {
	free: 14248,
	active: 698049,
	inactive: 685708,
	speculative: 10443,
	throttled: 0,
	wired: 541835,
	compressor: 1133442,
	swapouts: 15351310,
};

function fixture(
	over: Partial<typeof BUCKETS> = {},
	opts: { header?: string | null; omit?: string[] } = {},
): string {
	const b = { ...BUCKETS, ...over };
	const header =
		opts.header === undefined
			? "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
			: opts.header;
	const lines: Array<[string, string]> = [
		["free", `Pages free:                               ${b.free}.`],
		["active", `Pages active:                            ${b.active}.`],
		["inactive", `Pages inactive:                          ${b.inactive}.`],
		[
			"speculative",
			`Pages speculative:                        ${b.speculative}.`,
		],
		[
			"throttled",
			`Pages throttled:                              ${b.throttled}.`,
		],
		["wired", `Pages wired down:                        ${b.wired}.`],
		["purgeable", "Pages purgeable:                          10496."],
		["faults", `"Translation faults":                 987654321.`],
		["cow", "Pages copy-on-write:                   12345678."],
		["stored", "Pages stored in compressor:             4567890."],
		["compressor", `Pages occupied by compressor:           ${b.compressor}.`],
		["pageins", "Pageins:                               12345678."],
		["pageouts", "Pageouts:                                234567."],
		["swapins", "Swapins:                                9212899."],
		["swapouts", `Swapouts:                              ${b.swapouts}.`],
	];
	const body = lines
		.filter(([key]) => !(opts.omit ?? []).includes(key))
		.map(([, line]) => line);
	return [...(header === null ? [] : [header]), ...body, ""].join("\n");
}

const TOTAL =
	BUCKETS.free +
	BUCKETS.active +
	BUCKETS.inactive +
	BUCKETS.speculative +
	BUCKETS.throttled +
	BUCKETS.wired +
	BUCKETS.compressor;
const FREE_PCT = ((BUCKETS.free + BUCKETS.inactive) / TOTAL) * 100;

describe("parseVmStat", () => {
	it("parses the real capture: free% = (free+inactive)/Σ7buckets, Swapouts total, header page size", () => {
		const p = parseVmStat(fixture());
		expect(p).not.toBeNull();
		expect(p!.freePct).toBeCloseTo(FREE_PCT, 6);
		expect(p!.swapoutsTotal).toBe(BUCKETS.swapouts);
		expect(p!.pageSize).toBe(16384);
	});

	it("page-size trap regression: the SAME counts under a 4096 header yield the SAME free% (page size never enters the formula)", () => {
		const p16 = parseVmStat(fixture());
		const p4 = parseVmStat(
			fixture(
				{},
				{
					header: "Mach Virtual Memory Statistics: (page size of 4096 bytes)",
				},
			),
		);
		expect(p4).not.toBeNull();
		expect(p4!.freePct).toBeCloseTo(p16!.freePct, 10);
		expect(p4!.pageSize).toBe(4096);
	});

	it("a missing/unparseable header only nulls the diagnostic pageSize — the reading itself stands", () => {
		const p = parseVmStat(fixture({}, { header: null }));
		expect(p).not.toBeNull();
		expect(p!.pageSize).toBeNull();
		expect(p!.freePct).toBeCloseTo(FREE_PCT, 6);
	});

	it("any missing bucket nulls the WHOLE reading (never a partial denominator)", () => {
		for (const omit of [
			"free",
			"active",
			"inactive",
			"speculative",
			"throttled",
			"wired",
			"compressor",
			"swapouts",
		]) {
			expect(parseVmStat(fixture({}, { omit: [omit] }))).toBeNull();
		}
	});

	it("similar-label lines never stand in for the real bucket (occupied-by vs stored-in compressor)", () => {
		// Omitting "Pages occupied by compressor" must NOT fall back to
		// "Pages stored in compressor".
		expect(parseVmStat(fixture({}, { omit: ["compressor"] }))).toBeNull();
	});

	it("a zero denominator nulls the reading", () => {
		expect(
			parseVmStat(
				fixture({
					free: 0,
					active: 0,
					inactive: 0,
					speculative: 0,
					throttled: 0,
					wired: 0,
					compressor: 0,
				}),
			),
		).toBeNull();
	});

	it("garbage / empty / the OLD sysctl vm.swapusage shape all return null", () => {
		expect(parseVmStat("nonsense")).toBeNull();
		expect(parseVmStat("")).toBeNull();
		expect(
			parseVmStat(
				"vm.swapusage: total = 16384.00M  used = 14815.75M  free = 1568.25M  (encrypted)",
			),
		).toBeNull();
	});
});

describe("memPressureThresholdsFromEnv", () => {
	const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

	it("defaults: freeLow 8 / freeHigh 15 / swapoutMin 0", () => {
		expect(memPressureThresholdsFromEnv(env({}))).toEqual({
			freeLowPct: 8,
			freeHighPct: 15,
			swapoutMinPages: 0,
		});
	});

	it("valid env overrides are honored", () => {
		expect(
			memPressureThresholdsFromEnv(
				env({
					FLYWHEEL_MEM_FREE_LOW_PCT: "5",
					FLYWHEEL_MEM_FREE_HIGH_PCT: "25",
					FLYWHEEL_MEM_SWAPOUT_MIN_PAGES: "500",
				}),
			),
		).toEqual({ freeLowPct: 5, freeHighPct: 25, swapoutMinPages: 500 });
	});

	it("percent validator: 0 / negative / NaN / >100 fall back to defaults", () => {
		expect(
			memPressureThresholdsFromEnv(
				env({
					FLYWHEEL_MEM_FREE_LOW_PCT: "0",
					FLYWHEEL_MEM_FREE_HIGH_PCT: "nope",
				}),
			),
		).toEqual({ freeLowPct: 8, freeHighPct: 15, swapoutMinPages: 0 });
		expect(
			memPressureThresholdsFromEnv(
				env({
					FLYWHEEL_MEM_FREE_LOW_PCT: "-3",
					FLYWHEEL_MEM_FREE_HIGH_PCT: "101",
				}),
			),
		).toEqual({ freeLowPct: 8, freeHighPct: 15, swapoutMinPages: 0 });
	});

	it("inverted band (LOW ≥ HIGH) clamps LOW down to HIGH", () => {
		expect(
			memPressureThresholdsFromEnv(
				env({
					FLYWHEEL_MEM_FREE_LOW_PCT: "30",
					FLYWHEEL_MEM_FREE_HIGH_PCT: "12",
				}),
			),
		).toEqual({ freeLowPct: 12, freeHighPct: 12, swapoutMinPages: 0 });
	});

	it("SWAPOUT_MIN has its OWN validator: 0 and >100 are both legal, not percent-clamped", () => {
		expect(
			memPressureThresholdsFromEnv(env({ FLYWHEEL_MEM_SWAPOUT_MIN_PAGES: "0" }))
				.swapoutMinPages,
		).toBe(0);
		expect(
			memPressureThresholdsFromEnv(
				env({ FLYWHEEL_MEM_SWAPOUT_MIN_PAGES: "100000" }),
			).swapoutMinPages,
		).toBe(100000);
	});

	it("SWAPOUT_MIN rejects negative / non-integer / NaN → default 0", () => {
		for (const bad of ["-1", "2.5", "abc", "Infinity"]) {
			expect(
				memPressureThresholdsFromEnv(
					env({ FLYWHEEL_MEM_SWAPOUT_MIN_PAGES: bad }),
				).swapoutMinPages,
			).toBe(0);
		}
	});
});

describe("MemoryPressureMonitor (three-state health, OR-trigger / AND-clear)", () => {
	const TH = { freeLowPct: 8, freeHighPct: 15, swapoutMinPages: 0 };
	const p = (freePct: number, swapouts: number): MemoryPressure => ({
		freePct,
		swapoutsTotal: swapouts,
		pageSize: 16384,
	});

	it("free-low branch: 2 consecutive low-free% ticks trigger (works from the very first sample)", () => {
		const m = new MemoryPressureMonitor(TH);
		const ev1 = m.tick(p(5, 100), 1);
		expect(ev1.event).toBe("none");
		expect(ev1.danger).toBe(true);
		expect(ev1.healthy).toBeNull(); // first sample: delta unknown
		const ev2 = m.tick(p(5, 100), 2);
		expect(ev2.event).toBe("trigger");
		expect(m.inPressure).toBe(true);
		expect(m.episodeStart).toBe(2);
	});

	it("free-low boundary is strict: freePct == LOW is NOT danger, just below is", () => {
		const m = new MemoryPressureMonitor(TH);
		m.tick(p(50, 100), 1); // baseline
		expect(m.tick(p(8, 100), 2).danger).toBe(false);
		expect(m.tick(p(7.999, 100), 3).danger).toBe(true);
	});

	it("swapout branch: baseline sample + 2 increasing samples = 3 samples to trigger", () => {
		const m = new MemoryPressureMonitor(TH);
		const ev1 = m.tick(p(50, 1000), 1); // baseline — delta unknown
		expect(ev1.danger).toBe(false);
		expect(ev1.swapoutDelta).toBeNull();
		const ev2 = m.tick(p(50, 2000), 2); // delta 1000 > MIN
		expect(ev2.event).toBe("none");
		expect(ev2.danger).toBe(true);
		expect(ev2.swapoutDelta).toBe(1000);
		const ev3 = m.tick(p(50, 3000), 3);
		expect(ev3.event).toBe("trigger");
		expect(m.inPressure).toBe(true);
	});

	it("swapoutMinPages is a noise floor: delta ≤ MIN is not danger, delta > MIN is", () => {
		const m = new MemoryPressureMonitor({ ...TH, swapoutMinPages: 500 });
		m.tick(p(50, 1000), 1);
		expect(m.tick(p(50, 1400), 2).danger).toBe(false); // delta 400 ≤ 500
		expect(m.tick(p(50, 1900), 3).danger).toBe(false); // delta 500 ≤ 500
		expect(m.tick(p(50, 2401), 4).danger).toBe(true); // delta 501 > 500
	});

	it("a single danger spike never triggers (confirmation counter resets)", () => {
		const m = new MemoryPressureMonitor(TH);
		m.tick(p(5, 100), 1); // danger 1
		m.tick(p(50, 100), 2); // healthy — counter resets
		const ev = m.tick(p(5, 100), 3); // danger 1 again
		expect(ev.event).toBe("none");
		expect(m.inPressure).toBe(false);
	});

	it("recovery clears IMMEDIATELY on the first provably-healthy sample (free% ≥ HIGH AND delta ≤ MIN)", () => {
		const m = new MemoryPressureMonitor(TH);
		m.tick(p(5, 1000), 1);
		m.tick(p(5, 1000), 2); // trigger
		expect(m.inPressure).toBe(true);
		const ev = m.tick(p(45, 1000), 3); // free recovered, swapouts static → delta 0
		expect(ev.event).toBe("clear");
		expect(ev.healthy).toBe(true);
		expect(m.inPressure).toBe(false);
		expect(m.episodeStart).toBeNull();
	});

	it("hysteresis band (LOW ≤ free% < HIGH): healthy=false — no clear, no re-trigger", () => {
		const m = new MemoryPressureMonitor(TH);
		m.tick(p(5, 1000), 1);
		m.tick(p(5, 1000), 2); // trigger
		const ev = m.tick(p(12, 1000), 3); // in the band, delta 0
		expect(ev.event).toBe("none");
		expect(ev.healthy).toBe(false); // EVIDENCE of not-healthy, not unknown
		expect(m.inPressure).toBe(true);
		const ev2 = m.tick(p(5, 2000), 4); // danger again inside the episode
		expect(ev2.event).toBe("none"); // never re-trigger
	});

	it("active swapout blocks clear even with free% recovered (AND-clear)", () => {
		const m = new MemoryPressureMonitor(TH);
		m.tick(p(5, 1000), 1);
		m.tick(p(5, 2000), 2); // trigger
		const ev = m.tick(p(45, 3000), 3); // free healthy but delta 1000 > MIN
		expect(ev.event).toBe("none");
		expect(ev.healthy).toBe(false);
		expect(m.inPressure).toBe(true);
	});

	it("unknown delta (probe gap / counter regression) is healthy=null — never clears", () => {
		const m = new MemoryPressureMonitor(TH);
		m.tick(p(5, 5000), 1);
		m.tick(p(5, 5000), 2); // trigger
		// Counter REGRESSED (reboot / wrap): delta unknown, baseline resets.
		const ev = m.tick(p(45, 100), 3);
		expect(ev.event).toBe("none");
		expect(ev.swapoutDelta).toBeNull();
		expect(ev.healthy).toBeNull(); // unknown ≠ unhealthy — but still no clear
		expect(m.inPressure).toBe(true);
		// Next static sample: delta computable again → clear.
		const ev2 = m.tick(p(45, 100), 4);
		expect(ev2.event).toBe("clear");
		expect(ev2.healthy).toBe(true);
	});

	it("a null reading never changes state (probe failure ≠ recovery) and reads healthy=null", () => {
		const m = new MemoryPressureMonitor(TH);
		m.tick(p(5, 1000), 1);
		m.tick(p(5, 1000), 2); // trigger
		const ev = m.tick(null, 3);
		expect(ev.event).toBe("none");
		expect(ev.danger).toBe(false);
		expect(ev.healthy).toBeNull();
		expect(m.inPressure).toBe(true);
		// The baseline survives the gap: a following static sample still clears.
		const ev2 = m.tick(p(45, 1000), 4);
		expect(ev2.event).toBe("clear");
	});

	it("free% boundary on recovery is inclusive: exactly HIGH clears, just below does not", () => {
		const m = new MemoryPressureMonitor(TH);
		m.tick(p(5, 1000), 1);
		m.tick(p(5, 1000), 2);
		expect(m.tick(p(14.999, 1000), 3).event).toBe("none");
		expect(m.tick(p(15, 1000), 4).event).toBe("clear");
	});

	it("lastEvaluation exposes the three-state verdict (null before any tick)", () => {
		const m = new MemoryPressureMonitor(TH);
		expect(m.lastEvaluation).toBeNull();
		m.tick(p(50, 100), 1);
		expect(m.lastEvaluation?.healthy).toBeNull(); // first sample: no delta evidence
		m.tick(p(50, 100), 2);
		expect(m.lastEvaluation?.healthy).toBe(true); // proven: free high + delta 0
		m.tick(p(12, 100), 3);
		expect(m.lastEvaluation?.healthy).toBe(false); // proven NOT healthy (band)
	});

	it("a fresh episode after clear re-triggers with a new episode stamp", () => {
		const m = new MemoryPressureMonitor(TH);
		m.tick(p(5, 100), 1);
		m.tick(p(5, 100), 2); // trigger @2
		m.tick(p(45, 100), 3); // clear
		m.tick(p(5, 100), 4);
		expect(m.tick(p(5, 100), 5).event).toBe("trigger");
		expect(m.episodeStart).toBe(5);
	});

	it("scar scenario: a huge but STATIC Swapouts total with healthy free% never arms", () => {
		const m = new MemoryPressureMonitor(TH);
		for (let i = 1; i <= 5; i++) {
			const ev = m.tick(p(45, 15_351_310), i);
			expect(ev.event).toBe("none");
			expect(ev.danger).toBe(false);
		}
		expect(m.inPressure).toBe(false);
	});
});

describe("readMemoryPressure (command selection + injection seam)", () => {
	it("FLYWHEEL_SWAP_SENSOR_CMD override feeds the parser (the QA seam, now vm_stat-shaped)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1142-seam-"));
		try {
			const file = join(dir, "vmstat.txt");
			writeFileSync(file, fixture());
			const got = await readMemoryPressure({
				FLYWHEEL_SWAP_SENSOR_CMD: `cat ${file}`,
			} as unknown as NodeJS.ProcessEnv);
			expect(got).not.toBeNull();
			expect(got!.freePct).toBeCloseTo(FREE_PCT, 6);
			expect(got!.swapoutsTotal).toBe(BUCKETS.swapouts);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a failing override command returns null (skip the tick, never fake health)", async () => {
		expect(
			await readMemoryPressure({
				FLYWHEEL_SWAP_SENSOR_CMD: "exit 1",
			} as unknown as NodeJS.ProcessEnv),
		).toBeNull();
	});

	it("with NO override it executes vm_stat and NEVER sysctl (the monotonic-swap root cause is gone)", async () => {
		// PATH-stub the two binaries: each records its invocation. This is the
		// no-override command-selection proof — an override-driven E2E cannot
		// falsify a lingering sysctl dependency, only this can.
		const dir = mkdtempSync(join(tmpdir(), "fly1142-path-"));
		const oldPath = process.env.PATH;
		try {
			const vmStatCalls = join(dir, "vm_stat.calls");
			const sysctlCalls = join(dir, "sysctl.calls");
			const fixtureFile = join(dir, "fixture.txt");
			writeFileSync(fixtureFile, fixture());
			writeFileSync(
				join(dir, "vm_stat"),
				`#!/bin/sh\necho called >> ${vmStatCalls}\ncat ${fixtureFile}\n`,
			);
			writeFileSync(
				join(dir, "sysctl"),
				`#!/bin/sh\necho called >> ${sysctlCalls}\necho "vm.swapusage: total = 1024.00M  used = 512.00M  free = 512.00M"\n`,
			);
			chmodSync(join(dir, "vm_stat"), 0o755);
			chmodSync(join(dir, "sysctl"), 0o755);
			process.env.PATH = `${dir}:${oldPath}`;
			const got = await readMemoryPressure({} as NodeJS.ProcessEnv);
			expect(got).not.toBeNull();
			expect(got!.swapoutsTotal).toBe(BUCKETS.swapouts);
			expect(readFileSync(vmStatCalls, "utf-8")).toContain("called");
			expect(() => readFileSync(sysctlCalls, "utf-8")).toThrow(); // never ran
		} finally {
			process.env.PATH = oldPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("grep sentinel — the monotonic swap signal must not flow back", () => {
	it("production teamlead source carries no vm.swapusage / old Swap* sensor symbols", () => {
		const srcRoot = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../..", // src/bridge/__tests__ → src
		);
		const offenders: string[] = [];
		const banned = [
			"vm.swapusage",
			"readSwapUsage",
			"parseVmSwapUsage",
			"SwapPressureMonitor",
			"swapThresholdsFromEnv",
		];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name === "__tests__" || entry.name === "node_modules")
					continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (entry.name.endsWith(".ts")) {
					const text = readFileSync(full, "utf-8");
					for (const term of banned) {
						if (text.includes(term)) offenders.push(`${full}: ${term}`);
					}
				}
			}
		};
		walk(srcRoot);
		expect(offenders).toEqual([]);
	});
});
