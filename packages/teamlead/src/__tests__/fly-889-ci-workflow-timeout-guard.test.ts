/**
 * FLY-889 regression guard — the original Build & Test job's `timeout-minutes` gave
 * near-zero headroom at 10 (the suite runs ~10-11min), so ~half of runs got
 * force-cancelled by the runner, not by a real test failure — and that
 * cancellation MASKED a real bug once (FLY-882: retry-after-cancel is what
 * surfaced it). FLY-889 raised the ceiling to 20 and merged the dependency
 * setup (tmux/lsof/sqlite3) into one step. FLY-1905 later removed routine
 * update calls and bounded the remaining installer behind a shared helper. Both
 * are pure YAML-structure invariants with no runtime code path, so this test
 * parses the repo's real `.github/workflows/ci.yml` (not a synthetic fixture)
 * to catch a silent revert — mirrors the R4-2 pattern in
 * `workflow-permissions.test.ts`. FLY-1338 split that serial job into
 * independently scheduled unit and shell jobs, so this guard now follows the
 * long-running work. FLY-1861 moved the shell structure guard into the
 * always-on quick gate so a documentation-only skip can never bypass the
 * governance check that authorizes that skip shape.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const scriptShardIds = [
	"script-tests",
	"script-tests-2",
	"script-tests-3",
	"script-tests-4",
] as const;

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

describe("FLY-889/1905 regression guard — CI timeout headroom + bounded dependency setup", () => {
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
			["script-tests-2", 20],
			["script-tests-3", 20],
			["script-tests-4", 20],
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

	it("each script shard uses one bounded helper and no workflow step runs apt-get", () => {
		const jobs = loadCiJobs();
		if (!jobs) {
			expect(true).toBe(true);
			return;
		}
		for (const jobId of scriptShardIds) {
			const job = jobs[jobId] as Record<string, unknown> | undefined;
			expect(job, `ci.yml exists but jobs.${jobId} is missing`).toBeDefined();
			const steps = (job?.steps ?? []) as Array<Record<string, unknown>>;
			const helperSteps = steps.filter((step) =>
				/\bbash scripts\/ci-apt-install\.sh(?:\s|$)/.test(
					String(step.run ?? ""),
				),
			);
			expect(
				helperSteps,
				`${jobId}: expected exactly 1 ci-apt-install helper step, found ${helperSteps.length}`,
			).toHaveLength(1);
			const run = String(helperSteps[0]?.run ?? "");
			for (const pkg of ["tmux", "lsof", "sqlite3", "ripgrep"]) {
				expect(run).toMatch(new RegExp(`\\b${pkg}\\b`));
			}
			expect(helperSteps[0]?.["timeout-minutes"]).toBeGreaterThan(0);
			expect(helperSteps[0]?.["timeout-minutes"]).toBeLessThanOrEqual(8);
		}

		const allRuns = Object.values(jobs).flatMap((value) => {
			const job = value as Record<string, unknown>;
			return ((job.steps ?? []) as Array<Record<string, unknown>>).map((step) =>
				String(step.run ?? ""),
			);
		});
		expect(allRuns.some((run) => run.includes("apt-get"))).toBe(false);
	});

	it("quick-gate runs the FLY-1338/1861 structure guard as an always-on required step", () => {
		const jobs = loadCiJobs();
		if (!jobs) {
			expect(true).toBe(true);
			return;
		}
		const job = jobs["quick-gate"] as Record<string, unknown> | undefined;
		expect(job, "ci.yml exists but jobs.quick-gate is missing").toBeDefined();
		expect(job).not.toHaveProperty("if");
		expect(job).not.toHaveProperty("needs");
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

	it("CI OK requires all script shards", () => {
		const jobs = loadCiJobs();
		if (!jobs) {
			expect(true).toBe(true);
			return;
		}
		const ciOk = jobs["ci-ok"] as Record<string, unknown> | undefined;
		expect(ciOk, "ci.yml exists but jobs.ci-ok is missing").toBeDefined();
		expect(ciOk?.needs).toEqual(expect.arrayContaining([...scriptShardIds]));
	});
});
