import type { Stats } from "node:fs";
import {
	appendFileSync,
	lstatSync,
	mkdirSync,
	renameSync,
	rmdirSync,
	rmSync,
} from "node:fs";
import { dirname as pathDirname } from "node:path";

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_RETENTION = 3;
export const DEFAULT_LOG_LOCK_STALE_MS = 5 * 60 * 1000;

export interface RotateLogOptions {
	maxBytes?: number;
	keep?: number;
	lockStaleMs?: number;
}

function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function restoreQuarantinedLockIfUnclaimed(
	quarantine: string,
	lock: string,
): boolean {
	try {
		lstatSync(lock);
		return false;
	} catch (error) {
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			error.code !== "ENOENT"
		) {
			return false;
		}
	}
	try {
		renameSync(quarantine, lock);
		return true;
	} catch {
		return false;
	}
}

function acquireRotationLock(lock: string, staleMs: number): boolean {
	try {
		mkdirSync(lock);
		return true;
	} catch {
		// Contention is fail-open, but a process crash must not leave rotation
		// disabled forever. Rotation is a synchronous, millisecond-scale section;
		// only an aged directory is eligible for quarantine and replacement.
	}

	let lockStats: Stats;
	try {
		lockStats = lstatSync(lock);
		if (
			!lockStats.isDirectory() ||
			lockStats.isSymbolicLink() ||
			Date.now() - lockStats.mtimeMs < staleMs
		) {
			return false;
		}
	} catch {
		return false;
	}

	const quarantine = `${lock}.stale.${process.pid}.${Date.now()}`;
	let moved = false;
	try {
		renameSync(lock, quarantine);
		moved = true;
		const movedStats = lstatSync(quarantine);
		if (
			movedStats.dev !== lockStats.dev ||
			movedStats.ino !== lockStats.ino ||
			movedStats.mtimeMs !== lockStats.mtimeMs
		) {
			// A new owner replaced the stale directory between inspection and
			// rename. Restore its exact inode and abandon recovery.
			if (restoreQuarantinedLockIfUnclaimed(quarantine, lock)) {
				moved = false;
			}
			return false;
		}
		mkdirSync(lock);
		rmSync(quarantine, { recursive: true, force: true });
		return true;
	} catch {
		if (moved) {
			restoreQuarantinedLockIfUnclaimed(quarantine, lock);
		}
		return false;
	}
}

/**
 * Rename a per-append log when it reaches its cap.
 *
 * Rotation is deliberately fail-open: lock contention, stale paths, and I/O
 * errors all leave the active file alone. The append remains the caller's
 * authority and retains its existing error semantics.
 */
export function rotateLogIfNeeded(
	path: string,
	options: RotateLogOptions = {},
): boolean {
	const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
	const keep = options.keep ?? DEFAULT_LOG_RETENTION;
	const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOG_LOCK_STALE_MS;
	if (
		!positiveInteger(maxBytes) ||
		!positiveInteger(keep) ||
		!positiveInteger(lockStaleMs)
	) {
		return false;
	}

	let initial: Stats;
	try {
		initial = lstatSync(path);
		if (
			!initial.isFile() ||
			initial.isSymbolicLink() ||
			initial.size < maxBytes
		) {
			return false;
		}
	} catch {
		return false;
	}

	const lock = `${path}.rotate.lock`;
	if (!acquireRotationLock(lock, lockStaleMs)) return false;

	try {
		const current = lstatSync(path);
		if (
			!current.isFile() ||
			current.isSymbolicLink() ||
			current.size < maxBytes
		) {
			return false;
		}
		rmSync(`${path}.${keep}`, { force: true });
		for (let generation = keep; generation >= 2; generation -= 1) {
			try {
				renameSync(`${path}.${generation - 1}`, `${path}.${generation}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			}
		}
		renameSync(path, `${path}.1`);
		return true;
	} catch {
		return false;
	} finally {
		try {
			rmdirSync(lock);
		} catch {
			// A stale lock only suppresses later rotations; appends remain available.
		}
	}
}

export function appendRotatedLogSync(
	path: string,
	data: string | Uint8Array,
	options: RotateLogOptions = {},
): void {
	mkdirSync(pathDirname(path), { recursive: true });
	rotateLogIfNeeded(path, options);
	appendFileSync(path, data, { mode: 0o600 });
}
