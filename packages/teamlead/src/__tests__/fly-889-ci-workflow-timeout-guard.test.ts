/**
 * FLY-889 regression guard — the Build & Test job's `timeout-minutes` gave
 * near-zero headroom at 10 (the suite runs ~10-11min), so ~half of runs got
 * force-cancelled by the runner, not by a real test failure — and that
 * cancellation MASKED a real bug once (FLY-882: retry-after-cancel is what
 * surfaced it). FLY-889 raised the ceiling to 20 and merged the three
 * `apt-get update && apt-get install` steps (tmux/lsof/sqlite3) into one, to
 * stop losing ~15-20s of headroom to repeated `apt-get update` calls. Both
 * are pure YAML-structure invariants with no runtime code path, so this test
 * parses the repo's real `.github/workflows/ci.yml` (not a synthetic fixture)
 * to catch a silent revert — mirrors the R4-2 pattern in
 * `workflow-permissions.test.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/** Walk up from this test file to the repo root (the dir holding .github). */
function findRepoRoot(): string | undefined {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, ".github", "workflows", "ci.yml"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function loadBuildAndTestJob(): Record<string, unknown> | undefined {
	const root = findRepoRoot();
	if (!root) return undefined;
	const content = readFileSync(
		join(root, ".github", "workflows", "ci.yml"),
		"utf8",
	);
	const doc = parseYaml(content) as Record<string, unknown>;
	const jobs = doc.jobs as Record<string, unknown> | undefined;
	return jobs?.["build-and-test"] as Record<string, unknown> | undefined;
}

describe("FLY-889 regression guard — CI job timeout headroom + merged apt-get", () => {
	it("timeout-minutes stays at/above the 15min floor (pre-FLY-889 10min caused ~50% timeout-cancel)", () => {
		const job = loadBuildAndTestJob();
		if (!job) {
			// Sparse/standalone checkout without .github — nothing to regress here.
			expect(true).toBe(true);
			return;
		}
		expect(typeof job["timeout-minutes"]).toBe("number");
		expect(job["timeout-minutes"] as number).toBeGreaterThanOrEqual(15);
	});

	it("tmux/lsof/sqlite3 stay merged into ONE apt-get install (not re-fragmented into 3 separate `apt-get update` calls)", () => {
		const job = loadBuildAndTestJob();
		if (!job) {
			expect(true).toBe(true);
			return;
		}
		const steps = (job.steps ?? []) as Array<Record<string, unknown>>;
		const updateSteps = steps.filter((s) =>
			/apt-get\s+update/.test(String(s.run ?? "")),
		);
		expect(
			updateSteps,
			`expected exactly 1 step running \`apt-get update\`, found ${updateSteps.length}`,
		).toHaveLength(1);
		const run = String(updateSteps[0]?.run ?? "");
		for (const pkg of ["tmux", "lsof", "sqlite3"]) {
			expect(run).toMatch(new RegExp(`\\b${pkg}\\b`));
		}
	});
});
