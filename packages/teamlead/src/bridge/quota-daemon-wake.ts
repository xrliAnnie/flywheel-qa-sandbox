import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	parsePidfile,
	processStartTime,
	safeOwnedRegularFile,
} from "../account-heal/pidfile.js";
import type { AlertMetadata } from "../LeadAlertNotifier.js";

export type QuotaDaemonWakeOutcome =
	| "signaled"
	| "throttled"
	| "unsupported"
	| "unsafe_pidfile"
	| "identity_mismatch"
	| "signal_failed";

export interface QuotaDaemonWakeDeps {
	pidfilePath?: string;
	uid?: number;
	readProcessStartTime?: (pid: number) => string | null;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	now?: () => number;
	warn?: (message: string) => void;
}

export function shouldWakeQuotaDaemon(payload: {
	eventType: string;
	metadata?: Pick<AlertMetadata, "accountLimit"> | { accountLimit?: unknown };
}): boolean {
	return (
		payload.eventType === "usage_limit" ||
		payload.metadata?.accountLimit != null
	);
}

/** Capability-gated, identity-checked and throttled daemon wake sender. */
export function createQuotaDaemonWaker(
	deps: QuotaDaemonWakeDeps = {},
): () => QuotaDaemonWakeOutcome {
	const pidfilePath =
		deps.pidfilePath ??
		process.env.FLYWHEEL_QUOTA_PIDFILE ??
		join(homedir(), ".flywheel", "quota-monitor.pid");
	const uid = deps.uid ?? process.getuid?.() ?? -1;
	const readStart = deps.readProcessStartTime ?? processStartTime;
	const kill = deps.kill ?? ((pid, signal) => void process.kill(pid, signal));
	const now = deps.now ?? Date.now;
	const warn = deps.warn ?? ((message) => console.warn(message));
	let lastWakeAt: number | null = null;

	return () => {
		const current = now();
		if (lastWakeAt !== null && current - lastWakeAt < 60_000) {
			return "throttled";
		}
		try {
			if (uid < 0 || !safeOwnedRegularFile(pidfilePath, uid)) {
				return "unsafe_pidfile";
			}
			const record = parsePidfile(readFileSync(pidfilePath, "utf8"));
			if (record === null || record.uid !== uid) return "unsafe_pidfile";
			if ((record.wakeProtocol ?? 0) < 1) return "unsupported";
			if (readStart(record.pid) !== record.processStartTime) {
				return "identity_mismatch";
			}
			kill(record.pid, "SIGUSR1");
			lastWakeAt = current;
			return "signaled";
		} catch (error) {
			warn(
				`[quota-daemon-wake] signal failed: ${error instanceof Error ? error.name : "unknown"}`,
			);
			return "signal_failed";
		}
	};
}

export const wakeQuotaDaemon = createQuotaDaemonWaker();
