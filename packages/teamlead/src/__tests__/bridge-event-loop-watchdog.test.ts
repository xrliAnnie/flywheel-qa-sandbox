/**
 * FLY-307 C: BridgeEventLoopWatchdog tests.
 *
 * Coverage:
 *  - pure `isLoopStalled` boundaries
 *  - main-side mechanics with an INJECTED worker (no real killing thread):
 *    heartbeat advances the BigInt64Array; enable/disable + env kill-switch;
 *    stop() tears down
 *  - real-worker cross-thread detection (testMode → postMessage, no kill)
 *  - POSIX child-process test of the actual SIGKILL recovery path
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BridgeEventLoopWatchdog,
	isLoopStalled,
	WATCHDOG_WORKER_SOURCE,
	type WatchdogWorkerData,
	type WorkerLike,
} from "../bridge/BridgeEventLoopWatchdog.js";

describe("isLoopStalled", () => {
	it("fresh heartbeat is not stalled", () => {
		expect(isLoopStalled(1000, 1000, 60_000)).toBe(false);
	});
	it("busy-but-alive (under threshold) is not stalled", () => {
		expect(isLoopStalled(0, 59_999, 60_000)).toBe(false);
	});
	it("exactly at threshold is not stalled (strict >)", () => {
		expect(isLoopStalled(0, 60_000, 60_000)).toBe(false);
	});
	it("past threshold is stalled", () => {
		expect(isLoopStalled(0, 60_001, 60_000)).toBe(true);
	});
});

describe("BridgeEventLoopWatchdog (main-side mechanics, injected worker)", () => {
	let envSnapshot: Record<string, string | undefined>;

	beforeEach(() => {
		envSnapshot = {
			off: process.env.FLYWHEEL_BRIDGE_WATCHDOG,
			stall: process.env.FLYWHEEL_BRIDGE_WATCHDOG_STALL_MS,
			hb: process.env.FLYWHEEL_BRIDGE_WATCHDOG_HEARTBEAT_MS,
		};
		delete process.env.FLYWHEEL_BRIDGE_WATCHDOG;
		delete process.env.FLYWHEEL_BRIDGE_WATCHDOG_STALL_MS;
		delete process.env.FLYWHEEL_BRIDGE_WATCHDOG_HEARTBEAT_MS;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const [k, key] of [
			["off", "FLYWHEEL_BRIDGE_WATCHDOG"],
			["stall", "FLYWHEEL_BRIDGE_WATCHDOG_STALL_MS"],
			["hb", "FLYWHEEL_BRIDGE_WATCHDOG_HEARTBEAT_MS"],
		] as const) {
			const v = envSnapshot[k];
			if (v === undefined) delete process.env[key];
			else process.env[key] = v;
		}
	});

	function stubWorker(): WorkerLike & { terminated: boolean } {
		return {
			terminated: false,
			terminate() {
				this.terminated = true;
				return undefined;
			},
			unref() {
				return undefined;
			},
			on() {
				return undefined;
			},
		};
	}

	it("heartbeat advances the shared view on each interval tick", () => {
		let mockNow = 10_000;
		let captured: { eval: true; workerData: WatchdogWorkerData } | null = null;
		const wd = new BridgeEventLoopWatchdog({
			enabled: true,
			heartbeatIntervalMs: 1000,
			now: () => mockNow,
			ensureDir: () => {},
			createWorker: (_src, opts) => {
				captured = opts;
				return stubWorker();
			},
		});

		wd.start();
		// Seeded at construction-time now().
		expect(wd._peekHeartbeat()).toBe(10_000);
		expect(captured).not.toBeNull();
		expect(captured?.workerData.testMode).toBe(false);
		expect(captured?.workerData.sab).toBeInstanceOf(SharedArrayBuffer);

		mockNow = 11_000;
		vi.advanceTimersByTime(1000);
		expect(wd._peekHeartbeat()).toBe(11_000);

		mockNow = 12_500;
		vi.advanceTimersByTime(1000);
		expect(wd._peekHeartbeat()).toBe(12_500);

		wd.stop();
		expect(wd._peekHeartbeat()).toBeNull();
	});

	it("enabled:false → no worker spawned, no heartbeat", () => {
		const create = vi.fn(() => stubWorker());
		const wd = new BridgeEventLoopWatchdog({
			enabled: false,
			ensureDir: () => {},
			createWorker: create,
		});
		wd.start();
		expect(create).not.toHaveBeenCalled();
		expect(wd._peekHeartbeat()).toBeNull();
		expect(wd.isEnabled()).toBe(false);
	});

	it("FLYWHEEL_BRIDGE_WATCHDOG=0 overrides enabled:true", () => {
		process.env.FLYWHEEL_BRIDGE_WATCHDOG = "0";
		const create = vi.fn(() => stubWorker());
		const wd = new BridgeEventLoopWatchdog({
			enabled: true,
			ensureDir: () => {},
			createWorker: create,
		});
		expect(wd.isEnabled()).toBe(false);
		wd.start();
		expect(create).not.toHaveBeenCalled();
	});

	it("stop() terminates the worker", () => {
		const w = stubWorker();
		const wd = new BridgeEventLoopWatchdog({
			enabled: true,
			now: () => 1,
			ensureDir: () => {},
			createWorker: () => w,
		});
		wd.start();
		expect(w.terminated).toBe(false);
		wd.stop();
		expect(w.terminated).toBe(true);
	});
});

describe("BridgeEventLoopWatchdog (real worker)", () => {
	it("cross-thread: a stale heartbeat triggers a 'stall' message (testMode)", async () => {
		const sab = new SharedArrayBuffer(8);
		const view = new BigInt64Array(sab);
		// Stale by 10 minutes.
		Atomics.store(view, 0, BigInt(Date.now() - 600_000));

		const worker = new Worker(WATCHDOG_WORKER_SOURCE, {
			eval: true,
			workerData: {
				sab,
				stallThresholdMs: 60_000,
				checkIntervalMs: 10,
				logPath: "",
				testMode: true,
			} satisfies WatchdogWorkerData,
		});

		const events = await new Promise<{ msg: unknown; exitCode: number }>(
			(resolve, reject) => {
				let msg: unknown;
				worker.on("message", (m) => {
					msg = m;
				});
				worker.on("error", reject);
				// testMode self-terminates after posting → exit(0) with no leaked handles.
				worker.on("exit", (exitCode) => resolve({ msg, exitCode }));
			},
		);
		expect(events.msg).toBe("stall");
		expect(events.exitCode).toBe(0);
	});

	it.skipIf(process.platform === "win32")(
		"production kill: worker SIGKILLs an idle host process",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "fly307-wd-"));
			try {
				const srcPath = join(dir, "worker-source.js");
				writeFileSync(srcPath, WATCHDOG_WORKER_SOURCE);

				const harnessPath = join(dir, "harness.mjs");
				writeFileSync(
					harnessPath,
					`
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
const source = readFileSync(process.argv[2], "utf8");
const sab = new SharedArrayBuffer(8);
const view = new BigInt64Array(sab);
// Very stale → immediate stall on the first worker check.
Atomics.store(view, 0, BigInt(Date.now() - 10_000_000));
new Worker(source, {
  eval: true,
  workerData: { sab, stallThresholdMs: 1000, checkIntervalMs: 10, logPath: "", testMode: false },
});
// Keep the host main loop alive so the worker is the one that ends it.
setInterval(() => {}, 1000);
`,
				);

				const child = spawn(process.execPath, [harnessPath, srcPath]);
				const result = await new Promise<{
					code: number | null;
					signal: NodeJS.Signals | null;
				}>((resolve) => {
					child.on("exit", (code, signal) => resolve({ code, signal }));
				});

				expect(result.signal).toBe("SIGKILL");
				expect(result.code).toBeNull();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		15_000,
	);
});
