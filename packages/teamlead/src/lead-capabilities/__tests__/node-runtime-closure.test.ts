import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	leadNodeRuntimeReadPaths,
	parseMachOLoadCommands,
	resolveNodeRuntimeClosure,
} from "../node-runtime-closure.js";

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "node-closure-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(path: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "fixture");
	return path;
}
function link(target: string, path: string) {
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(target, path);
	return path;
}
const dylib = (name: string, command = "LC_LOAD_DYLIB") =>
	`Load command 9\n          cmd ${command}\n      cmdsize 56\n         name ${name} (offset 24)\n   time stamp 2 Wed Dec 31 16:00:02 1969\n`;
const rpath = (path: string) =>
	`Load command 12\n          cmd LC_RPATH\n      cmdsize 32\n         path ${path} (offset 12)\n`;

function otoolFrom(table: Record<string, string>) {
	const calls: string[] = [];
	return {
		calls,
		otool: (path: string) => {
			calls.push(path);
			const text = table[path];
			if (text === undefined) throw new Error(`unexpected otool ${path}`);
			return text;
		},
	};
}

it("parses dependency and rpath load commands and ignores others", () => {
	const parsed = parseMachOLoadCommands(
		[
			"/x/node:",
			"Load command 0\n      cmd LC_SEGMENT_64\n  segname __PAGEZERO\n",
			dylib("@rpath/libnode.141.dylib"),
			dylib("/usr/lib/libz.1.dylib"),
			dylib("/opt/w/libweak.dylib", "LC_LOAD_WEAK_DYLIB"),
			dylib("/opt/r/libre.dylib", "LC_REEXPORT_DYLIB"),
			"Load command 3\n          cmd LC_ID_DYLIB\n      cmdsize 72\n         name /opt/self.dylib (offset 24)\n",
			rpath("@loader_path/../lib"),
		].join(""),
	);
	expect(parsed).toEqual({
		dependencies: [
			{ name: "@rpath/libnode.141.dylib", weak: false },
			{ name: "/usr/lib/libz.1.dylib", weak: false },
			{ name: "/opt/w/libweak.dylib", weak: true },
			{ name: "/opt/r/libre.dylib", weak: false },
		],
		rpaths: ["@loader_path/../lib"],
	});
});

it("resolves @rpath through the loader chain, recurses, grants realpaths plus the directories of crossed symlinks, skips shared-cache libraries", () => {
	const cellar = join(root, "Cellar/node/25/bin/node");
	file(cellar);
	const libnode = file(join(root, "Cellar/node/25/lib/libnode.141.dylib"));
	const uvReal = file(join(root, "Cellar/libuv/1.0/lib/libuv.1.dylib"));
	link(join(root, "Cellar/libuv/1.0"), join(root, "opt/libuv"));
	const uvLiteral = join(root, "opt/libuv/lib/libuv.1.dylib");
	const sslReal = file(join(root, "Cellar/openssl/3/lib/libcrypto.3.dylib"));
	const sslLiteral = link(
		sslReal,
		join(root, "opt/openssl/lib/libcrypto.3.dylib"),
	);
	const exec = file(join(root, "Cellar/node/25/bin/libexec.dylib"));
	const { otool, calls } = otoolFrom({
		[cellar]: [
			dylib("@rpath/libnode.141.dylib"),
			dylib("/usr/lib/libz.1.dylib"),
			dylib(
				"/System/Library/Frameworks/Security.framework/Versions/A/Security",
			),
			dylib(uvLiteral),
			rpath("@loader_path"),
			rpath("@loader_path/../lib"),
		].join(""),
		[libnode]: [
			dylib(uvLiteral),
			dylib(sslLiteral),
			dylib("@executable_path/libexec.dylib"),
		].join(""),
		[uvReal]: "",
		[sslReal]: dylib("@loader_path/../../../node/25/bin/libexec.dylib"),
		[exec]: "",
	});
	const closure = resolveNodeRuntimeClosure(cellar, { otool });
	expect(closure).toEqual({
		files: [cellar, libnode, uvReal, sslReal, exec].sort(),
		// root/opt holds the libuv directory link; root/opt/openssl/lib holds the file link.
		directories: [join(root, "opt"), join(root, "opt/openssl/lib")].sort(),
	});
	// Each real image is inspected exactly once.
	expect([...calls].sort()).toEqual(
		[cellar, libnode, uvReal, sslReal, exec].sort(),
	);
	expect(leadNodeRuntimeReadPaths(cellar, { otool })).toEqual(
		[...closure.files, ...closure.directories].sort(),
	);
});

it("uses the image's own rpaths before its loader's", () => {
	const node = file(join(root, "bin/node"));
	const own = file(join(root, "own/libdep.dylib"));
	file(join(root, "lib/libdep.dylib"));
	const mid = file(join(root, "lib/libmid.dylib"));
	const { otool } = otoolFrom({
		[node]: dylib("@rpath/libmid.dylib") + rpath("@loader_path/../lib"),
		[mid]: dylib("@rpath/libdep.dylib") + rpath(join(root, "own")),
		[own]: "",
	});
	expect(resolveNodeRuntimeClosure(node, { otool })).toEqual({
		files: [node, mid, own].sort(),
		directories: [],
	});
});

it("skips an unresolvable weak dependency but rejects an unresolvable required one", () => {
	const node = file(join(root, "bin/node"));
	expect(
		resolveNodeRuntimeClosure(node, {
			otool: otoolFrom({
				[node]: dylib("@rpath/libmissing.dylib", "LC_LOAD_WEAK_DYLIB"),
			}).otool,
		}),
	).toEqual({ files: [node], directories: [] });
	expect(() =>
		resolveNodeRuntimeClosure(node, {
			otool: otoolFrom({ [node]: dylib("@rpath/libmissing.dylib") }).otool,
		}),
	).toThrow("node_runtime_closure_unresolved");
	expect(() =>
		resolveNodeRuntimeClosure(node, {
			otool: otoolFrom({ [node]: dylib(join(root, "absent.dylib")) }).otool,
		}),
	).toThrow("node_runtime_closure_unresolved");
});

it.each([
	["relative install name", "libplain.dylib"],
	[
		"glob characters the permission profile cannot express",
		"/opt/lib[1].dylib",
	],
])("rejects a %s", (_label, name) => {
	const node = file(join(root, "bin/node"));
	if (name.startsWith("/opt/")) file(join(root, "opt/lib[1].dylib"));
	expect(() =>
		resolveNodeRuntimeClosure(node, {
			otool: otoolFrom({
				[node]: dylib(name.startsWith("/opt/") ? join(root, name) : name),
			}).otool,
		}),
	).toThrow("node_runtime_closure_unresolved");
});

it("rejects a symlink hop directory that is home or one of its ancestors", () => {
	const node = file(join(root, "bin/node"));
	const real = file(join(root, "keg/libx.1.0.dylib"));
	const literal = link(real, join(root, "home/libx.dylib"));
	mkdirSync(join(root, "home/user"), { recursive: true });
	const otool = otoolFrom({ [node]: dylib(literal), [real]: "" }).otool;
	for (const home of [join(root, "home"), join(root, "home/user")])
		expect(() => resolveNodeRuntimeClosure(node, { otool, home })).toThrow(
			"node_runtime_closure_unresolved",
		);
	expect(
		resolveNodeRuntimeClosure(node, { otool, home: join(root, "bin") })
			.directories,
	).toEqual([join(root, "home")]);
});

it("rejects a closure over the file cap", () => {
	const node = file(join(root, "bin/node"));
	const table: Record<string, string> = { [node]: "" };
	for (let index = 0; index < 64; index++) {
		const path = file(join(root, `lib/lib${index}.dylib`));
		table[node] += dylib(path);
		table[path] = "";
	}
	expect(() =>
		resolveNodeRuntimeClosure(node, { otool: otoolFrom(table).otool }),
	).toThrow("node_runtime_closure_unresolved");
});

it("rejects a closure deeper than the recursion cap", () => {
	const node = file(join(root, "bin/node"));
	const table: Record<string, string> = {};
	let previous = node;
	for (let index = 0; index < 9; index++) {
		const next = file(join(root, `lib/chain${index}.dylib`));
		table[previous] = dylib(next);
		previous = next;
	}
	table[previous] = "";
	expect(() =>
		resolveNodeRuntimeClosure(node, { otool: otoolFrom(table).otool }),
	).toThrow("node_runtime_closure_unresolved");
});

it("rejects when the load commands cannot be read", () => {
	const node = file(join(root, "bin/node"));
	expect(() =>
		resolveNodeRuntimeClosure(node, {
			otool: () => {
				throw new Error("xcode-select: note: no developer tools were found");
			},
		}),
	).toThrow("node_runtime_closure_unresolved");
});

it.skipIf(
	process.platform !== "darwin" ||
		!existsSync("/usr/bin/otool") ||
		!realpathSync(process.execPath).startsWith("/opt/homebrew/Cellar/node/"),
)(
	"resolves the actual Homebrew node closure including @rpath libnode (host)",
	() => {
		const node = realpathSync(process.execPath);
		const { files, directories } = resolveNodeRuntimeClosure(node);
		expect(files).toContain(node);
		expect(files.some((path) => /\/libnode\.\d+\.dylib$/.test(path))).toBe(
			true,
		);
		expect(
			files.every((path) => path.startsWith("/opt/homebrew/Cellar/")),
		).toBe(true);
		expect(directories).toContain("/opt/homebrew/opt");
		expect(
			[...files, ...directories].every(
				(path) =>
					!path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"),
			),
		).toBe(true);
		expect(files.length + directories.length).toBeLessThanOrEqual(64);
	},
);
