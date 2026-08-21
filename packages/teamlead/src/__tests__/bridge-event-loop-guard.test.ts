/**
 * FLY-307 C: BridgeEventLoopGuard tests.
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BridgeEventLoopGuard,
	isLoopStalled,
	LOOP_GUARD_WORKER_SOURCE,
	type LoopGuardWorkerData,
	type WorkerLike,
} from "../bridge/BridgeEventLoopGuard.js";

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

describe("BridgeEventLoopGuard (main-side mechanics, injected worker)", () => {
	let envSnapshot: Record<string, string | undefined>;

	beforeEach(() => {
		envSnapshot = {
			stall: process.env.FLYWHEEL_BRIDGE_LOOP_GUARD_STALL_MS,
			hb: process.env.FLYWHEEL_BRIDGE_LOOP_GUARD_HEARTBEAT_MS,
		};
		delete process.env.FLYWHEEL_BRIDGE_LOOP_GUARD_STALL_MS;
		delete process.env.FLYWHEEL_BRIDGE_LOOP_GUARD_HEARTBEAT_MS;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const [k, key] of [
			["stall", "FLYWHEEL_BRIDGE_LOOP_GUARD_STALL_MS"],
			["hb", "FLYWHEEL_BRIDGE_LOOP_GUARD_HEARTBEAT_MS"],
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
		let captured: { eval: true; workerData: LoopGuardWorkerData } | null = null;
		const wd = new BridgeEventLoopGuard({
			enabled: true,
			bootTs: 9_000,
			pid: 321,
			syncOpMarkerPath: "/tmp/bridge-syncop.321.json",
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
		expect(captured?.workerData.pid).toBe(321);
		expect(captured?.workerData.bootTs).toBe(9_000);
		expect(captured?.workerData.syncOpMarkerPath).toBe(
			"/tmp/bridge-syncop.321.json",
		);

		mockNow = 11_000;
		vi.advanceTimersByTime(1000);
		expect(wd._peekHeartbeat()).toBe(11_000);

		mockNow = 12_500;
		vi.advanceTimersByTime(1000);
		expect(wd._peekHeartbeat()).toBe(12_500);

		wd.stop();
		expect(wd._peekHeartbeat()).toBeNull();
	});

	it("rotates the forensic log in the parent before spawning the worker", () => {
		const order: string[] = [];
		const wd = new BridgeEventLoopGuard({
			enabled: true,
			logPath: "/tmp/bridge-loop-guard.test.log",
			now: () => 1,
			ensureDir: () => order.push("ensure"),
			rotateLog: (path) => {
				order.push(`rotate:${path}`);
				return true;
			},
			createWorker: () => {
				order.push("worker");
				return stubWorker();
			},
		});
		wd.start();
		expect(order).toEqual([
			"ensure",
			"rotate:/tmp/bridge-loop-guard.test.log",
			"worker",
		]);
		wd.stop();
	});

	it("enabled:false → no worker spawned, no heartbeat", () => {
		const create = vi.fn(() => stubWorker());
		const wd = new BridgeEventLoopGuard({
			enabled: false,
			ensureDir: () => {},
			createWorker: create,
		});
		wd.start();
		expect(create).not.toHaveBeenCalled();
		expect(wd._peekHeartbeat()).toBeNull();
		expect(wd.isEnabled()).toBe(false);
	});

	it("stop() terminates the worker", () => {
		const w = stubWorker();
		const wd = new BridgeEventLoopGuard({
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

describe("BridgeEventLoopGuard (real worker)", () => {
	it("forensic line carries generation and the bounded per-pid sync-op breadcrumb", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1365-wd-"));
		try {
			const pid = 456;
			const bootTs = Date.now() - 700_000;
			const lastBeat = Date.now() - 600_000;
			const markerPath = join(dir, `bridge-syncop.${pid}.json`);
			const logPath = join(dir, "loop-guard.log");
			writeFileSync(
				markerPath,
				JSON.stringify({
					label: "codex-adapter:resolve-git-dirs",
					startedAt: lastBeat + 10,
					pid,
					token: "token",
				}),
			);
			const sab = new SharedArrayBuffer(8);
			Atomics.store(new BigInt64Array(sab), 0, BigInt(lastBeat));
			const worker = new Worker(LOOP_GUARD_WORKER_SOURCE, {
				eval: true,
				workerData: {
					sab,
					stallThresholdMs: 60_000,
					checkIntervalMs: 10,
					logPath,
					testMode: true,
					pid,
					bootTs,
					syncOpMarkerPath: markerPath,
				} satisfies LoopGuardWorkerData,
			});
			await new Promise<void>((resolve, reject) => {
				worker.on("error", reject);
				worker.on("exit", () => resolve());
			});
			const line = JSON.parse(readFileSync(logPath, "utf8").trim());
			expect(line).toMatchObject({
				event: "bridge_event_loop_stall",
				pid,
				bootTs,
				last_sync_op: "codex-adapter:resolve-git-dirs",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cross-thread: a stale heartbeat triggers a 'stall' message (testMode)", async () => {
		const sab = new SharedArrayBuffer(8);
		const view = new BigInt64Array(sab);
		// Stale by 10 minutes.
		Atomics.store(view, 0, BigInt(Date.now() - 600_000));

		const worker = new Worker(LOOP_GUARD_WORKER_SOURCE, {
			eval: true,
			workerData: {
				sab,
				stallThresholdMs: 60_000,
				checkIntervalMs: 10,
				logPath: "",
				testMode: true,
				pid: process.pid,
				bootTs: Date.now() - 700_000,
				syncOpMarkerPath: "",
			} satisfies LoopGuardWorkerData,
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
				writeFileSync(srcPath, LOOP_GUARD_WORKER_SOURCE);

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
  workerData: { sab, stallThresholdMs: 1000, checkIntervalMs: 10, logPath: "", testMode: false, pid: process.pid, bootTs: Date.now() - 1000, syncOpMarkerPath: "" },
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
