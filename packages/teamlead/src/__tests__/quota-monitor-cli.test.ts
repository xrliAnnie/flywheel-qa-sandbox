import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
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
	installWakeCapability,
	resolveOwnProcessStartTime,
	runQuotaMonitorLoop,
	runtimeTreeShaCommand,
	writeCompletedTickMarker,
} from "../account-heal/quota-monitor-cli.js";
import { DEFAULT_QUOTA_MONITOR_CONFIG } from "../account-heal/quota-monitor-config.js";
import { emptyQuotaMonitorState } from "../account-heal/quota-monitor-state.js";

let dir: string;
let path: string;
const TEST_UID = process.getuid?.() ?? 0;
const FOREIGN_UID = TEST_UID + 1;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1256-pid-"));
	path = join(dir, "quota.pid");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pidDeps(pid = 123) {
	return {
		pid,
		uid: TEST_UID,
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
		const first = acquireSingletonPidfile(path, {
			...pidDeps(),
			wakeProtocol: 1,
		});
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			pid: 123,
			uid: TEST_UID,
			processStartTime: "start-123",
			wakeProtocol: 1,
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
			JSON.stringify({ pid: 999, uid: TEST_UID, processStartTime: "old" }),
			{ mode: 0o600 },
		);
		const owner = acquireSingletonPidfile(path, {
			...pidDeps(),
			isProcessAlive: () => false,
		});
		expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(123);
		owner.release();
	});

	it("does not unlink a successor that replaces the stale record before reclaim", () => {
		writeFileSync(
			path,
			JSON.stringify({ pid: 999, uid: TEST_UID, processStartTime: "old" }),
			{ mode: 0o600 },
		);
		let interleaved = false;

		expect(() =>
			acquireSingletonPidfile(path, {
				...pidDeps(),
				isProcessAlive: (candidate) => candidate === 777,
				beforeStaleUnlink: () => {
					if (interleaved) return;
					interleaved = true;
					writeFileSync(
						path,
						JSON.stringify({
							pid: 777,
							uid: TEST_UID,
							processStartTime: "start-777",
						}),
						{ mode: 0o600 },
					);
				},
			}),
		).toThrow(/already running/i);

		expect(interleaved).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: 777 });
	});

	it("refuses symlinks, foreign uid files, and a live PID with mismatched start time", () => {
		const outside = join(dir, "outside");
		writeFileSync(outside, "outside");
		symlinkSync(outside, path);
		expect(() => acquireSingletonPidfile(path, pidDeps())).toThrow(/unsafe/i);
		rmSync(path);

		writeFileSync(
			path,
			JSON.stringify({
				pid: 999,
				uid: FOREIGN_UID,
				processStartTime: "start-999",
			}),
			{ mode: 0o600 },
		);
		expect(() => acquireSingletonPidfile(path, pidDeps())).toThrow(/unsafe/i);
		rmSync(path);

		writeFileSync(
			path,
			JSON.stringify({
				pid: 999,
				uid: TEST_UID,
				processStartTime: "old-start",
			}),
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
			JSON.stringify({ pid: 777, uid: TEST_UID, processStartTime: "new" }),
			{ mode: 0o600 },
		);
		owner.release();
		expect(existsSync(path)).toBe(true);
	});
});

describe("daemon scheduler", () => {
	it("returns the injected runtime tree sha only for the exact inspection command", () => {
		expect(runtimeTreeShaCommand(["--runtime-tree-sha"], () => "abc")).toBe(
			"abc",
		);
		expect(runtimeTreeShaCommand([], () => "must-not-run")).toBeNull();
		expect(
			runtimeTreeShaCommand(
				["--runtime-tree-sha", "extra"],
				() => "must-not-run",
			),
		).toBeNull();
	});

	it("prints the built runtime tree sha without creating daemon capabilities", () => {
		const pidfile = join(dir, "inspect.pid");
		const runMarker = join(dir, "inspect.running");
		const healthMarker = join(dir, "inspect.health.json");
		const cli = join(
			import.meta.dirname,
			"..",
			"..",
			"dist",
			"account-heal",
			"quota-monitor-cli.js",
		);
		const result = spawnSync(process.execPath, [cli, "--runtime-tree-sha"], {
			encoding: "utf8",
			env: {
				...process.env,
				FLYWHEEL_QUOTA_PIDFILE: pidfile,
				FLYWHEEL_QUOTA_RUN_MARKER: runMarker,
				FLYWHEEL_QUOTA_HEALTH_MARKER: healthMarker,
			},
		});

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toMatch(/^[a-f0-9]{64}$/);
		expect(result.stderr).toBe("");
		expect([pidfile, runMarker, healthMarker].some(existsSync)).toBe(false);
	});

	it("publishes an owner-only marker only after a tick has completed", () => {
		const marker = join(dir, "quota.health.json");
		writeCompletedTickMarker(marker, {
			version: 1,
			pid: 123,
			processStartTime: "start-123",
			runtimeTreeSha256: "a".repeat(64),
			completedAt: 456,
			outcome: "observed",
		});
		expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
			version: 1,
			pid: 123,
			processStartTime: "start-123",
			runtimeTreeSha256: "a".repeat(64),
			completedAt: 456,
			outcome: "observed",
		});
		expect(statSync(marker).mode & 0o777).toBe(0o600);
	});

	it("publishes wake capability only inside the installed SIGUSR1 handler lifetime", () => {
		const events: string[] = [];
		const release = installWakeCapability({
			on: (_signal, _handler) => events.push("handler:on"),
			off: (_signal, _handler) => events.push("handler:off"),
			acquire: (_path, deps) => {
				events.push(`acquire:wake-${deps.wakeProtocol}`);
				return { release: () => events.push("pidfile:release") };
			},
			pidfilePath: path,
			handler: () => undefined,
		});

		expect(events).toEqual(["handler:on", "acquire:wake-1"]);
		release();
		expect(events).toEqual([
			"handler:on",
			"acquire:wake-1",
			"pidfile:release",
			"handler:off",
		]);
	});

	it("removes the SIGUSR1 handler when pidfile acquisition fails", () => {
		const events: string[] = [];
		expect(() =>
			installWakeCapability({
				on: () => events.push("handler:on"),
				off: () => events.push("handler:off"),
				acquire: () => {
					events.push("acquire");
					throw new Error("busy");
				},
				pidfilePath: path,
				handler: () => undefined,
			}),
		).toThrow("busy");
		expect(events).toEqual(["handler:on", "acquire", "handler:off"]);
	});

	it("removes the durable run marker only on graceful shutdown", () => {
		const marker = join(dir, "run.marker");
		writeFileSync(marker, "started", { mode: 0o600 });
		cleanupRunMarker(marker, false);
		expect(existsSync(marker)).toBe(true);
		cleanupRunMarker(marker, true);
		expect(existsSync(marker)).toBe(false);
	});

	it("wakes at the earliest independent usage, pane-scan, or confirmation deadline", () => {
		const now = 1_000_000;
		expect(
			computeNextDelay(
				{
					...emptyQuotaMonitorState(),
					nextUsageDueAt: now + 20 * 60_000,
					nextPaneScanDueAt: now + 60_000,
				},
				DEFAULT_QUOTA_MONITOR_CONFIG,
				now,
			),
		).toBe(60_000);
		expect(
			computeNextDelay(
				{
					...emptyQuotaMonitorState(),
					nextUsageDueAt: now + 15 * 60_000,
					nextPaneScanDueAt: now + 60_000,
					confirmDueAt: now + 30_000,
					backoffUntilMs: now + 15 * 60_000,
				},
				DEFAULT_QUOTA_MONITOR_CONFIG,
				now,
			),
		).toBe(30_000);
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
				return {
					...emptyQuotaMonitorState(),
					nextUsageDueAt: 20 * 60_000,
					nextPaneScanDueAt: 60_000,
				};
			},
			now: () => 0,
			wait: vi.fn(async (delay: number) => {
				delays.push(delay);
			}),
		});
		expect(loads).toEqual([1, 2]);
		expect(polls).toEqual([1, 2]);
		expect(delays).toEqual([60_000]);
	});
});
