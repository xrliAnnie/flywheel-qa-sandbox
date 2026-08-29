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

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	async function waitForWorkerMessage(worker: Worker): Promise<unknown> {
		return await new Promise((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
		});
	}

	it("records redacted child evidence with marker-first attribution in two ps calls", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1365-wd-"));
		try {
			const pid = 456;
			const bootTs = Date.now() - 700_000;
			const lastBeat = Date.now() - 600_000;
			const markerPath = join(dir, `bridge-syncop.${pid}.json`);
			const logPath = join(dir, "loop-guard.log");
			const callsPath = join(dir, "ps-calls.log");
			const fakePsPath = join(dir, "fake-ps.cjs");
			writeFileSync(
				fakePsPath,
				`const fs = require("node:fs");
const calls = process.argv[2];
const args = process.argv.slice(3);
fs.appendFileSync(calls, JSON.stringify(args) + "\\n");
if (args.includes("-axo")) {
  fs.rmSync(${JSON.stringify(markerPath)});
  process.stdout.write("701 456 00:05 /usr/bin/git\\n702 456 00:04 /bin/sleep\\n703 999 00:03 /usr/bin/tmux\\n704 456 00:02 /usr/bin/git\\n");
} else {
  process.stdout.write("701 git -c http.extraHeader=Authorization:secret -C /private/repo fetch https://x-access-token:token@example.test/repo.git\\n704 git -c http.extraHeader=Authorization: Basic secret fetch https://example.test/repo.git\\n");
}
`,
			);
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
					psCommand: [process.execPath, fakePsPath, callsPath],
				} satisfies LoopGuardWorkerData,
			});
			expect(await waitForWorkerMessage(worker)).toBe("stall");
			await worker.terminate();
			const raw = readFileSync(logPath, "utf8").trim();
			const line = JSON.parse(raw);
			expect(line).toMatchObject({
				event: "bridge_event_loop_stall",
				pid,
				bootTs,
				last_sync_op: "codex-adapter:resolve-git-dirs",
				attribution: "marker",
				children: [
					{ pid: 701, etime: "00:05", comm: "git", sub: "fetch" },
					{ pid: 702, etime: "00:04", comm: "sleep" },
					{ pid: 704, etime: "00:02", comm: "git" },
				],
			});
			expect(line.tick_gap_ms).toBeGreaterThanOrEqual(0);
			expect(line.stall_age_at_detect_ms).toBeGreaterThan(60_000);
			expect(line.stall_age_ms).toBe(line.stall_age_at_detect_ms);
			expect(line.stall_age_final_ms).toBeGreaterThanOrEqual(
				line.stall_age_at_detect_ms,
			);
			expect(line.rss_mb).toBeGreaterThan(0);
			expect(line.load).toBeTypeOf("number");
			expect(readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(
				2,
			);
			expect(raw).not.toContain("Authorization:secret");
			expect(raw).not.toContain("x-access-token");
			expect(raw).not.toContain("/private/repo");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("spares an S1 stall that recovers while child evidence is collected", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2058-collector-recovery-"));
		try {
			const startedPath = join(dir, "collector-started");
			const fakePsPath = join(dir, "slow-ps.cjs");
			const logPath = join(dir, "loop-guard.log");
			writeFileSync(
				fakePsPath,
				`const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(startedPath)}, "started");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
`,
			);
			const sab = new SharedArrayBuffer(8);
			const view = new BigInt64Array(sab);
			Atomics.store(view, 0, BigInt(Date.now() - 600_000));
			const worker = new Worker(LOOP_GUARD_WORKER_SOURCE, {
				eval: true,
				workerData: {
					sab,
					stallThresholdMs: 200,
					checkIntervalMs: 10,
					logPath,
					testMode: true,
					pid: process.pid,
					bootTs: Date.now(),
					syncOpMarkerPath: "",
					psCommand: [process.execPath, fakePsPath],
				} satisfies LoopGuardWorkerData,
			});
			const message = waitForWorkerMessage(worker);
			await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true));
			Atomics.store(view, 0, BigInt(Date.now()));
			expect(await message).toBe("recovered");
			await worker.terminate();
			const recovered = JSON.parse(readFileSync(logPath, "utf8"));
			expect(recovered).toMatchObject({
				event: "stall_recovered_during_forensics",
				last_sync_op: null,
			});
			expect(recovered).not.toHaveProperty("recovered_via");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("distinguishes an empty child snapshot from collector failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2058-children-"));
		try {
			const emptyPsPath = join(dir, "empty-ps.cjs");
			writeFileSync(emptyPsPath, "process.stdout.write('');\n");
			for (const [name, psCommand, expected] of [
				["empty", [process.execPath, emptyPsPath], []],
				["failed", [join(dir, "missing-ps")], null],
			] as const) {
				const logPath = join(dir, `${name}.log`);
				const sab = new SharedArrayBuffer(8);
				Atomics.store(new BigInt64Array(sab), 0, BigInt(Date.now() - 600_000));
				const worker = new Worker(LOOP_GUARD_WORKER_SOURCE, {
					eval: true,
					workerData: {
						sab,
						stallThresholdMs: 60_000,
						checkIntervalMs: 10,
						logPath,
						testMode: true,
						pid: 456,
						bootTs: Date.now() - 700_000,
						syncOpMarkerPath: "",
						psCommand: [...psCommand],
					} satisfies LoopGuardWorkerData,
				});
				expect(await waitForWorkerMessage(worker)).toBe("stall");
				await worker.terminate();
				const line = JSON.parse(readFileSync(logPath, "utf8").trim());
				expect(line.children).toEqual(expected);
				expect(line.attribution).toBe("unknown");
			}
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

		expect(await waitForWorkerMessage(worker)).toBe("stall");
		await worker.terminate();
	});

	function stateMachineWorker(options: {
		lastBeat: number;
		forceTickGap?: number;
		threshold?: number;
		checkInterval?: number;
		grace?: number;
	}) {
		const dir = mkdtempSync(join(tmpdir(), "fly2058-state-"));
		const logPath = join(dir, "loop-guard.log");
		const sab = new SharedArrayBuffer(16);
		const view = new BigInt64Array(sab);
		Atomics.store(view, 0, BigInt(options.lastBeat));
		Atomics.store(view, 1, BigInt(options.forceTickGap ?? 0));
		const worker = new Worker(LOOP_GUARD_WORKER_SOURCE, {
			eval: true,
			workerData: {
				sab,
				stallThresholdMs: options.threshold ?? 200,
				checkIntervalMs: options.checkInterval ?? 50,
				graceMs: options.grace ?? 200,
				logPath,
				testMode: true,
				pid: process.pid,
				bootTs: Date.now(),
				syncOpMarkerPath: "",
			} satisfies LoopGuardWorkerData,
		});
		return { dir, logPath, view, worker };
	}

	it("S2: heartbeat-before-check records immediate recovery and keeps monitoring", async () => {
		const state = stateMachineWorker({
			lastBeat: Date.now(),
			forceTickGap: 300,
		});
		const heartbeat = setInterval(
			() => Atomics.store(state.view, 0, BigInt(Date.now())),
			10,
		);
		try {
			expect(await waitForWorkerMessage(state.worker)).toBe("recovered");
			const recovered = JSON.parse(readFileSync(state.logPath, "utf8").trim());
			expect(recovered).toMatchObject({
				event: "stall_recovered_after_freeze",
				recovered_via: "immediate",
			});
			expect(recovered.tick_gap_ms).toBeGreaterThanOrEqual(200);
		} finally {
			clearInterval(heartbeat);
			await state.worker.terminate();
			rmSync(state.dir, { recursive: true, force: true });
		}
	});

	it("S3 recovery restarts the same worker, which can later enter S1 once", async () => {
		const state = stateMachineWorker({
			lastBeat: Date.now() - 10_000,
			forceTickGap: 300,
		});
		try {
			state.worker.once("online", () => {
				setTimeout(() => Atomics.store(state.view, 0, BigInt(Date.now())), 100);
			});
			expect(await waitForWorkerMessage(state.worker)).toBe("recovered");
			Atomics.store(state.view, 0, BigInt(Date.now() - 10_000));
			expect(await waitForWorkerMessage(state.worker)).toBe("stall");
			await new Promise((resolve) => setTimeout(resolve, 120));

			const lines = readFileSync(state.logPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(lines).toHaveLength(2);
			expect(lines[0]).toMatchObject({
				event: "stall_recovered_after_freeze",
				recovered_via: "grace",
			});
			expect(lines[1]).toMatchObject({
				event: "bridge_event_loop_stall",
				attribution: "unknown",
			});
			expect(lines[1].tick_gap_ms).toBeLessThan(200);
		} finally {
			await state.worker.terminate();
			rmSync(state.dir, { recursive: true, force: true });
		}
	});

	it("S3 without heartbeat progress emits one terminal stall after grace", async () => {
		const state = stateMachineWorker({
			lastBeat: Date.now() - 10_000,
			forceTickGap: 300,
			grace: 80,
		});
		let stalls = 0;
		state.worker.on("message", (message) => {
			if (message === "stall") stalls += 1;
		});
		try {
			expect(await waitForWorkerMessage(state.worker)).toBe("stall");
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(stalls).toBe(1);
			const line = JSON.parse(readFileSync(state.logPath, "utf8").trim());
			expect(line.stall_age_final_ms).toBeGreaterThan(
				line.stall_age_at_detect_ms,
			);
		} finally {
			await state.worker.terminate();
			rmSync(state.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"production kill: a real spawnSync stall is SIGKILLed with child attribution",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "fly307-wd-"));
			try {
				const psAvailable =
					spawnSync("/bin/ps", ["-axo", "pid=,ppid=,etime=,comm="], {
						stdio: "ignore",
					}).status === 0;
				const srcPath = join(dir, "worker-source.js");
				writeFileSync(srcPath, LOOP_GUARD_WORKER_SOURCE);
				const logPath = join(dir, "loop-guard.log");

				const harnessPath = join(dir, "harness.mjs");
				writeFileSync(
					harnessPath,
					`
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const source = readFileSync(process.argv[2], "utf8");
const sab = new SharedArrayBuffer(8);
const view = new BigInt64Array(sab);
Atomics.store(view, 0, BigInt(Date.now()));
new Worker(source, {
  eval: true,
  workerData: { sab, stallThresholdMs: 200, checkIntervalMs: 25, logPath: process.argv[3], testMode: false, pid: process.pid, bootTs: Date.now(), syncOpMarkerPath: "" },
});
setInterval(() => Atomics.store(view, 0, BigInt(Date.now())), 20);
setTimeout(() => spawnSync("/bin/sleep", ["0.6"]), 150);
`,
				);

				const child = spawn(process.execPath, [harnessPath, srcPath, logPath]);
				const result = await new Promise<{
					code: number | null;
					signal: NodeJS.Signals | null;
				}>((resolve) => {
					child.on("exit", (code, signal) => resolve({ code, signal }));
				});

				expect(result.signal).toBe("SIGKILL");
				expect(result.code).toBeNull();
				const forensic = JSON.parse(readFileSync(logPath, "utf8").trim());
				expect(forensic.tick_gap_ms).toBeLessThan(200);
				if (psAvailable) {
					expect(forensic.children).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ comm: "sleep" }),
						]),
					);
					expect(forensic.attribution).toBe("child");
				} else {
					expect(forensic.children).toBeNull();
					expect(forensic.attribution).toBe("unknown");
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		15_000,
	);

	it.skipIf(process.platform === "win32")(
		"production freeze: SIGSTOP/SIGCONT survives and records recovery",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "fly2058-freeze-"));
			try {
				const srcPath = join(dir, "worker-source.js");
				const logPath = join(dir, "loop-guard.log");
				const harnessPath = join(dir, "harness.mjs");
				writeFileSync(srcPath, LOOP_GUARD_WORKER_SOURCE);
				writeFileSync(
					harnessPath,
					`
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
const source = readFileSync(process.argv[2], "utf8");
const sab = new SharedArrayBuffer(8);
const view = new BigInt64Array(sab);
Atomics.store(view, 0, BigInt(Date.now()));
new Worker(source, {
  eval: true,
  workerData: { sab, stallThresholdMs: 400, checkIntervalMs: 25, graceMs: 200, logPath: process.argv[3], testMode: false, pid: process.pid, bootTs: Date.now(), syncOpMarkerPath: "" },
});
setInterval(() => Atomics.store(view, 0, BigInt(Date.now())), 20);
setTimeout(() => process.stdout.write("READY\\n"), 200);
setTimeout(() => process.exit(0), 1500);
`,
				);
				const child = spawn(process.execPath, [harnessPath, srcPath, logPath], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				await new Promise<void>((resolve, reject) => {
					child.once("error", reject);
					child.stdout?.once("data", () => resolve());
				});
				child.kill("SIGSTOP");
				await new Promise((resolve) => setTimeout(resolve, 650));
				child.kill("SIGCONT");
				const result = await new Promise<{
					code: number | null;
					signal: NodeJS.Signals | null;
				}>((resolve) => {
					child.on("exit", (code, signal) => resolve({ code, signal }));
				});
				expect(result).toEqual({ code: 0, signal: null });
				const records = readFileSync(logPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(records).toEqual([
					expect.objectContaining({
						event: "stall_recovered_after_freeze",
						recovered_via: expect.stringMatching(/^(immediate|grace)$/),
					}),
				]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		15_000,
	);
});
