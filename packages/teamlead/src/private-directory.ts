/**
 * FLY-2830 — the parent of a small owner-only state file.
 *
 * `mkdirSync(..., { recursive: true })` accepts an existing symlink to a
 * directory, and `chmodSync` then follows it. This opens the directory itself
 * without following a link (O_NOFOLLOW + O_DIRECTORY), checks it is ours and
 * tightens it through the descriptor. Anything else fails closed: the caller
 * does not write.
 */

import {
	closeSync,
	fchmodSync,
	constants as fsConstants,
	fstatSync,
	mkdirSync,
	openSync,
} from "node:fs";

export function preparePrivateDirectory(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let fd: number;
	try {
		fd = openSync(
			dir,
			fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
		);
	} catch {
		throw new Error("private_directory_unsafe");
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isDirectory()) throw new Error("private_directory_unsafe");
		const uid = typeof process.getuid === "function" ? process.getuid() : null;
		if (uid !== null && stat.uid !== uid)
			throw new Error("private_directory_foreign_owner");
		fchmodSync(fd, 0o700);
	} finally {
		closeSync(fd);
	}
}
