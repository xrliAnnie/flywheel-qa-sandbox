/**
 * FLY-307 C: Bridge event-loop self-termination guard.
 *
 * The 2026-06-17 outage wedged the Bridge: a sql.js/WASM trap spun the main
 * event loop and pegged CPU. launchd `KeepAlive` only restarts a *crashed*
 * process, not a *hung* one, so it took a manual `kickstart` and a ~10-min
 * Discord blackout to recover.
 *
 * This loop guard converts a hang into a launchd-restartable crash. A same-loop
 * timer cannot do that — if the main loop is dead, its own callbacks never
 * fire. So detection runs in a separate `worker_threads` Worker that observes
 * a heartbeat the main thread writes into a `SharedArrayBuffer`:
 *
 *   main loop  →  setInterval(heartbeatIntervalMs): Atomics.store(view, 0, BigInt(now))
 *   worker     →  setInterval(checkIntervalMs): if now - lastBeat > stallThresholdMs → SIGKILL self
 *
 * A healthy loop (even under heavy CPU — timers fire late by ms/s, never 60s)
 * keeps the heartbeat advancing; a dead loop freezes it. On a confirmed stall
 * the worker writes a forensic line, then `process.kill(process.pid, "SIGKILL")`
 * — a process-level signal that terminates the WHOLE process (a JS signal
 * handler is useless: the loop that would run it is dead; `process.exit()` in a
 * worker stops only the worker).
 *
 * The guard is permanently enabled in production. The VITEST/test auto-disable
 * lives at the `startBridge()` wiring boundary (so the
 * dedicated tests in this package can still exercise the real worker
 * directly), NOT in this class.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { rotateLogIfNeeded } from "flywheel-config";

const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_STALL_THRESHOLD_MS = 60_000;
const DEFAULT_CHECK_MS = 5000;

/** Pure decision: has the main loop been silent longer than the threshold? */
export function isLoopStalled(
	lastBeatMs: number,
	nowMs: number,
	thresholdMs: number,
): boolean {
	return nowMs - lastBeatMs > thresholdMs;
}

/** Data handed to the loop-guard worker. `sab` carries the shared heartbeat. */
export interface LoopGuardWorkerData {
	sab: SharedArrayBuffer;
	stallThresholdMs: number;
	checkIntervalMs: number;
	logPath: string;
	/** Test-only: postMessage("stall") + stop instead of killing the process. */
	testMode: boolean;
	pid: number;
	bootTs: number;
	syncOpMarkerPath: string;
}

/**
 * CommonJS worker source (evaluated via `new Worker(src, { eval: true })`).
 *
 * MUST stay CommonJS: an eval worker runs as CJS even in this `"type":"module"`
 * repo, so it uses `require(...)` and no `import`. Exported so tests reuse the
 * exact production string. Uses only builtins:
 * `node:worker_threads`, `node:fs`, `BigInt64Array`, `Atomics`, `Date`,
 * `process`, `console`, `setInterval`/`clearInterval`.
 */
export const LOOP_GUARD_WORKER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
	const { sab, stallThresholdMs, checkIntervalMs, logPath, testMode, pid, bootTs, syncOpMarkerPath } = workerData;
	const view = new BigInt64Array(sab);
	function readSyncOp(lastBeat, now) {
		if (!syncOpMarkerPath) return undefined;
		let fd;
		try {
			fd = fs.openSync(
				syncOpMarkerPath,
				fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
			);
			const stat = fs.fstatSync(fd);
			if (!stat.isFile() || stat.size <= 0 || stat.size > 4096) return undefined;
			const buffer = Buffer.alloc(stat.size);
			const count = fs.readSync(fd, buffer, 0, stat.size, 0);
			const marker = JSON.parse(buffer.subarray(0, count).toString("utf8"));
			if (
				marker && marker.pid === pid && typeof marker.label === "string" &&
				marker.label.length > 0 && marker.label.length <= 256 &&
				Number.isFinite(marker.startedAt) && marker.startedAt >= lastBeat &&
				marker.startedAt <= now
			) return marker.label;
		} catch (e) {
			return undefined;
		} finally {
			if (fd !== undefined) {
				try { fs.closeSync(fd); } catch (e) { /* best-effort */ }
			}
		}
		return undefined;
	}
	const timer = setInterval(() => {
		const lastBeat = Number(Atomics.load(view, 0));
		const now = Date.now();
		const age = now - lastBeat;
		if (age <= stallThresholdMs) return;
		clearInterval(timer);
		const forensic = {
			event: "bridge_event_loop_stall",
			stall_age_ms: age,
			threshold_ms: stallThresholdMs,
			at: new Date().toISOString(),
			pid,
			bootTs,
		};
		const lastSyncOp = readSyncOp(lastBeat, now);
		if (lastSyncOp) forensic.last_sync_op = lastSyncOp;
		const line = JSON.stringify(forensic) + "\\n";
	if (logPath) {
		try { fs.appendFileSync(logPath, line); } catch (e) { /* best-effort */ }
	}
	try {
		console.error(
			"[BridgeLoopGuard] event loop stalled for " + age +
			"ms (threshold " + stallThresholdMs + "ms) — killing process for KeepAlive restart",
		);
	} catch (e) { /* best-effort */ }
	if (testMode) {
		// Post the stall signal, then self-terminate: close the port so the
		// worker has no live handles left (the interval is already cleared) and
		// exits with code 0. Avoids a leaked worker between tests.
		if (parentPort) {
			parentPort.postMessage("stall");
			parentPort.close();
		}
		return;
	}
	process.kill(process.pid, "SIGKILL");
}, checkIntervalMs);
`;

/** Minimal structural view of a Worker so tests can inject a stub. */
export interface WorkerLike {
	terminate(): unknown;
	unref(): unknown;
	on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface BridgeEventLoopGuardOptions {
	heartbeatIntervalMs?: number;
	stallThresholdMs?: number;
	checkIntervalMs?: number;
	/** Forensic log path; `~` is expanded and the parent dir ensured on start. */
	logPath?: string;
	/** Master enable (default true). The `=0` env kill-switch overrides to off. */
	enabled?: boolean;
	/** Injectable clock (main side) for deterministic tests. */
	now?: () => number;
	/** Injectable Worker factory; defaults to a real eval Worker. */
	createWorker?: (
		source: string,
		options: { eval: true; workerData: LoopGuardWorkerData },
	) => WorkerLike;
	/** Injectable parent-dir ensure (testing); defaults to fs.mkdirSync. */
	ensureDir?: (path: string) => void;
	/** Parent-side rotation seam; never imported into the eval worker string. */
	rotateLog?: (path: string) => boolean;
	bootTs?: number;
	pid?: number;
	syncOpMarkerPath?: string;
	testMode?: boolean;
}

export class BridgeEventLoopGuard {
	private readonly heartbeatIntervalMs: number;
	private readonly stallThresholdMs: number;
	private readonly checkIntervalMs: number;
	private readonly logPath: string;
	private readonly enabledOption: boolean;
	private readonly now: () => number;
	private readonly createWorker: NonNullable<
		BridgeEventLoopGuardOptions["createWorker"]
	>;
	private readonly ensureDir: (path: string) => void;
	private readonly rotateLog: (path: string) => boolean;
	private readonly bootTs: number;
	private readonly pid: number;
	private readonly syncOpMarkerPath: string;
	private readonly testMode: boolean;

	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private worker: WorkerLike | null = null;
	private view: BigInt64Array | null = null;

	constructor(options: BridgeEventLoopGuardOptions = {}) {
		this.heartbeatIntervalMs = numEnv(
			"FLYWHEEL_BRIDGE_LOOP_GUARD_HEARTBEAT_MS",
			options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS,
		);
		this.stallThresholdMs = numEnv(
			"FLYWHEEL_BRIDGE_LOOP_GUARD_STALL_MS",
			options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS,
		);
		this.checkIntervalMs = numEnv(
			"FLYWHEEL_BRIDGE_LOOP_GUARD_CHECK_MS",
			options.checkIntervalMs ?? DEFAULT_CHECK_MS,
		);
		this.logPath = expandHome(
			process.env.FLYWHEEL_BRIDGE_LOOP_GUARD_LOG ??
				options.logPath ??
				"~/.flywheel/bridge-loop-guard.log",
		);
		this.enabledOption = options.enabled ?? true;
		this.now = options.now ?? (() => Date.now());
		this.createWorker =
			options.createWorker ??
			((source, opts) => new Worker(source, opts) as unknown as WorkerLike);
		this.ensureDir =
			options.ensureDir ??
			((path) => {
				mkdirSync(dirname(path), { recursive: true });
			});
		this.rotateLog = options.rotateLog ?? rotateLogIfNeeded;
		this.bootTs = options.bootTs ?? Date.now();
		this.pid = options.pid ?? process.pid;
		this.syncOpMarkerPath = options.syncOpMarkerPath ?? "";
		this.testMode = options.testMode ?? false;
	}

	/** The injected `enabled` option remains a test and embedding seam. */
	isEnabled(): boolean {
		return this.enabledOption;
	}

	start(): void {
		if (!this.isEnabled()) return;
		if (this.heartbeatTimer) return; // already running

		const sab = new SharedArrayBuffer(8);
		this.view = new BigInt64Array(sab);
		// Seed the heartbeat so the worker doesn't read 0 → instant false stall.
		Atomics.store(this.view, 0, BigInt(Math.trunc(this.now())));

		if (this.logPath) {
			try {
				this.ensureDir(this.logPath);
				this.rotateLog(this.logPath);
			} catch {
				// best-effort; the worker's appendFileSync is itself guarded.
			}
		}

		this.heartbeatTimer = setInterval(() => {
			if (this.view) {
				Atomics.store(this.view, 0, BigInt(Math.trunc(this.now())));
			}
		}, this.heartbeatIntervalMs);
		// Don't let the loop guard keep the process alive on its own.
		this.heartbeatTimer.unref?.();

		this.worker = this.createWorker(LOOP_GUARD_WORKER_SOURCE, {
			eval: true,
			workerData: {
				sab,
				stallThresholdMs: this.stallThresholdMs,
				checkIntervalMs: this.checkIntervalMs,
				logPath: this.logPath,
				testMode: this.testMode,
				pid: this.pid,
				bootTs: this.bootTs,
				syncOpMarkerPath: this.syncOpMarkerPath,
			},
		});
		this.worker.unref();
		this.worker.on("error", (err: unknown) => {
			console.error("[BridgeLoopGuard] worker error:", err);
		});
	}

	stop(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		this.view = null;
	}

	/** @internal test helper — current heartbeat value, or null when stopped. */
	_peekHeartbeat(): number | null {
		return this.view ? Number(Atomics.load(this.view, 0)) : null;
	}
}

function numEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function expandHome(p: string): string {
	if (p === "~" || p.startsWith("~/")) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		return home + p.slice(1);
	}
	return p;
}
