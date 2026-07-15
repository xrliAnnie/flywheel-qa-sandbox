import { execFileSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { sendQuotaMonitorAlert } from "./quota-monitor-alert.js";
import {
	loadQuotaMonitorConfig,
	type QuotaMonitorConfig,
} from "./quota-monitor-config.js";
import { makeQuotaMonitorRuntime } from "./quota-monitor-runtime.js";
import type { QuotaMonitorState } from "./quota-monitor-state.js";

interface PidfileRecord {
	pid: number;
	uid: number;
	processStartTime: string;
}

export interface SingletonPidfileDeps {
	pid?: number;
	uid?: number;
	processStartTime?: string;
	isProcessAlive?: (pid: number) => boolean;
	readProcessStartTime?: (pid: number) => string | null;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function processStartTime(pid: number): string | null {
	try {
		const stdout = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2_000,
		});
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

function parsePidfile(raw: string): PidfileRecord | null {
	try {
		const value = JSON.parse(raw) as Partial<PidfileRecord>;
		if (
			!Number.isInteger(value.pid) ||
			(value.pid as number) <= 0 ||
			!Number.isInteger(value.uid) ||
			(value.uid as number) < 0 ||
			typeof value.processStartTime !== "string" ||
			value.processStartTime.length === 0
		) {
			return null;
		}
		return value as PidfileRecord;
	} catch {
		return null;
	}
}

function safeOwnedRegularFile(path: string, uid: number): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid;
	} catch {
		return false;
	}
}

/** Atomically claim a pidfile and refuse ambiguous existing ownership. */
export function acquireSingletonPidfile(
	path: string,
	deps: SingletonPidfileDeps = {},
): { release: () => void } {
	const pid = deps.pid ?? process.pid;
	const uid = deps.uid ?? process.getuid?.() ?? -1;
	const readStart = deps.readProcessStartTime ?? processStartTime;
	const start = deps.processStartTime ?? readStart(pid);
	const isAlive = deps.isProcessAlive ?? processAlive;
	if (uid < 0 || !start) throw new Error("unsafe pidfile owner identity");
	const record: PidfileRecord = { pid, uid, processStartTime: start };
	mkdirSync(dirname(path), { recursive: true });

	for (let attempt = 0; attempt < 2; attempt++) {
		let fd: number;
		try {
			fd = openSync(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!safeOwnedRegularFile(path, uid)) {
				throw new Error(
					"unsafe existing pidfile (not a regular same-owner file)",
				);
			}
			const existing = parsePidfile(readFileSync(path, "utf8"));
			if (existing === null || existing.uid !== uid) {
				throw new Error("unsafe existing pidfile record");
			}
			if (isAlive(existing.pid)) {
				const liveStart = readStart(existing.pid);
				if (liveStart === existing.processStartTime) {
					throw new Error(
						`quota monitor already running (pid ${existing.pid})`,
					);
				}
				throw new Error("unsafe pidfile: live PID start time does not match");
			}
			unlinkSync(path);
			continue;
		}
		try {
			writeSync(fd, `${JSON.stringify(record)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return {
			release(): void {
				if (!safeOwnedRegularFile(path, uid)) return;
				let current: PidfileRecord | null = null;
				try {
					current = parsePidfile(readFileSync(path, "utf8"));
				} catch {
					return;
				}
				if (
					current?.pid === record.pid &&
					current.uid === record.uid &&
					current.processStartTime === record.processStartTime
				) {
					unlinkSync(path);
				}
			},
		};
	}
	throw new Error("unable to acquire quota monitor pidfile");
}

export function computeNextDelay(
	state: QuotaMonitorState,
	config: QuotaMonitorConfig,
	nowMs: number,
): number {
	const interval =
		(state.tier === "accelerated"
			? config.acceleratedPollMinutes
			: config.basePollMinutes) * 60_000;
	return Math.max(interval, Math.max(0, state.backoffUntilMs - nowMs));
}

export interface QuotaMonitorLoopOptions {
	isStopping: () => boolean;
	loadContext: () => Promise<{
		config: QuotaMonitorConfig;
		state: QuotaMonitorState;
	}>;
	poll: (context: {
		config: QuotaMonitorConfig;
		state: QuotaMonitorState;
	}) => Promise<QuotaMonitorState>;
	now?: () => number;
	wait?: (delayMs: number) => Promise<void>;
}

function defaultWait(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Sequential setTimeout-style loop: no overlapping polls, context reloaded per tick. */
export async function runQuotaMonitorLoop(
	opts: QuotaMonitorLoopOptions,
): Promise<void> {
	const now = opts.now ?? Date.now;
	const wait = opts.wait ?? defaultWait;
	while (!opts.isStopping()) {
		const context = await opts.loadContext();
		const state = await opts.poll(context);
		if (opts.isStopping()) break;
		await wait(computeNextDelay(state, context.config, now()));
	}
}

function structuredLog(level: "info" | "error", message: string): void {
	process.stderr.write(
		`${JSON.stringify({
			ts: new Date().toISOString(),
			component: "flywheel-quota-monitor",
			level,
			message,
		})}\n`,
	);
}

function defaultPidfilePath(): string {
	return (
		process.env.FLYWHEEL_QUOTA_PIDFILE ??
		join(homedir(), ".flywheel", "quota-monitor.pid")
	);
}

function gracefulMarkerPath(): string {
	return (
		process.env.FLYWHEEL_QUOTA_RUN_MARKER ??
		join(homedir(), ".flywheel", "quota-monitor.running")
	);
}

function removeOwnRegularFile(path: string): void {
	if (!existsSync(path)) return;
	try {
		const stat = lstatSync(path);
		const uid = process.getuid?.();
		if (
			stat.isFile() &&
			!stat.isSymbolicLink() &&
			(uid === undefined || stat.uid === uid)
		) {
			unlinkSync(path);
		}
	} catch {
		// Best effort during graceful shutdown; wrapper handles stale markers.
	}
}

export function cleanupRunMarker(path: string, graceful: boolean): void {
	if (graceful) removeOwnRegularFile(path);
}

/** Production daemon entry. Signals interrupt the current timer, never a poll. */
export async function main(): Promise<void> {
	const singleton = acquireSingletonPidfile(defaultPidfilePath());
	const runtime = makeQuotaMonitorRuntime({
		alert: (alert) => sendQuotaMonitorAlert(alert).then(() => undefined),
		log: (message) => structuredLog("info", message),
	});
	let stopping = false;
	let gracefulShutdown = false;
	let wakeWaiter: (() => void) | null = null;
	const stop = () => {
		stopping = true;
		gracefulShutdown = true;
		wakeWaiter?.();
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);

	try {
		while (!stopping) {
			const polled = await runtime.tick();
			if (stopping) break;
			const config = loadQuotaMonitorConfig().config;
			const delay = computeNextDelay(polled.state, config, Date.now());
			await new Promise<void>((resolve) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					wakeWaiter = null;
					resolve();
				};
				const timer = setTimeout(finish, delay);
				wakeWaiter = finish;
			});
		}
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		cleanupRunMarker(gracefulMarkerPath(), gracefulShutdown);
		singleton.release();
	}
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
	main().catch((error) => {
		structuredLog(
			"error",
			`fatal=${error instanceof Error ? error.name : "unknown"}`,
		);
		process.exitCode = 1;
	});
}
