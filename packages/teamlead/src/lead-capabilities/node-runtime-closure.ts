import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

/** Fixed trusted inspector; resolved via Xcode Command Line Tools. */
const OTOOL = "/usr/bin/otool";
const MAX_FILES = 64;
const MAX_DEPTH = 8;
/** dyld shared-cache images: `:minimal` already reads them and most are absent on disk. */
const SHARED_CACHE_PREFIXES = ["/usr/lib/", "/System/Library/"];
const DEPENDENCY_COMMANDS = new Set([
	"LC_LOAD_DYLIB",
	"LC_LOAD_WEAK_DYLIB",
	"LC_REEXPORT_DYLIB",
	"LC_LOAD_UPWARD_DYLIB",
]);
const unresolved = () => new Error("node_runtime_closure_unresolved");

export interface MachOLoadCommands {
	dependencies: { name: string; weak: boolean }[];
	rpaths: string[];
}

/** Reads `otool -l` text. Only dependency and rpath commands are returned. */
export function parseMachOLoadCommands(text: string): MachOLoadCommands {
	const dependencies: MachOLoadCommands["dependencies"] = [];
	const rpaths: string[] = [];
	let command: string | undefined;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("Load command ")) {
			command = undefined;
			continue;
		}
		const cmd = /^cmd (LC_[A-Z0-9_]+)$/u.exec(line);
		if (cmd) {
			command = cmd[1];
			continue;
		}
		const name = /^name (.+) \(offset \d+\)$/u.exec(line);
		if (name && command && DEPENDENCY_COMMANDS.has(command)) {
			dependencies.push({
				name: name[1]!,
				weak: command === "LC_LOAD_WEAK_DYLIB",
			});
			continue;
		}
		const path = /^path (.+) \(offset \d+\)$/u.exec(line);
		if (path && command === "LC_RPATH") rpaths.push(path[1]!);
	}
	return { dependencies, rpaths };
}

function hostArch(): string {
	if (process.arch === "arm64") return "arm64";
	if (process.arch === "x64") return "x86_64";
	throw unresolved();
}

function readLoadCommands(path: string): string {
	return execFileSync(OTOOL, ["-arch", hostArch(), "-l", path], {
		encoding: "utf8",
		timeout: 5_000,
		maxBuffer: 4 * 1024 * 1024,
		stdio: ["ignore", "pipe", "ignore"],
		env: { PATH: "/usr/bin:/bin" },
	});
}

/** The profile accepts only exact normalized absolute paths without glob characters. */
function exactPath(path: string): string {
	if (
		!isAbsolute(path) ||
		normalize(path) !== path ||
		/[*?[\]{}]/u.test(path) ||
		[...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
	)
		throw unresolved();
	return path;
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		realpathSync(path);
		return true;
	} catch {
		return false;
	}
}

interface Image {
	/** Path the loader named (may be a symlink). */
	literal: string;
	real: string;
	/** Expanded rpaths searched for this image's @rpath names: its own first, then its loaders'. */
	rpaths: readonly string[];
	depth: number;
}

/**
 * Directories that hold the symlink nodes crossed while resolving `path`.
 * Codex canonicalizes every profile path, so a symlink node cannot be granted by
 * its own path; Seatbelt still checks it during lookup. Only a subpath grant on
 * the (canonical) directory containing the link covers it (FLY-2886 §14.3 R-impl).
 */
export function symlinkHopDirectories(path: string): string[] {
	const hops = new Set<string>();
	let prefix: string = sep;
	const queue = path.split(sep).filter(Boolean);
	let steps = 0;
	while (queue.length) {
		if (++steps > 128) throw unresolved();
		const part = queue.shift()!;
		if (part === ".") continue;
		if (part === "..") {
			prefix = dirname(prefix);
			continue;
		}
		const candidate = join(prefix, part);
		if (lstatSync(candidate).isSymbolicLink()) {
			hops.add(prefix);
			const target = readlinkSync(candidate);
			if (isAbsolute(target)) prefix = sep;
			queue.unshift(...target.split(sep).filter(Boolean));
		} else prefix = candidate;
	}
	return [...hops];
}

/** A hop directory is granted as a subpath, so keep it narrow and away from home. */
function hopDirectory(path: string, home: string): string {
	exactPath(path);
	if (
		path.split(sep).filter(Boolean).length < 3 ||
		home === path ||
		home.startsWith(`${path}${sep}`)
	)
		throw unresolved();
	return path;
}

export interface NodeRuntimeClosure {
	/** Exact regular files the loader maps: the executable and its dylibs. */
	files: string[];
	/** Canonical directories holding symlink nodes on the loader's lookup paths. */
	directories: string[];
}

/**
 * Trusted launcher helper: what the dynamic loader opens for this node, following
 * dyld's @rpath / @loader_path / @executable_path rules. Files are realpaths;
 * symlinked install names contribute the directories holding their link nodes.
 * Shared-cache system libraries are omitted. Unresolvable required dependencies,
 * broad hop directories or oversized closures fail closed.
 */
export function resolveNodeRuntimeClosure(
	nodePath: string,
	options: { otool?: (path: string) => string; home?: string } = {},
): NodeRuntimeClosure {
	const otool = options.otool ?? readLoadCommands;
	let executable: string;
	let home: string;
	try {
		executable = realpathSync(nodePath);
		home = realpathSync(options.home ?? homedir());
	} catch {
		throw unresolved();
	}
	exactPath(executable);
	const executableDir = dirname(executable);
	const files = new Set<string>([executable]);
	const directories = new Set<string>();
	const visited = new Set<string>();
	const pending: Image[] = [
		{ literal: executable, real: executable, rpaths: [], depth: 0 },
	];
	const count = () => {
		if (files.size + directories.size > MAX_FILES) throw unresolved();
	};
	while (pending.length) {
		const image = pending.shift()!;
		if (visited.has(image.real)) continue;
		visited.add(image.real);
		if (image.depth > MAX_DEPTH) throw unresolved();
		let commands: MachOLoadCommands;
		try {
			commands = parseMachOLoadCommands(otool(image.real));
		} catch {
			throw unresolved();
		}
		// @loader_path is the directory of the image that holds the command.
		const loaderDirs = [
			...new Set([dirname(image.real), dirname(image.literal)]),
		];
		const expand = (value: string): string[] => {
			if (value.startsWith("@loader_path"))
				return loaderDirs.map((dir) =>
					normalize(join(dir, value.slice("@loader_path".length))),
				);
			if (value.startsWith("@executable_path"))
				return [
					normalize(
						join(executableDir, value.slice("@executable_path".length)),
					),
				];
			if (value.startsWith("@")) throw unresolved();
			if (!isAbsolute(value)) throw unresolved();
			return [normalize(value)];
		};
		const rpaths = [
			...commands.rpaths.flatMap((value) => expand(value)),
			...image.rpaths,
		];
		for (const dependency of commands.dependencies) {
			const name = dependency.name;
			if (SHARED_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)))
				continue;
			const candidates = name.startsWith("@rpath/")
				? rpaths.map((dir) =>
						normalize(join(dir, name.slice("@rpath/".length))),
					)
				: expand(name);
			const literal = candidates.find(exists);
			if (!literal) {
				if (dependency.weak) continue;
				throw unresolved();
			}
			if (SHARED_CACHE_PREFIXES.some((prefix) => literal.startsWith(prefix)))
				continue;
			exactPath(literal);
			const real = realpathSync(literal);
			if (!lstatSync(real).isFile()) throw unresolved();
			files.add(exactPath(real));
			let hops: string[];
			try {
				hops = symlinkHopDirectories(literal);
			} catch {
				throw unresolved();
			}
			for (const hop of hops) directories.add(hopDirectory(hop, home));
			count();
			pending.push({ literal, real, rpaths, depth: image.depth + 1 });
		}
	}
	return { files: [...files].sort(), directories: [...directories].sort() };
}

/** Read grants the sandboxed node needs: the executable itself plus its loader closure. */
export function leadNodeRuntimeReadPaths(
	nodePath: string,
	options: { otool?: (path: string) => string; home?: string } = {},
): string[] {
	const closure = resolveNodeRuntimeClosure(nodePath, options);
	return [...closure.files, ...closure.directories].sort();
}
