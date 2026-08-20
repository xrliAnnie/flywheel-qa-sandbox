import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChromeSweepSample } from "../chrome-session-reaper.js";
import {
	createPlaywrightOrphanCensusRecorder,
	formatPlaywrightOrphanCensusOnce,
	type PlaywrightOrphanCensusLine,
} from "../playwright-orphan-census.js";

const ROOT = "/Users/x/Library/Caches/ms-playwright-mcp";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const START = "Thu Aug 20 08:00:00 2026";
const NOW = new Date("2026-08-20T16:00:00.000Z");

const ok = <T>(rows: ReadonlyMap<number, T>) => ({
	status: "ok" as const,
	rows,
});
const unknown = (error: string) => ({ status: "unknown" as const, error });

function sample(
	commEntries: Array<[number, string]>,
	cmdEntries: Array<[number, { ppid: number; command: string }]>,
	ageEntries: Array<[number, { ageMs: number; lstart: string }]>,
): ChromeSweepSample {
	return {
		comm: ok(new Map(commEntries)),
		command: ok(new Map(cmdEntries)),
		age: ok(new Map(ageEntries)),
	};
}

async function inspect(
	sweepSample: ChromeSweepSample,
	orphanGraceMinutes = 30,
): Promise<PlaywrightOrphanCensusLine> {
	return JSON.parse(
		await formatPlaywrightOrphanCensusOnce({
			sample: sweepSample,
			now: () => NOW,
			orphanGraceMinutes,
			profileRoot: ROOT,
			readMcpCacheVersions: async () => ["0.0.79"],
		}),
	) as PlaywrightOrphanCensusLine;
}

describe("playwright orphan census", () => {
	it("selects only an old ppid-1 Chrome main under the Playwright profile root", async () => {
		const line = await inspect(
			sample(
				[[100, CHROME]],
				[
					[
						100,
						{
							ppid: 1,
							command: `${CHROME} --user-data-dir=${ROOT}/mcp-chrome-abc1234`,
						},
					],
				],
				[[100, { ageMs: 31 * 60_000, lstart: START }]],
			),
		);
		expect(line).toMatchObject({
			status: "ok",
			effective_grace_min: 30,
			mcp_cache_versions: ["0.0.79"],
			profile_roots_in_scope: [ROOT],
			known_profile_roots_out_of_scope: [
				"/Users/x/Library/Caches/ms-playwright/daemon",
				join(tmpdir(), "playwright_*_profile-*"),
			],
			candidates: [
				{
					pid: 100,
					lstart: START,
					profile_token: "mcp-chrome-abc1234",
					age_min: 31,
				},
			],
		});
	});

	it("rejects a malformed or nested profile name instead of widening root scope", async () => {
		const line = await inspect(
			sample(
				[
					[100, CHROME],
					[101, CHROME],
				],
				[
					[
						100,
						{
							ppid: 1,
							command: `${CHROME} --user-data-dir=${ROOT}/mcp-chrome-short`,
						},
					],
					[
						101,
						{
							ppid: 1,
							command: `${CHROME} --user-data-dir=${ROOT}/nested/mcp-chrome-abc1234`,
						},
					],
				],
				[
					[100, { ageMs: 60 * 60_000, lstart: START }],
					[101, { ageMs: 60 * 60_000, lstart: START }],
				],
			),
		);
		expect(line.candidates).toEqual([]);
	});

	it("does not select a live-parent server, renderer, or argv-text lookalike", async () => {
		const line = await inspect(
			sample(
				[
					[100, CHROME],
					[101, CHROME],
					[102, "/opt/homebrew/bin/node"],
				],
				[
					[
						100,
						{
							ppid: 99,
							command: `${CHROME} --user-data-dir=${ROOT}/mcp-chrome-live`,
						},
					],
					[
						101,
						{
							ppid: 1,
							command: `${CHROME} --type=renderer --user-data-dir=${ROOT}/mcp-chrome-child`,
						},
					],
					[
						102,
						{
							ppid: 1,
							command: `node issue.js --user-data-dir=${ROOT}/mcp-chrome-fake`,
						},
					],
				],
				[
					[100, { ageMs: 60 * 60_000, lstart: START }],
					[101, { ageMs: 60 * 60_000, lstart: START }],
					[102, { ageMs: 60 * 60_000, lstart: START }],
				],
			),
		);
		expect(line.status).toBe("ok");
		expect(line.candidates).toEqual([]);
	});

	it("uses a 30-minute floor without changing the supplied legacy grace", async () => {
		const line = await inspect(sample([], [], []), 5);
		expect(line.effective_grace_min).toBe(30);
	});

	it("marks any whole-sensor failure unknown rather than clean-empty", async () => {
		const sweepSample: ChromeSweepSample = {
			comm: unknown("comm ps timeout"),
			command: ok(new Map()),
			age: ok(new Map()),
		};
		const line = await inspect(sweepSample);
		expect(line.status).toBe("unknown");
		expect(line.sensor_errors).toContain("comm:comm ps timeout");
		expect(line.candidates).toEqual([]);
	});

	it("marks a candidate-relevant missing join field unknown", async () => {
		const line = await inspect(
			sample(
				[[100, CHROME]],
				[
					[
						100,
						{
							ppid: 1,
							command: `${CHROME} --user-data-dir=${ROOT}/mcp-chrome-a`,
						},
					],
				],
				[],
			),
		);
		expect(line.status).toBe("unknown");
		expect(line.sensor_errors).toContain("join:pid=100:missing=age");
		expect(line.candidates).toEqual([]);
	});

	it("does not poison health when an unrelated PID appears in only one pass", async () => {
		const line = await inspect(sample([[900, "/usr/bin/sleep"]], [], []));
		expect(line.status).toBe("ok");
		expect(line.candidates).toEqual([]);
	});

	it("marks a cache-version reader failure unknown", async () => {
		const line = JSON.parse(
			await formatPlaywrightOrphanCensusOnce({
				sample: sample([], [], []),
				now: () => NOW,
				orphanGraceMinutes: 30,
				profileRoot: ROOT,
				readMcpCacheVersions: async () => {
					throw new Error("cache unavailable");
				},
			}),
		) as PlaywrightOrphanCensusLine;
		expect(line.status).toBe("unknown");
		expect(line.sensor_errors).toContain(
			"mcp_cache_versions:cache unavailable",
		);
	});

	it("appends on boot/change/status/daily heartbeat but not an unchanged same-day tick", async () => {
		const appended: PlaywrightOrphanCensusLine[] = [];
		let now = NOW;
		const recorder = createPlaywrightOrphanCensusRecorder({
			now: () => now,
			profileRoot: ROOT,
			readMcpCacheVersions: async () => ["0.0.79"],
			appendLedger: async (line) => appended.push(line),
		});
		const clean = sample([], [], []);
		const first = await recorder.run({
			sample: clean,
			mode: "boot",
			orphanGraceMinutes: 5,
		});
		expect(first).toContain("recorded=boot");
		await recorder.run({
			sample: clean,
			mode: "periodic",
			orphanGraceMinutes: 5,
		});
		expect(appended).toHaveLength(1);

		now = new Date("2026-08-21T16:00:00.000Z");
		await recorder.run({
			sample: clean,
			mode: "periodic",
			orphanGraceMinutes: 5,
		});
		expect(appended).toHaveLength(2);

		const failed: ChromeSweepSample = { ...clean, age: unknown("age failed") };
		await recorder.run({
			sample: failed,
			mode: "periodic",
			orphanGraceMinutes: 5,
		});
		expect(appended).toHaveLength(3);
		expect(appended.at(-1)?.status).toBe("unknown");
	});

	it("keeps the module and runtime entry free of mutator and alert capabilities", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../playwright-orphan-census.ts", import.meta.url)),
			"utf8",
		);
		expect(source).not.toMatch(
			/StateStore|LeadAlert|Discord|notifier|signalProc|killProc/,
		);
		expect(source).not.toMatch(/publish-report/);
		const plugin = readFileSync(
			fileURLToPath(new URL("../plugin.ts", import.meta.url)),
			"utf8",
		);
		expect(plugin).toContain("collectChromeSweepSample");
		expect(plugin).toContain("createPlaywrightOrphanCensusRecorder");
		expect(plugin).toMatch(/sweepSample:\s*chromeSweepSample/);
	});
});
