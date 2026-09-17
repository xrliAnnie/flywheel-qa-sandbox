// Narrow offline policy for the official Node executable and SQLite addon.
// This artifact needs no bundled dylibs or rpaths. Reject them rather than
// attempting relocation or a general dependency resolver.
import { posix } from "node:path";

const inert = new Set([
	"LC_SEGMENT_64",
	"LC_SYMTAB",
	"LC_DYSYMTAB",
	"LC_UUID",
	"LC_BUILD_VERSION",
	"LC_VERSION_MIN_MACOSX",
	"LC_SOURCE_VERSION",
	"LC_MAIN",
	"LC_FUNCTION_STARTS",
	"LC_DATA_IN_CODE",
	"LC_CODE_SIGNATURE",
	"LC_DYLD_INFO_ONLY",
	"LC_DYLD_EXPORTS_TRIE",
	"LC_DYLD_CHAINED_FIXUPS",
	"LC_LINKER_OPTIMIZATION_HINT",
	"LC_TWOLEVEL_HINTS",
]);
const loads = new Set([
	"LC_LOAD_DYLIB",
	"LC_LOAD_WEAK_DYLIB",
	"LC_REEXPORT_DYLIB",
	"LC_LOAD_UPWARD_DYLIB",
	"LC_LOAD_DYLINKER",
]);

export function inspectNativeLoadCommands(raw: string): string[] {
	const deny = (): never => {
		throw Error("native_loader_unavailable");
	};
	if (!raw || Buffer.byteLength(raw) > 256 * 1024 || raw.includes("\0")) deny();
	const sections = raw.split(/^Load command /m);
	if (sections.length < 2 || sections.length > 129) deny();
	const dependencies: string[] = [];
	for (const [index, section] of sections.slice(1).entries()) {
		if (!section.startsWith(`${index}\n`)) deny();
		const commands = [...section.matchAll(/^\s*cmd (\S+)\s*$/gm)];
		if (commands.length !== 1) deny();
		const cmd = commands[0]?.[1] ?? deny();
		if (inert.has(cmd)) continue;
		if (!loads.has(cmd)) deny();
		const names = [...section.matchAll(/^\s*name (.+) \(offset \d+\)\s*$/gm)];
		if (names.length !== 1) deny();
		const path = names[0]?.[1] ?? deny();
		if (
			!/^\/[\x21-\x7e]+$/.test(path) ||
			posix.normalize(path) !== path ||
			(!path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"))
		)
			deny();
		dependencies.push(path);
	}
	if (!dependencies.length) deny();
	return [...new Set(dependencies)].sort();
}
