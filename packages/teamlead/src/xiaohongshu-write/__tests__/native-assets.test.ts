import { expect, it } from "vitest";
import { inspectNativeLoadCommands } from "../native-assets.js";

const output = (command: string, path: string) =>
	`/fixed/node:\nLoad command 0\n cmd ${command}\n cmdsize 56\n name ${path} (offset 24)\n`;

it("accepts only the fixed runtime's system-library loader closure", () => {
	expect(
		inspectNativeLoadCommands(
			output("LC_LOAD_DYLIB", "/usr/lib/libSystem.B.dylib"),
		),
	).toEqual(["/usr/lib/libSystem.B.dylib"]);
	expect(
		inspectNativeLoadCommands(
			output(
				"LC_LOAD_WEAK_DYLIB",
				"/System/Library/Frameworks/Security.framework/Versions/A/Security",
			),
		),
	).toHaveLength(1);
});

it.each([
	"/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
	"/Users/founder/lib.dylib",
	"@rpath/libnode.dylib",
	"@loader_path/libsqlite3.dylib",
	"/usr/lib/../../Users/founder/lib.dylib",
	"/usr/library/lib.dylib",
	"/System/Library//lib.dylib",
])("rejects unapproved dependency %s", (path) => {
	expect(() =>
		inspectNativeLoadCommands(output("LC_LOAD_DYLIB", path)),
	).toThrow("native_loader_unavailable");
});

it.each([
	"LC_RPATH",
	"LC_DYLD_ENVIRONMENT",
	"LC_PREBOUND_DYLIB",
	"LC_UNKNOWN",
	"LC_ID_DYLIB",
])("rejects loader command %s", (cmd) => {
	expect(() =>
		inspectNativeLoadCommands(output(cmd, "/usr/lib/libSystem.B.dylib")),
	).toThrow();
});

it("rejects missing, duplicate, oversized and malformed loader output", () => {
	for (const raw of [
		"",
		"node:\n",
		"x".repeat(262145),
		output("LC_LOAD_DYLIB", "/usr/lib/libSystem.B.dylib").replace(
			" name ",
			" missing ",
		),
		output("LC_LOAD_DYLIB", "/usr/lib/libSystem.B.dylib") +
			" name /Users/founder/evil (offset 24)\n",
	])
		expect(() => inspectNativeLoadCommands(raw)).toThrow();
});
