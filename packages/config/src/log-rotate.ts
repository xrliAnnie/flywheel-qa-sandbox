import type { Stats } from "node:fs";
import {
	appendFileSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname as pathDirname } from "node:path";

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_RETENTION = 3;
export const DEFAULT_LOG_LOCK_STALE_MS = 5 * 60 * 1000;

export interface RotateLogOptions {
	maxBytes?: number;
	keep?: number;
	lockStaleMs?: number;
	/** Move unsafe generation entries aside instead of letting them block rotation. */
	quarantineUnsafeGenerations?: boolean;
}

export interface AppendRotatedLogOptions extends RotateLogOptions {
	/** Use no-follow appends and quarantine unsafe generation entries. */
	strict?: boolean;
	/** Keep appending without attempting another rotation after a known stall. */
	rotationEnabled?: boolean;
}

export interface AppendRotatedLogResult {
	sizeBefore: number;
	rotationDue: boolean;
	rotated: boolean;
	rotationStalled: boolean;
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
			(!lockStats.isDirectory() && !lockStats.isFile()) ||
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

function quarantineUnsafeGeneration(path: string): boolean {
	let stats: Stats;
	try {
		stats = lstatSync(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	if (stats.isFile() && !stats.isSymbolicLink()) return true;

	let timestamp = Date.now();
	let quarantine = `${path}.corrupt.${process.pid}.${timestamp}`;
	while (true) {
		try {
			lstatSync(quarantine);
			timestamp += 1;
			quarantine = `${path}.corrupt.${process.pid}.${timestamp}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			return false;
		}
	}

	try {
		renameSync(path, quarantine);
		return true;
	} catch {
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
		if (options.quarantineUnsafeGenerations) {
			for (let generation = 1; generation <= keep; generation += 1) {
				if (!quarantineUnsafeGeneration(`${path}.${generation}`)) return false;
			}
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

function regularFileOrMissing(path: string, label: string): Stats | undefined {
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink()) {
			throw new Error(`${label}_unsafe`);
		}
		return stats;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function appendNoFollowSync(path: string, data: string | Uint8Array): void {
	const flags =
		constants.O_APPEND |
		constants.O_CREAT |
		constants.O_WRONLY |
		constants.O_NOFOLLOW;
	const fd = openSync(path, flags, 0o600);
	try {
		if (!fstatSync(fd).isFile()) throw new Error("active_log_unsafe");
		const bytes =
			typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(fd, bytes, offset, bytes.length - offset);
			if (written <= 0) throw new Error("log_append_incomplete");
			offset += written;
		}
	} finally {
		closeSync(fd);
	}
}

export function appendRotatedLogSync(
	path: string,
	data: string | Uint8Array,
	options: AppendRotatedLogOptions = {},
): AppendRotatedLogResult {
	mkdirSync(pathDirname(path), { recursive: true });
	const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
	const keep = options.keep ?? DEFAULT_LOG_RETENTION;
	const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOG_LOCK_STALE_MS;
	if (
		options.strict &&
		(!positiveInteger(maxBytes) ||
			!positiveInteger(keep) ||
			!positiveInteger(lockStaleMs))
	) {
		throw new Error("invalid_log_rotation_options");
	}

	let initial: Stats | undefined;
	if (options.strict) {
		initial = regularFileOrMissing(path, "active_log");
	} else {
		try {
			const stats = lstatSync(path);
			if (stats.isFile() && !stats.isSymbolicLink()) initial = stats;
		} catch {
			// The existing fail-open append contract creates a missing active path.
		}
	}
	const sizeBefore = initial?.size ?? 0;
	const rotationDue = positiveInteger(maxBytes) && sizeBefore >= maxBytes;
	const rotationEnabled = options.rotationEnabled ?? true;
	const rotated = rotationEnabled
		? rotateLogIfNeeded(path, {
				...options,
				quarantineUnsafeGenerations: options.strict,
			})
		: false;
	let rotationStalled = false;
	if (options.strict && rotationDue && !rotated) {
		const current = regularFileOrMissing(path, "active_log");
		const stalledBytes = Math.min(Number.MAX_SAFE_INTEGER, maxBytes * 2);
		if (current && current.size >= stalledBytes) {
			rotationStalled = true;
		}
	}

	if (options.strict) appendNoFollowSync(path, data);
	else appendFileSync(path, data, { mode: 0o600 });
	return { sizeBefore, rotationDue, rotated, rotationStalled };
}
