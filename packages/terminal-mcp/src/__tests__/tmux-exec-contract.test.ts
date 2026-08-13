import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const directTmuxProcess =
	/\b(execFile(?:Async|Sync)?|spawn(?:Sync)?)\s*\(\s*["']tmux["']/s;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "__tests__" ? [] : sourceFiles(path);
		}
		return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

describe("tmux execution boundary contract", () => {
	it("keeps every production tmux subprocess behind tmux-exec.ts", () => {
		const offenders = sourceFiles(srcRoot)
			.filter((path) => !path.endsWith("/tmux-exec.ts"))
			.filter((path) => directTmuxProcess.test(readFileSync(path, "utf8")))
			.map((path) => relative(srcRoot, path));

		expect(offenders).toEqual([]);
	});
});
