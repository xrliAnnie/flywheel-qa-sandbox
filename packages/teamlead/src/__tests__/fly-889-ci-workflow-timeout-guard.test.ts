/**
 * FLY-889 regression guard — the original Build & Test job's `timeout-minutes` gave
 * near-zero headroom at 10 (the suite runs ~10-11min), so ~half of runs got
 * force-cancelled by the runner, not by a real test failure — and that
 * cancellation MASKED a real bug once (FLY-882: retry-after-cancel is what
 * surfaced it). FLY-889 raised the ceiling to 20 and merged the three
 * `apt-get update && apt-get install` steps (tmux/lsof/sqlite3) into one, to
 * stop losing ~15-20s of headroom to repeated `apt-get update` calls. Both
 * are pure YAML-structure invariants with no runtime code path, so this test
 * parses the repo's real `.github/workflows/ci.yml` (not a synthetic fixture)
 * to catch a silent revert — mirrors the R4-2 pattern in
 * `workflow-permissions.test.ts`. FLY-1338 split that serial job into
 * independently scheduled unit and shell jobs, so this guard now follows the
 * long-running work and also proves the new shell structure guard stays wired
 * into CI.
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

function loadCiJobs(): Record<string, unknown> | undefined {
	const root = findRepoRoot();
	if (!root) return undefined;
	const content = readFileSync(
		join(root, ".github", "workflows", "ci.yml"),
		"utf8",
	);
	const doc = parseYaml(content) as Record<string, unknown>;
	return doc.jobs as Record<string, unknown> | undefined;
}

describe("FLY-889 regression guard — CI job timeout headroom + merged apt-get", () => {
	it("long-running jobs retain measured timeout headroom", () => {
		const jobs = loadCiJobs();
		if (!jobs) {
			// Sparse/standalone checkout without .github — nothing to regress here.
			expect(true).toBe(true);
			return;
		}
		const timeoutFloors = new Map([
			["unit-tests", 15],
			// FLY-1482: main reached 13m42s and the PR replay hit the old 15m cap.
			["script-tests", 20],
		]);
		for (const [jobId, timeoutFloor] of timeoutFloors) {
			const job = jobs[jobId] as Record<string, unknown> | undefined;
			expect(job, `ci.yml exists but jobs.${jobId} is missing`).toBeDefined();
			expect(typeof job?.["timeout-minutes"]).toBe("number");
			expect(job?.["timeout-minutes"] as number).toBeGreaterThanOrEqual(
				timeoutFloor,
			);
		}
	});

	it("script-tests keeps tmux/lsof/sqlite3 merged into one apt-get install", () => {
		const jobs = loadCiJobs();
		if (!jobs) {
			expect(true).toBe(true);
			return;
		}
		const job = jobs["script-tests"] as Record<string, unknown> | undefined;
		expect(job, "ci.yml exists but jobs.script-tests is missing").toBeDefined();
		const steps = (job?.steps ?? []) as Array<Record<string, unknown>>;
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

	it("script-tests runs the FLY-1338 structure guard as a required step", () => {
		const jobs = loadCiJobs();
		if (!jobs) {
			expect(true).toBe(true);
			return;
		}
		const job = jobs["script-tests"] as Record<string, unknown> | undefined;
		expect(job, "ci.yml exists but jobs.script-tests is missing").toBeDefined();
		const steps = (job?.steps ?? []) as Array<Record<string, unknown>>;
		const guardSteps = steps.filter((step) =>
			/\bbash\s+scripts\/__tests__\/ci-structure\.test\.sh\b/.test(
				String(step.run ?? ""),
			),
		);
		expect(
			guardSteps,
			"expected exactly one required CI structure guard step",
		).toHaveLength(1);
		expect(guardSteps[0]).not.toHaveProperty("if");
		expect(guardSteps[0]).not.toHaveProperty("continue-on-error");
	});
});
