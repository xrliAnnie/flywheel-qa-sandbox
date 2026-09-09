import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(
	fileURLToPath(new URL("../../../../", import.meta.url)),
);
const SHADOW_FACT =
	/auto_merge_shadow_observation|auto_merge_shadow_declaration|recordAutoMergeShadow|listAutoMergeShadow|buildShadowObservation/;
const ALLOWED = new Set([
	"engineering/doc/FLY-2398-auto-merge-shadow-run/shadow-table.sql",
	"packages/teamlead/src/StateStore.ts",
	"packages/teamlead/src/auto-merge-shadow/observation.ts",
	"packages/teamlead/src/bridge/auto-merge-shadow-route.ts",
	"scripts/fly-2398-shadow-table.mjs",
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
		if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(entry.name)) return [];
		return entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))
			? [entryPath]
			: [];
	});
}

describe("FLY-2398 auto-merge shadow isolation", () => {
	it("freezes every production reader and writer in the audited observation boundary", () => {
		const references = [
			...sourceFiles(resolve(REPO_ROOT, "packages")),
			...sourceFiles(resolve(REPO_ROOT, "scripts")),
			resolve(
				REPO_ROOT,
				"engineering/doc/FLY-2398-auto-merge-shadow-run/shadow-table.sql",
			),
		]
			.filter((file) => SHADOW_FACT.test(readFileSync(file, "utf8")))
			.map((file) => relative(REPO_ROOT, file))
			.sort();

		expect(references).toEqual([...ALLOWED].sort());
		for (const authorizationReader of [
			"land-executor",
			"approval-signal",
			"post-ship-finalization",
			"external-merge-reconcile",
			"review-hold",
			"gate-poller",
			"run-ship-relevance",
			"strength-two",
		]) {
			expect(
				references.some((file) => file.includes(authorizationReader)),
			).toBe(false);
		}
	});

	it("does not expose the shadow facts to review-hold or the founder merge guard", () => {
		for (const path of [
			"packages/teamlead/src/bridge/review-hold.ts",
			"packages/teamlead/src/bridge/run-ship-relevance.ts",
			"packages/teamlead/src/bridge/post-ship-finalization.ts",
		]) {
			expect(readFileSync(resolve(REPO_ROOT, path), "utf8")).not.toMatch(
				SHADOW_FACT,
			);
		}
	});
});
