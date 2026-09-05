import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Kind = "sync_child" | "sync_marker" | "raw_spawn";
type Entry = { file: string; disposition: string } & Partial<
	Record<Kind, number>
>;
type Manifest = { version: number; issue: string; entries: Entry[] };

const ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);
const MANIFEST_PATH = join(
	ROOT,
	"packages/teamlead/src/bridge/child-process-census.json",
);
const PATTERNS: Record<Kind, RegExp> = {
	sync_child: /\b(?:execFileSync|spawnSync|execSync)\s*\(/g,
	sync_marker: /\b(?:withSyncOpMarker|markSyncOp)\s*\(/g,
	raw_spawn: /\bspawn\s*\(/g,
};

function productionFiles(): string[] {
	const result: string[] = [];
	const walk = (directory: string): void => {
		for (const name of readdirSync(directory)) {
			if (name === "__tests__" || name === "dist") continue;
			const path = join(directory, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
				result.push(relative(ROOT, path));
			}
		}
	};
	for (const packageName of readdirSync(join(ROOT, "packages"))) {
		const source = join(ROOT, "packages", packageName, "src");
		try {
			if (statSync(source).isDirectory()) walk(source);
		} catch {
			// A package without src has no production TypeScript to inventory.
		}
	}
	return result.sort();
}

function sweep(): Entry[] {
	const entries: Entry[] = [];
	for (const file of productionFiles()) {
		const source = readFileSync(join(ROOT, file), "utf8");
		const counts: Partial<Record<Kind, number>> = {};
		for (const [kind, pattern] of Object.entries(PATTERNS) as Array<
			[Kind, RegExp]
		>) {
			const count = source.match(pattern)?.length ?? 0;
			if (count > 0) counts[kind] = count;
		}
		if (Object.keys(counts).length > 0) {
			entries.push({ file, disposition: "", ...counts });
		}
	}
	return entries;
}

describe("FLY-2331 production child-process census", () => {
	it("fails closed when a sync child, marker, or raw spawn hit changes", () => {
		const manifest = JSON.parse(
			readFileSync(MANIFEST_PATH, "utf8"),
		) as Manifest;
		expect(manifest).toMatchObject({ version: 1, issue: "FLY-2331" });
		expect(new Set(manifest.entries.map((entry) => entry.file)).size).toBe(
			manifest.entries.length,
		);
		expect(
			manifest.entries.every((entry) => entry.disposition.trim().length > 0),
		).toBe(true);

		const expected = manifest.entries.map(
			({ disposition: _, ...entry }) => entry,
		);
		const actual = sweep().map(({ disposition: _, ...entry }) => entry);
		expect(actual).toEqual(expected);
	});
});
