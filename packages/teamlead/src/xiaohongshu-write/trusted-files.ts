import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	type Stats,
} from "node:fs";
import { dirname, isAbsolute, normalize, relative, sep } from "node:path";

const deny = (): never => {
	throw Error("trusted_file_unavailable");
};
function pathCheck(path: string) {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0"))
		deny();
}
function same(a: Stats, b: Stats) {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.mode === b.mode &&
		a.uid === b.uid &&
		a.gid === b.gid &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs
	);
}
function boundedRead(
	path: string,
	maxBytes: number,
	valid: (stat: Stats) => boolean,
): Buffer {
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > 256 * 1024 * 1024
	)
		deny();
	const before = lstatSync(path);
	if (
		!before.isFile() ||
		before.nlink !== 1 ||
		before.size < 1 ||
		before.size > maxBytes ||
		!valid(before)
	)
		deny();
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		if (!same(before, fstatSync(fd))) deny();
		const bytes = Buffer.alloc(before.size + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (!count) break;
			offset += count;
		}
		if (
			offset !== before.size ||
			!same(before, fstatSync(fd)) ||
			!same(before, lstatSync(path))
		)
			deny();
		return bytes.subarray(0, offset);
	} finally {
		closeSync(fd);
	}
}
/** Every ancestor is immutable to the service and model UIDs. */
export function readImmutableFile(
	path: string,
	options: {
		sha256?: string;
		maxBytes: number;
		executable?: boolean;
		mode?: 0o600;
	},
): Buffer {
	try {
		pathCheck(path);
		for (let parent = dirname(path); ; parent = dirname(parent)) {
			const stat = lstatSync(parent);
			if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
				deny();
			if (parent === dirname(parent)) break;
		}
		const bytes = boundedRead(
			path,
			options.maxBytes,
			(stat) =>
				stat.uid === 0 &&
				(stat.mode & 0o022) === 0 &&
				(options.mode === undefined || (stat.mode & 0o7777) === options.mode) &&
				(!options.executable || (stat.mode & 0o111) !== 0),
		);
		if (
			options.sha256 !== undefined &&
			(!/^[a-f0-9]{64}$/.test(options.sha256) ||
				createHash("sha256").update(bytes).digest("hex") !== options.sha256)
		)
			deny();
		return bytes;
	} catch {
		return deny();
	}
}
/** The startup loader must establish root's trusted ancestry first. This checks
 * root and every descendant directory, and never reads outside that root. */
export function readPrivateFile(
	path: string,
	options: { root: string; uid: number; maxBytes: number },
): Buffer {
	try {
		pathCheck(path);
		pathCheck(options.root);
		if (!Number.isSafeInteger(options.uid) || options.uid <= 0) deny();
		const child = relative(options.root, path);
		if (
			!child ||
			child === ".." ||
			child.startsWith(`..${sep}`) ||
			isAbsolute(child)
		)
			deny();
		const directories: Array<{ path: string; stat: Stats }> = [];
		for (let parent = dirname(path); ; parent = dirname(parent)) {
			const stat = lstatSync(parent);
			if (
				!stat.isDirectory() ||
				stat.uid !== options.uid ||
				(stat.mode & 0o7777) !== 0o700
			)
				deny();
			directories.push({ path: parent, stat });
			if (parent === options.root) break;
		}
		const bytes = boundedRead(
			path,
			options.maxBytes,
			(stat) => stat.uid === options.uid && (stat.mode & 0o7777) === 0o600,
		);
		if (directories.some((entry) => !same(entry.stat, lstatSync(entry.path))))
			deny();
		return bytes;
	} catch {
		return deny();
	}
}

/** A signed QA receipt is root-owned but may live beneath the service's private
 * state directory. This does not relax executable or policy ancestry checks. */
export function readRootReceipt(
	path: string,
	options: { serviceUid: number; maxBytes: number },
): Buffer {
	try {
		pathCheck(path);
		if (!Number.isSafeInteger(options.serviceUid) || options.serviceUid <= 0)
			deny();
		const ancestors: Array<{ path: string; stat: Stats }> = [];
		for (let parent = dirname(path); ; parent = dirname(parent)) {
			const stat = lstatSync(parent);
			if (
				!stat.isDirectory() ||
				(stat.uid !== 0 && stat.uid !== options.serviceUid) ||
				(stat.mode & 0o022) !== 0
			)
				deny();
			ancestors.push({ path: parent, stat });
			if (parent === dirname(parent)) break;
		}
		const bytes = boundedRead(
			path,
			options.maxBytes,
			(stat) => stat.uid === 0 && (stat.mode & 0o7777) === 0o644,
		);
		if (ancestors.some((entry) => !same(entry.stat, lstatSync(entry.path))))
			deny();
		return bytes;
	} catch {
		return deny();
	}
}
