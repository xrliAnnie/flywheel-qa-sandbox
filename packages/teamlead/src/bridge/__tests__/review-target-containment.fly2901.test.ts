/**
 * FLY-2901 §6: nested review targets now live under the git-excluded
 * `.flywheel/review-targets/<repo>/` of the bound worktree. The strict
 * containment check in `resolveReviewTarget` is deliberately unchanged — this
 * pins that the new location still passes it and that escapes still fail.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveReviewTarget } from "../review-request-coordinator.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function boundWorktreeWithTarget() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fly2901-review-")));
	roots.push(root);
	const worktree = join(root, "flywheel-FLY-2901");
	mkdirSync(worktree);
	git(worktree, "init", "--quiet", "--initial-branch=main");
	const target = join(worktree, ".flywheel", "review-targets", "other");
	mkdirSync(target, { recursive: true });
	git(target, "init", "--quiet", "--initial-branch=main");
	git(target, "remote", "add", "origin", "https://github.com/acme/other.git");
	const outside = join(root, "outside");
	mkdirSync(outside);
	git(outside, "init", "--quiet", "--initial-branch=main");
	return { worktree, target, outside };
}

describe("FLY-2901 resolveReviewTarget containment", () => {
	it("accepts a nested target under .flywheel/review-targets/<repo>", async () => {
		const { worktree, target } = boundWorktreeWithTarget();
		await expect(
			resolveReviewTarget(worktree, ".flywheel/review-targets/other"),
		).resolves.toEqual({ path: target, identity: "acme/other" });
	});

	it("still refuses a target outside the bound worktree", async () => {
		const { worktree } = boundWorktreeWithTarget();
		await expect(resolveReviewTarget(worktree, "../outside")).rejects.toThrow(
			"target must be strictly contained in the bound worktree",
		);
	});
});
