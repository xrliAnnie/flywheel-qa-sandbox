import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type MkdirLockOpts, withMkdirLock } from "./mkdir-lock.js";

export function canonicalModelAuthorityPath(path: string): string {
	const absolute = resolve(path);
	let parent: string;
	try {
		parent = realpathSync(dirname(absolute));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(
				`model authority parent directory is missing: ${dirname(absolute)}; create the directory with mode 0700 or choose an existing --config parent`,
			);
		throw error;
	}
	const canonical = join(parent, basename(absolute));
	try {
		if (lstatSync(canonical).isSymbolicLink())
			throw new Error(`model authority must not be a symlink: ${canonical}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return canonical;
}

/** Both authority writers share identity, liveness recovery and exact-holder release. */
export async function withModelAuthorityLock<T>(
	path: string,
	fn: (canonicalPath: string) => Promise<T>,
	options: Pick<MkdirLockOpts, "timeoutMs"> = {},
): Promise<T> {
	const canonical = canonicalModelAuthorityPath(path);
	const lockPath = `${canonical}.lock`;
	try {
		return await withMkdirLock(lockPath, () => fn(canonical), {
			timeoutMs: options.timeoutMs ?? 30000,
			retryMs: 50,
			staleMs: 120000,
			bare: false,
		});
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === `withMkdirLock: timeout acquiring ${lockPath}`
		) {
			throw new Error(
				`model authority lock acquisition budget exhausted at ${lockPath}; no update was applied. Retry after the holder finishes; dead PID holders are recovered automatically, empty orphan directories after 120s. Inspect holder.* PID markers; never remove a live owner's lock.`,
			);
		}
		throw error;
	}
}
