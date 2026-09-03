import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	CAPACITY_UNAVAILABLE_TOKENS,
	isCapacityUnavailableToken,
	MEMORY_PRESSURE_ARGV,
	MEMORY_PRESSURE_BIN,
	MEMORY_PRESSURE_TIMEOUT_MS,
	parseMemoryPressureFreePct,
	readMemoryFreePct,
} from "../machine-free-pct.js";

describe("parseMemoryPressureFreePct", () => {
	it("accepts only a bounded integer on the last non-empty output line", () => {
		expect(
			parseMemoryPressureFreePct(
				[
					"The system has 51539607552 bytes (3145728 pages with a page size of 16384).",
					"System-wide memory free percentage: 75%",
					"",
				].join("\n"),
			),
		).toBe(75);
		expect(
			parseMemoryPressureFreePct("System-wide memory free percentage: 0%\n"),
		).toBe(0);
		expect(
			parseMemoryPressureFreePct(
				"System-wide memory free percentage: 100%   \n\n",
			),
		).toBe(100);

		for (const invalid of [
			"",
			"System-wide memory free percentage: -1%",
			"System-wide memory free percentage: 101%",
			"System-wide memory free percentage: 75.5%",
			"System-wide memory free percentage: 75%\nunexpected trailer",
			"prefix System-wide memory free percentage: 75%",
		]) {
			expect(parseMemoryPressureFreePct(invalid), invalid).toBeNull();
		}
	});
});

describe("isCapacityUnavailableToken", () => {
	it("accepts only the capacity builder allowlist and bounded exit tokens", () => {
		for (const token of CAPACITY_UNAVAILABLE_TOKENS) {
			expect(isCapacityUnavailableToken(token), token).toBe(true);
		}
		expect(
			isCapacityUnavailableToken("transient: memory_pressure_exit_17"),
		).toBe(true);

		for (const unsafe of [
			"transient: suggest",
			"transient: ignore_previous_instructions",
			"transient: memory_pressure_exit_1000",
			"transient: rm -rf /",
			"structural: unknown_reason",
			undefined,
		]) {
			expect(isCapacityUnavailableToken(unsafe), String(unsafe)).toBe(false);
		}
	});
});

describe("readMemoryFreePct", () => {
	it("runs the absolute binary with empty argv and returns a timestamped reading", async () => {
		const execFile = vi.fn(async () => ({
			stdout: "System-wide memory free percentage: 63%\n",
			stderr: "",
		}));

		await expect(
			readMemoryFreePct({
				execFile,
				platform: "darwin",
				now: () => Date.parse("2026-09-03T04:00:00.000Z"),
			}),
		).resolves.toEqual({
			freePct: 63,
			observedAt: "2026-09-03T04:00:00.000Z",
		});
		expect(MEMORY_PRESSURE_BIN.startsWith("/")).toBe(true);
		expect(MEMORY_PRESSURE_ARGV).toEqual([]);
		expect(Object.isFrozen(MEMORY_PRESSURE_ARGV)).toBe(true);
		expect(execFile).toHaveBeenCalledWith(MEMORY_PRESSURE_BIN, [], {
			timeout: MEMORY_PRESSURE_TIMEOUT_MS,
			maxBuffer: 64 * 1024,
		});
	});

	it("does not execute away from macOS and reports the structural gap", async () => {
		const execFile = vi.fn();
		await expect(
			readMemoryFreePct({
				execFile,
				platform: "linux",
				now: () => Date.parse("2026-09-03T04:01:00.000Z"),
			}),
		).resolves.toEqual({
			freePct: null,
			observedAt: "2026-09-03T04:01:00.000Z",
			unavailable: "structural: memory_pressure_unsupported_platform",
		});
		expect(execFile).not.toHaveBeenCalled();
	});

	it("turns unparseable command output into an explicit transient reading", async () => {
		await expect(
			readMemoryFreePct({
				execFile: vi.fn(async () => ({ stdout: "not a reading", stderr: "" })),
				platform: "darwin",
				now: () => Date.parse("2026-09-03T04:02:00.000Z"),
			}),
		).resolves.toEqual({
			freePct: null,
			observedAt: "2026-09-03T04:02:00.000Z",
			unavailable: "transient: memory_pressure_parse_failed",
		});
	});

	it("maps missing, timeout, signal, and nonzero-exit failures without rejecting", async () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ code: "ENOENT" }, "structural: memory_pressure_missing"],
			[{ code: "ETIMEDOUT" }, "transient: memory_pressure_timeout"],
			[{ signal: "SIGTERM" }, "transient: memory_pressure_timeout"],
			[{ code: 0 }, "transient: memory_pressure_timeout"],
			[{ code: 17 }, "transient: memory_pressure_exit_17"],
		];
		for (const [properties, unavailable] of cases) {
			const error = Object.assign(new Error("probe failed"), properties);
			await expect(
				readMemoryFreePct({
					execFile: vi.fn(async () => {
						throw error;
					}),
					platform: "darwin",
					now: () => Date.parse("2026-09-03T04:03:00.000Z"),
				}),
			).resolves.toEqual({
				freePct: null,
				observedAt: "2026-09-03T04:03:00.000Z",
				unavailable,
			});
		}
	});

	it("keeps pressure-applying argv and shell execution out of the sampler source", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../machine-free-pct.ts", import.meta.url)),
			"utf8",
		);
		for (const forbidden of [
			'"-l"',
			'"-p"',
			'"-S"',
			'"-s"',
			"/bin/sh",
			"spawn(",
			"exec(",
		]) {
			expect(source, forbidden).not.toContain(forbidden);
		}
	});
});
