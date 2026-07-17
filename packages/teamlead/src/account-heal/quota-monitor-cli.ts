import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	acquireSingletonPidfile,
	resolveOwnProcessStartTime,
	type SingletonPidfileDeps,
} from "./pidfile.js";
import { sendQuotaMonitorAlert } from "./quota-monitor-alert.js";
import {
	loadQuotaMonitorConfig,
	type QuotaMonitorConfig,
} from "./quota-monitor-config.js";
import { makeQuotaMonitorRuntime } from "./quota-monitor-runtime.js";
import type { QuotaMonitorState } from "./quota-monitor-state.js";

export type {
	OwnProcessStartTimeDeps,
	PidfileRecord,
	SingletonPidfileDeps,
} from "./pidfile.js";
export {
	acquireSingletonPidfile,
	parsePidfile,
	processStartTime,
	resolveOwnProcessStartTime,
	safeOwnedRegularFile,
} from "./pidfile.js";

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
	let fields: Record<string, unknown> = { message };
	try {
		const parsed = JSON.parse(message) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			fields = parsed as Record<string, unknown>;
		}
	} catch {
		// Plain diagnostic messages remain under `message`.
	}
	process.stderr.write(
		`${JSON.stringify({
			ts: new Date().toISOString(),
			component: "flywheel-quota-monitor",
			level,
			...fields,
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

export interface WakeCapabilityDeps {
	pidfilePath: string;
	handler: () => void;
	on?: (signal: NodeJS.Signals, handler: () => void) => void;
	off?: (signal: NodeJS.Signals, handler: () => void) => void;
	acquire?: (
		path: string,
		deps: SingletonPidfileDeps,
	) => { release: () => void };
}

/** Publish the pidfile capability strictly inside the signal-handler lifetime. */
export function installWakeCapability(deps: WakeCapabilityDeps): () => void {
	const on = deps.on ?? ((signal, handler) => process.on(signal, handler));
	const off =
		deps.off ?? ((signal, handler) => process.removeListener(signal, handler));
	const acquire = deps.acquire ?? acquireSingletonPidfile;
	on("SIGUSR1", deps.handler);
	let singleton: { release: () => void };
	try {
		singleton = acquire(deps.pidfilePath, {
			processStartTime: resolveOwnProcessStartTime(),
			wakeProtocol: 1,
		});
	} catch (error) {
		off("SIGUSR1", deps.handler);
		throw error;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		singleton.release();
		off("SIGUSR1", deps.handler);
	};
}

/** Production daemon entry. Signals interrupt the current timer, never a poll. */
export async function main(): Promise<void> {
	let wakeWaiter: (() => void) | null = null;
	const wake = () => wakeWaiter?.();
	const releaseWakeCapability = installWakeCapability({
		pidfilePath: defaultPidfilePath(),
		handler: wake,
	});
	const runtime = makeQuotaMonitorRuntime({
		alert: (alert) => sendQuotaMonitorAlert(alert),
		log: (message) => structuredLog("info", message),
	});
	let stopping = false;
	let gracefulShutdown = false;
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
		releaseWakeCapability();
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
