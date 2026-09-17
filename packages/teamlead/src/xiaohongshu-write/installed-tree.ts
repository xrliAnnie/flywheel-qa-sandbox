import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	type Stats,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { z } from "zod";
import { parseStrictJson } from "./canonical.js";

const safePath = (value: string) =>
	![...value].some((c) => c.charCodeAt(0) < 32) &&
	Buffer.byteLength(value) < 1024;
const relativePath = z
	.string()
	.min(1)
	.refine(
		(value) =>
			safePath(value) &&
			!value.startsWith("/") &&
			value !== "." &&
			value !== ".." &&
			!value.startsWith("../") &&
			!value.endsWith("/") &&
			posix.normalize(value) === value &&
			value.split("/").length <= 32,
	);
const mode = z
	.number()
	.int()
	.min(0)
	.max(0o777)
	.refine((value) => (value & 0o022) === 0);
const entry = z.discriminatedUnion("kind", [
	z.object({ path: relativePath, kind: z.literal("directory"), mode }).strict(),
	z
		.object({
			path: relativePath,
			kind: z.literal("file"),
			mode,
			size: z
				.number()
				.int()
				.min(0)
				.max(256 * 1024 * 1024),
			sha256: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.strict(),
]);
const schema = z
	.object({
		schemaVersion: z.literal(1),
		root: z
			.string()
			.refine(
				(value) =>
					safePath(value) &&
					value.startsWith("/Library/Application Support/Flywheel/Xhs/") &&
					!value.endsWith("/") &&
					posix.normalize(value) === value,
			),
		entries: z.array(entry).min(1).max(20000),
	})
	.strict();
function same(a: Stats, b: Stats) {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.uid === b.uid &&
		a.gid === b.gid &&
		a.mode === b.mode &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs
	);
}
function trusted(stat: Stats) {
	if (stat.uid !== 0 || stat.mode & 0o7022) throw Error();
}
function measure(path: string, stat: Stats) {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		if (!same(stat, fstatSync(fd))) throw Error();
		const hash = createHash("sha256"),
			buffer = Buffer.alloc(64 * 1024);
		let count = 0;
		for (;;) {
			const size = readSync(fd, buffer, 0, buffer.length, null);
			if (!size) break;
			count += size;
			if (count > stat.size) throw Error();
			hash.update(buffer.subarray(0, size));
		}
		if (
			count !== stat.size ||
			!same(stat, fstatSync(fd)) ||
			!same(stat, lstatSync(path))
		)
			throw Error();
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}
/** Parsing does not establish manifest provenance or installed state. */
export function parseInstalledTreeManifest(raw: string) {
	if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
		throw Error("installed_tree_unavailable");
	const manifest = schema.parse(parseStrictJson(raw));
	if (
		new Set(manifest.entries.map((item) => item.path)).size !==
		manifest.entries.length
	)
		throw Error("installed_tree_unavailable");
	return manifest;
}

/** Verifies exact installed tree contents, not the provenance of the manifest.
 * The native/root bootstrap must authenticate manifest bytes before calling.
 * A tree receipt alone does not establish that dynamic imports outside it are
 * forbidden; installer layout and native bootstrap remain separate obligations. */
export function verifyInstalledTree(raw: string) {
	try {
		if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw Error();
		const manifest = parseInstalledTreeManifest(raw);
		const expected = new Map(manifest.entries.map((item) => [item.path, item]));
		if (expected.size !== manifest.entries.length) throw Error();
		const ancestors: { path: string; stat: Stats }[] = [];
		for (let path = manifest.root; ; path = dirname(path)) {
			const stat = lstatSync(path);
			trusted(stat);
			if (!stat.isDirectory()) throw Error();
			ancestors.push({ path, stat });
			if (path === dirname(path)) break;
		}
		let seen = 0,
			bytes = 0,
			files = 0;
		const directories: { path: string; stat: Stats; names: string[] }[] = [];
		const measuredFiles: { path: string; stat: Stats }[] = [];
		const visit = (directory: string, prefix: string, depth: number) => {
			if (depth > 32) throw Error();
			const stat = lstatSync(directory);
			trusted(stat);
			if (!stat.isDirectory()) throw Error();
			const names = readdirSync(directory).sort();
			if (names.length > 20000 || seen + names.length > 20000) throw Error();
			directories.push({ path: directory, stat, names });
			for (const name of names) {
				const path = prefix ? `${prefix}/${name}` : name,
					spec = expected.get(path);
				if (!spec || ++seen > manifest.entries.length) throw Error();
				const absolute = join(directory, name),
					actual = lstatSync(absolute);
				trusted(actual);
				if ((actual.mode & 0o7777) !== spec.mode) throw Error();
				if (spec.kind === "directory") {
					if (!actual.isDirectory()) throw Error();
					visit(absolute, path, depth + 1);
				} else {
					if (
						!actual.isFile() ||
						actual.nlink !== 1 ||
						actual.size !== spec.size
					)
						throw Error();
					bytes += actual.size;
					if (bytes > 2 * 1024 * 1024 * 1024) throw Error();
					if (measure(absolute, actual) !== spec.sha256) throw Error();
					measuredFiles.push({ path: absolute, stat: actual });
					files++;
				}
			}
		};
		visit(manifest.root, "", 0);
		if (seen !== manifest.entries.length) throw Error();
		for (const item of [...ancestors, ...directories, ...measuredFiles])
			if (!same(item.stat, lstatSync(item.path))) throw Error();
		for (const item of directories)
			if (
				JSON.stringify(item.names) !==
				JSON.stringify(readdirSync(item.path).sort())
			)
				throw Error();
		return {
			root: manifest.root,
			files,
			bytes,
			manifestSha256: createHash("sha256").update(raw).digest("hex"),
		};
	} catch {
		throw Error("installed_tree_unavailable");
	}
}
