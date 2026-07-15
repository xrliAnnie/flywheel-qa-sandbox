import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireSingletonPidfile,
	cleanupRunMarker,
	computeNextDelay,
	resolveOwnProcessStartTime,
	runQuotaMonitorLoop,
} from "../account-heal/quota-monitor-cli.js";
import { DEFAULT_QUOTA_MONITOR_CONFIG } from "../account-heal/quota-monitor-config.js";
import { emptyQuotaMonitorState } from "../account-heal/quota-monitor-state.js";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1256-pid-"));
	path = join(dir, "quota.pid");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pidDeps(pid = 123) {
	return {
		pid,
		uid: 501,
		processStartTime: `start-${pid}`,
		isProcessAlive: (candidate: number) => candidate === pid,
		readProcessStartTime: (candidate: number) => `start-${candidate}`,
	};
}

describe("atomic singleton pidfile", () => {
	it("uses a stable Node-uptime identity for self when ps is unavailable", () => {
		expect(
			resolveOwnProcessStartTime({
				readStart: () => null,
				nowMs: () => 10_000,
				uptimeSeconds: () => 2.5,
			}),
		).toBe("node-uptime:7500");
	});

	it("open(wx) allows exactly one owner and release removes only its own record", () => {
		const first = acquireSingletonPidfile(path, pidDeps());
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			pid: 123,
			uid: 501,
			processStartTime: "start-123",
		});
		expect(() =>
			acquireSingletonPidfile(path, {
				...pidDeps(124),
				isProcessAlive: (candidate) => candidate === 123,
				readProcessStartTime: (candidate) => `start-${candidate}`,
			}),
		).toThrow(/already running/i);
		first.release();
		expect(existsSync(path)).toBe(false);
	});

	it("replaces a dead same-owner regular pidfile", () => {
		writeFileSync(
			path,
			JSON.stringify({ pid: 999, uid: 501, processStartTime: "old" }),
			{ mode: 0o600 },
		);
		const owner = acquireSingletonPidfile(path, {
			...pidDeps(),
			isProcessAlive: () => false,
		});
		expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(123);
		owner.release();
	});

	it("refuses symlinks, foreign uid files, and a live PID with mismatched start time", () => {
		const outside = join(dir, "outside");
		writeFileSync(outside, "outside");
		symlinkSync(outside, path);
		expect(() => acquireSingletonPidfile(path, pidDeps())).toThrow(/unsafe/i);
		rmSync(path);

		writeFileSync(
			path,
			JSON.stringify({ pid: 999, uid: 502, processStartTime: "start-999" }),
			{ mode: 0o600 },
		);
		expect(() => acquireSingletonPidfile(path, pidDeps())).toThrow(/unsafe/i);
		rmSync(path);

		writeFileSync(
			path,
			JSON.stringify({ pid: 999, uid: 501, processStartTime: "old-start" }),
			{ mode: 0o600 },
		);
		expect(() =>
			acquireSingletonPidfile(path, {
				...pidDeps(),
				isProcessAlive: () => true,
				readProcessStartTime: () => "new-start",
			}),
		).toThrow(/unsafe/i);
	});

	it("release does not unlink a pidfile whose ownership record changed", () => {
		const owner = acquireSingletonPidfile(path, pidDeps());
		writeFileSync(
			path,
			JSON.stringify({ pid: 777, uid: 501, processStartTime: "new" }),
			{ mode: 0o600 },
		);
		owner.release();
		expect(existsSync(path)).toBe(true);
	});
});

describe("daemon scheduler", () => {
	it("removes the durable run marker only on graceful shutdown", () => {
		const marker = join(dir, "run.marker");
		writeFileSync(marker, "started", { mode: 0o600 });
		cleanupRunMarker(marker, false);
		expect(existsSync(marker)).toBe(true);
		cleanupRunMarker(marker, true);
		expect(existsSync(marker)).toBe(false);
	});

	it("respects the larger of the current tier interval and persisted backoff", () => {
		const now = 1_000_000;
		expect(
			computeNextDelay(
				{ ...emptyQuotaMonitorState(), tier: "base" },
				DEFAULT_QUOTA_MONITOR_CONFIG,
				now,
			),
		).toBe(20 * 60_000);
		expect(
			computeNextDelay(
				{
					...emptyQuotaMonitorState(),
					tier: "accelerated",
					backoffUntilMs: now + 15 * 60_000,
				},
				DEFAULT_QUOTA_MONITOR_CONFIG,
				now,
			),
		).toBe(15 * 60_000);
	});

	it("re-loads config/state for every tick and stops without scheduling another tick", async () => {
		const loads: number[] = [];
		const polls: number[] = [];
		const delays: number[] = [];
		let stop = false;
		await runQuotaMonitorLoop({
			isStopping: () => stop,
			loadContext: async () => {
				loads.push(loads.length + 1);
				return {
					config: DEFAULT_QUOTA_MONITOR_CONFIG,
					state: emptyQuotaMonitorState(),
				};
			},
			poll: async () => {
				polls.push(polls.length + 1);
				if (polls.length === 2) stop = true;
				return emptyQuotaMonitorState();
			},
			now: () => 0,
			wait: vi.fn(async (delay: number) => {
				delays.push(delay);
			}),
		});
		expect(loads).toEqual([1, 2]);
		expect(polls).toEqual([1, 2]);
		expect(delays).toEqual([20 * 60_000]);
	});
});
