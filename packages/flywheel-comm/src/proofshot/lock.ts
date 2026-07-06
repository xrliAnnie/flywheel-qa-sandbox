/**
 * GEO-151 ProofShot — atomic mkdir lock + stale cleanup.
 *
 * Why mkdir lock and not `flock`? `flock(1)` is not in macOS by default
 * (Annie's prod platform). `fs.mkdirSync` is atomic on POSIX + cross-platform.
 * If the directory already exists, mkdir throws EEXIST → we own no lock.
 *
 * Stale cleanup: each lock dir contains a `pid` file. On EEXIST we check if
 * the recorded PID is still alive; if not (process died mid-capture), we
 * remove the stale lock and retry. Window is short (one EEXIST round) so
 * we don't loop forever.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Default lock directory shared across captures on the same machine. */
export const DEFAULT_PROOFSHOT_LOCK_DIR = "/tmp/flywheel-proofshot-port.lockd";

export interface AcquiredLock {
	/** Path of the lock directory (call `release()` when done). */
	path: string;
	/** Release the lock — removes the directory + pidfile. Idempotent. */
	release(): void;
}

/**
 * Try to acquire the lock once. Returns the lock handle on success.
 * Throws `Error("ELOCKED")` if the lock is held by a still-live process.
 *
 * The intended call pattern is:
 *   try { lock = acquireProofShotLock(); } catch (e) {
 *     if (e.message === "ELOCKED") { wait + retry; }
 *     else throw e;
 *   }
 * The wrapper provides `acquireProofShotLockWithRetry` for that.
 */
export function acquireProofShotLock(
	lockDir: string = DEFAULT_PROOFSHOT_LOCK_DIR,
): AcquiredLock {
	tryAcquire(lockDir);
	const pidFile = join(lockDir, "pid");
	writeFileSync(pidFile, String(process.pid));
	return {
		path: lockDir,
		release() {
			try {
				rmSync(lockDir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		},
	};
}

function tryAcquire(lockDir: string): void {
	try {
		mkdirSync(lockDir);
		return;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EEXIST") throw err;
	}
	// EEXIST — check if stale.
	const stale = isStaleLock(lockDir);
	if (!stale) {
		throw new Error("ELOCKED");
	}
	// Try once to remove + reacquire. If somebody else also raced and
	// re-acquired in the window, we'll see EEXIST again and throw ELOCKED.
	try {
		rmSync(lockDir, { recursive: true, force: true });
	} catch {
		// continue — mkdir below will throw a clearer error if the rm failed
	}
	try {
		mkdirSync(lockDir);
		return;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EEXIST") {
			throw new Error("ELOCKED"); // somebody beat us to it
		}
		throw err;
	}
}

/** Check if the lock is stale by reading pidfile + checking process liveness. */
export function isStaleLock(lockDir: string): boolean {
	const pidFile = join(lockDir, "pid");
	if (!existsSync(pidFile)) {
		// Lock dir without pidfile — older incomplete state or hand-created.
		// Treat as stale so we can recover.
		return true;
	}
	try {
		const raw = readFileSync(pidFile, "utf-8").trim();
		const pid = Number.parseInt(raw, 10);
		if (!Number.isFinite(pid) || pid <= 0) return true;
		// `process.kill(pid, 0)` — signal 0 just probes if the pid exists.
		// Throws ESRCH on dead process, EPERM if you can't signal it (but
		// that means it IS alive). So only ESRCH = stale.
		try {
			process.kill(pid, 0);
			return false; // live process
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			return code === "ESRCH";
		}
	} catch {
		return true; // unreadable pidfile = stale
	}
}

/**
 * Acquire with bounded retries. Each retry waits `retryMs` then re-checks.
 * Throws `Error("ELOCK_TIMEOUT")` if we exhaust `maxRetries` attempts.
 *
 * Default: 5 retries × 200ms = 1s window. Captures should not contend often
 * (one ProofShot at a time per machine is the design intent).
 */
export async function acquireProofShotLockWithRetry(
	lockDir: string = DEFAULT_PROOFSHOT_LOCK_DIR,
	maxRetries = 5,
	retryMs = 200,
): Promise<AcquiredLock> {
	for (let i = 0; i <= maxRetries; i++) {
		try {
			return acquireProofShotLock(lockDir);
		} catch (err) {
			if ((err as Error).message !== "ELOCKED") throw err;
			if (i === maxRetries) {
				throw new Error("ELOCK_TIMEOUT");
			}
			await sleep(retryMs);
		}
	}
	// unreachable
	throw new Error("ELOCK_TIMEOUT");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
