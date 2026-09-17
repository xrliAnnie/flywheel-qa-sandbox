import { createHash } from "node:crypto";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	readImmutableFile,
	readPrivateFile,
	readRootReceipt,
} from "../trusted-files.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync("/tmp/xhs-trusted-files-");
	roots.push(root);
	chmodSync(root, 0o700);
	const file = join(root, "secret");
	writeFileSync(file, "synthetic-secret", { mode: 0o600 });
	return { root, file };
}
it("reads a real immutable root-owned executable with the exact digest", () => {
	const path = realpathSync("/usr/bin/env");
	const bytes = readFileSync(path);
	expect(
		readImmutableFile(path, {
			sha256: createHash("sha256").update(bytes).digest("hex"),
			maxBytes: 1024 * 1024,
			executable: true,
		}),
	).toEqual(bytes);
	expect(() =>
		readImmutableFile(path, {
			sha256: "0".repeat(64),
			maxBytes: 1024 * 1024,
			executable: true,
		}),
	).toThrow("trusted_file_unavailable");
});
it("rejects a model-owned file even when its content digest matches", () => {
	const { file } = fixture();
	expect(() =>
		readImmutableFile(file, {
			sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
			maxBytes: 128,
		}),
	).toThrow("trusted_file_unavailable");
});
it("reads only a bounded private single-link file within its verified private root", () => {
	const { root, file } = fixture();
	expect(
		readPrivateFile(file, {
			root,
			uid: process.getuid!(),
			maxBytes: 128,
		}).toString(),
	).toBe("synthetic-secret");
	expect(() =>
		readPrivateFile(file, { root, uid: process.getuid!(), maxBytes: 3 }),
	).toThrow("trusted_file_unavailable");
	chmodSync(file, 0o644);
	expect(() =>
		readPrivateFile(file, { root, uid: process.getuid!(), maxBytes: 128 }),
	).toThrow("trusted_file_unavailable");
});
it("rejects private symlinks, hardlinks, wrong UID and escaped paths", () => {
	const { root, file } = fixture();
	const opts = { root, uid: process.getuid!(), maxBytes: 128 };
	const alias = join(root, "alias");
	symlinkSync(file, alias);
	expect(() => readPrivateFile(alias, opts)).toThrow(
		"trusted_file_unavailable",
	);
	expect(() => readPrivateFile(file, { ...opts, uid: opts.uid + 1 })).toThrow(
		"trusted_file_unavailable",
	);
	expect(() =>
		readPrivateFile(`${root}/../${root.split("/").pop()}/secret`, opts),
	).toThrow("trusted_file_unavailable");
	linkSync(file, join(root, "hard"));
	expect(() => readPrivateFile(file, opts)).toThrow("trusted_file_unavailable");
});
it("rejects private directory permission drift and symlink traversal", () => {
	const { root, file } = fixture();
	const options = { root, uid: process.getuid!(), maxBytes: 128 };
	chmodSync(root, 0o750);
	expect(() => readPrivateFile(file, options)).toThrow(
		"trusted_file_unavailable",
	);
	chmodSync(root, 0o700);
	const alias = `${root}-link`;
	symlinkSync(root, alias);
	roots.push(alias);
	expect(() =>
		readPrivateFile(join(alias, "secret"), { ...options, root: alias }),
	).toThrow("trusted_file_unavailable");
});
it("rejects special permission bits on a private secret", () => {
	const { root, file } = fixture();
	// This environment silently clears setuid/setgid on chmod. The sticky bit
	// persists on a regular file and exercises the same exact-mode rejection.
	chmodSync(file, 0o1600);
	expect(lstatSync(file).mode & 0o7777).toBe(0o1600);
	expect(() =>
		readPrivateFile(file, { root, uid: process.getuid!(), maxBytes: 128 }),
	).toThrow("trusted_file_unavailable");
});

it("reads bounded root-owned receipt bytes and rejects a model-owned substitute", () => {
	// Exercise the reader on an existing non-secret root-owned 0644 file.
	// These bytes are not an acceptance signature or a host isolation proof.
	const path = realpathSync("/etc/hosts");
	expect(
		readRootReceipt(path, { serviceUid: process.getuid!(), maxBytes: 65536 }),
	).toEqual(readFileSync(path));
	const { file } = fixture();
	chmodSync(file, 0o644);
	expect(() =>
		readRootReceipt(file, { serviceUid: process.getuid!(), maxBytes: 128 }),
	).toThrow("trusted_file_unavailable");
});
