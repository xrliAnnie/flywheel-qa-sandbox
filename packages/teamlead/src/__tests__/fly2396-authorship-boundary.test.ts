import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(
	fileURLToPath(new URL("../../../../", import.meta.url)),
);
const AUTHORITY_FACT =
	/workflow_founder_gate_verdict|founder_authored|listFounderGateVerdicts/;
const ALLOWED = new Set([
	"engineering/doc/FLY-2396-founder-gate-head-origin/retro-bind.sql",
	"packages/teamlead/src/StateStore.ts",
	"scripts/fly-2398-shadow-table.mjs",
	"scripts/fly2396-retro-report.mjs",
	"scripts/lib/fly-2006-retention-registry.mjs",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".sql"]);
const IGNORED_DIRECTORIES = new Set([
	".git",
	".next",
	".turbo",
	"__tests__",
	"coverage",
	"dist",
	"node_modules",
]);

function sourceFiles(path: string): string[] {
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = join(path, entry.name);
		if (entry.isDirectory()) {
			return IGNORED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(entryPath);
		}
		return entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))
			? [entryPath]
			: [];
	});
}

describe("FLY-2396 authorship fact isolation", () => {
	it("allows only the narrow core to consume authorship as a negative veto", () => {
		const references = [
			...sourceFiles(resolve(REPO_ROOT, "packages")),
			...sourceFiles(resolve(REPO_ROOT, "scripts")),
			resolve(
				REPO_ROOT,
				"engineering/doc/FLY-2396-founder-gate-head-origin/retro-bind.sql",
			),
		]
			.filter((file) => AUTHORITY_FACT.test(readFileSync(file, "utf8")))
			.map((file) => relative(REPO_ROOT, file))
			.sort();
		expect(references).toEqual([...ALLOWED].sort());
		for (const forbidden of [
			"land-executor",
			"approval-signal",
			"post-ship-finalization",
			"external-merge-reconcile",
		]) {
			expect(references.some((file) => file.includes(forbidden))).toBe(false);
		}
		const stateStore = readFileSync(
			resolve(REPO_ROOT, "packages/teamlead/src/StateStore.ts"),
			"utf8",
		);
		expect(stateStore).toContain(
			"lower(v.head_sha) = lower(?) AND v.verdict = 'rework'\n\t\t\t\t    AND v.founder_authored = 1 LIMIT 1",
		);
		expect(stateStore).not.toMatch(
			/founder_authored = 1[^;]+predicate[^;]+founder_approved/s,
		);
	});
});
