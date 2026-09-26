/**
 * FLY-696 M1/C5 — interprocess lock via atomic `mkdir`.
 *
 * The switch executor (Node) and `flywheel-claude-profile use/next` (bash) both
 * mutate the same machine credential source + `~/.flywheel/claude-accounts.json`,
 * so they must take the SAME lock (Codex R2/R3). Node has no native `flock(2)`;
 * `mkdir` is atomic in both Node and the shell, so a mkdir-based lock is the
 * portable, cross-language primitive both sides can share (bash: `mkdir "$lock"`
 * / `rmdir "$lock"`).
 *
 * A holder marker (pid + timestamp) enables breaking a lock left behind by a
 * crashed holder: stale = marker older than `staleMs`, or its pid is dead.
 */

import {
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface MkdirLockOpts {
	/** Max time to wait to acquire before throwing (default 30s). */
	timeoutMs?: number;
	/** Backoff between acquire attempts (default 50ms). */
	retryMs?: number;
	/** A held lock older than this (or with a dead holder) is broken (default 120s). */
	staleMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

const HOLDER = "holder";

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if a process with `pid` exists (EPERM counts as alive — exists, not ours). */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isStale(
	lockPath: string,
	now: () => number,
	staleMs: number,
): boolean {
	let marker: { pid?: number; at?: number };
	try {
		marker = JSON.parse(readFileSync(join(lockPath, HOLDER), "utf-8"));
	} catch {
		// No / corrupt marker → fall back to the lock dir's own age.
		try {
			return now() - statSync(lockPath).mtimeMs > staleMs;
		} catch {
			return true; // dir vanished → free
		}
	}
	if (typeof marker.at === "number" && now() - marker.at > staleMs) return true;
	if (typeof marker.pid === "number" && !isProcessAlive(marker.pid))
		return true;
	return false;
}

/**
 * Acquire the lock, run `fn`, release (even if `fn` throws). Throws if the lock
 * cannot be acquired within `timeoutMs`.
 */
export async function withMkdirLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
	opts: MkdirLockOpts = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const retryMs = opts.retryMs ?? 50;
	const staleMs = opts.staleMs ?? 120_000;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? defaultSleep;

	const deadline = now() + timeoutMs;
	for (;;) {
		try {
			mkdirSync(lockPath);
			writeFileSync(
				join(lockPath, HOLDER),
				JSON.stringify({ pid: process.pid, at: now() }),
			);
			break; // acquired
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (isStale(lockPath, now, staleMs)) {
				try {
					rmSync(lockPath, { recursive: true, force: true });
				} catch {
					// another waiter may have broken it first — just retry
				}
				continue;
			}
			if (now() >= deadline) {
				throw new Error(`withMkdirLock: timeout acquiring ${lockPath}`);
			}
			await sleep(retryMs);
		}
	}

	try {
		return await fn();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}
