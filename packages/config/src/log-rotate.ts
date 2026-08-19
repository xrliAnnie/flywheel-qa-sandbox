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

export interface RotateLogOptions {
	maxBytes?: number;
	keep?: number;
}

function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
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
	if (!positiveInteger(maxBytes) || !positiveInteger(keep)) return false;

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
	try {
		mkdirSync(lock);
	} catch {
		return false;
	}

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
