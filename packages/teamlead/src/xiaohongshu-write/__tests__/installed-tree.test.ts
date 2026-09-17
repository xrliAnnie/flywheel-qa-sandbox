import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyInstalledTree } from "../installed-tree.js";

const f = vi.hoisted(() => ({
	base: "",
	writable: "",
	owner: "",
	lateMutation: false,
}));
vi.mock("node:fs", async (original) => {
	const real = await original<typeof import("node:fs")>();
	const map = (p: string) =>
		p.replace("/Library/Application Support/Flywheel/Xhs/runtime", f.base);
	const stat = (s: fs.Stats, p = "") =>
		Object.assign(s, {
			uid: p && p === f.owner ? 501 : 0,
			mode: s.mode | (p && p === f.writable ? 0o020 : 0),
		});
	return {
		...real,
		lstatSync: (p: string) =>
			stat(
				real.lstatSync(
					p.startsWith("/Library/Application Support/Flywheel/Xhs/runtime")
						? map(p)
						: f.base,
				),
				p,
			),
		fstatSync: (fd: number) => stat(real.fstatSync(fd)),
		openSync: (p: string, flags: number) => real.openSync(map(p), flags),
		readSync: (
			fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
			position: number | null,
		) => {
			const n = real.readSync(fd, buffer, offset, length, position);
			if (
				f.lateMutation &&
				n &&
				real.fstatSync(fd).ino ===
					real.lstatSync(join(f.base, "modules/dep.js")).ino
			) {
				f.lateMutation = false;
				real.writeFileSync(join(f.base, "entry.js"), "EVIL!");
			}
			return n;
		},
		readdirSync: (p: string) => real.readdirSync(map(p)),
	};
});
const root = "/Library/Application Support/Flywheel/Xhs/runtime";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const manifest = () => ({
	schemaVersion: 1,
	root,
	entries: [
		{ path: "modules", kind: "directory", mode: 0o755 },
		{
			path: "entry.js",
			kind: "file",
			mode: 0o644,
			size: 5,
			sha256: sha("entry"),
		},
		{
			path: "modules/dep.js",
			kind: "file",
			mode: 0o644,
			size: 3,
			sha256: sha("dep"),
		},
		{
			path: "modules/empty",
			kind: "file",
			mode: 0o644,
			size: 0,
			sha256: sha(""),
		},
	],
});
beforeEach(() => {
	f.base = fs.mkdtempSync("/tmp/xhs-tree-");
	fs.chmodSync(f.base, 0o755);
	f.writable = "";
	f.owner = "";
	f.lateMutation = false;
	fs.mkdirSync(join(f.base, "modules"), { mode: 0o755 });
	fs.writeFileSync(join(f.base, "entry.js"), "entry", { mode: 0o644 });
	fs.writeFileSync(join(f.base, "modules/dep.js"), "dep", { mode: 0o644 });
	fs.writeFileSync(join(f.base, "modules/empty"), "", { mode: 0o644 });
});
afterEach(() => fs.rmSync(f.base, { recursive: true, force: true }));
it("measures every dependency and empty file against the complete manifest", () => {
	expect(verifyInstalledTree(JSON.stringify(manifest()))).toMatchObject({
		root,
		files: 3,
		bytes: 8,
	});
});
it.each([
	"extra-file",
	"extra-directory",
	"missing",
	"changed",
	"symlink",
	"hardlink",
	"writable",
	"owner",
	"traversal",
	"duplicate",
	"bad-digest",
])("rejects %s", (mode) => {
	const m = manifest();
	if (mode === "extra-file")
		fs.writeFileSync(join(f.base, "injected.js"), "evil");
	if (mode === "extra-directory") fs.mkdirSync(join(f.base, "unlisted"));
	if (mode === "missing") fs.unlinkSync(join(f.base, "entry.js"));
	if (mode === "changed")
		fs.writeFileSync(join(f.base, "modules/dep.js"), "bad");
	if (mode === "symlink") {
		fs.unlinkSync(join(f.base, "modules/dep.js"));
		fs.symlinkSync("../entry.js", join(f.base, "modules/dep.js"));
	}
	if (mode === "hardlink") {
		fs.unlinkSync(join(f.base, "modules/dep.js"));
		fs.linkSync(join(f.base, "entry.js"), join(f.base, "modules/dep.js"));
	}
	if (mode === "writable") f.writable = root;
	if (mode === "owner") f.owner = `${root}/modules/dep.js`;
	if (mode === "traversal") m.entries[0]!.path = "../modules";
	if (mode === "duplicate") m.entries.push(m.entries[0]!);
	if (mode === "bad-digest") m.entries[1]!.sha256 = "a".repeat(64);
	expect(() => verifyInstalledTree(JSON.stringify(m))).toThrow(
		"installed_tree_unavailable",
	);
});

it("rejects a previously measured file changed during later dependency reads", () => {
	f.lateMutation = true;
	expect(() => verifyInstalledTree(JSON.stringify(manifest()))).toThrow(
		"installed_tree_unavailable",
	);
});
