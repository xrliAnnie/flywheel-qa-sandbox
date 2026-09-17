import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { GitLandContentReviewer } from "../land-content-review.js";

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function remoteFixture(): { projectRoot: string; head: string } {
	const root = mkdtempSync(join(tmpdir(), "fly2632-review-"));
	roots.push(root);
	const remote = join(root, "remote.git");
	const projectRoot = join(root, "work");
	git(root, ["init", "--bare", remote]);
	git(root, ["init", projectRoot]);
	git(projectRoot, ["config", "user.email", "test@example.com"]);
	git(projectRoot, ["config", "user.name", "Test"]);
	writeFileSync(join(projectRoot, "feature.ts"), "export const value = 1;\n");
	git(projectRoot, ["add", "feature.ts"]);
	git(projectRoot, ["commit", "-m", "feature"]);
	const head = git(projectRoot, ["rev-parse", "HEAD"]);
	git(projectRoot, ["remote", "add", "origin", remote]);
	git(projectRoot, ["push", "origin", `HEAD:refs/pull/2632/head`]);
	return { projectRoot, head };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("GitLandContentReviewer", () => {
	it("reviews a detached exact-C checkout and records cross-family approval", async () => {
		const { projectRoot, head } = remoteFixture();
		const store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "implement-c",
			issue_id: "FLY-2632",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex",
		});
		const reviewRound = vi.fn().mockImplementation(async ({ cwd }) => ({
			kind: "verdict" as const,
			verdict: "APPROVED" as const,
			findings: [],
			reviewedHeadSha: git(cwd, ["rev-parse", "HEAD"]),
			repairedTrailingBrace: false,
			raw: "approved",
		}));
		const reviewer = new GitLandContentReviewer(
			store,
			() => projectRoot,
			reviewRound,
		);
		const result = await reviewer.ensureReview({
			runId: "run-c",
			issueId: "FLY-2632",
			projectName: "flywheel",
			prNumber: 2632,
			headSha: head,
			executionId: "implement-c",
			repoIdentity: "__main__",
		});
		expect(result).toMatchObject({
			status: "approved",
			executionId: "implement-c",
			requestId: expect.stringMatching(/^land-content-review:/),
		});
		expect(reviewRound).toHaveBeenCalledOnce();
		expect(
			store.getCodexReviewRecord("implement-c", "__main__", head),
		).toMatchObject({
			status: "approved",
			author_family: "codex",
			reviewer_family: "claude",
			request_id: result.requestId,
		});
		store.close();
	});

	it("rejects codex-skip before invoking any reviewer", async () => {
		const store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "implement-skip",
			issue_id: "FLY-2632",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex",
			codex_skip: 1,
		});
		const reviewRound = vi.fn();
		const reviewer = new GitLandContentReviewer(
			store,
			() => "/unused",
			reviewRound,
		);
		await expect(
			reviewer.ensureReview({
				runId: "run-skip",
				issueId: "FLY-2632",
				projectName: "flywheel",
				prNumber: 2632,
				headSha: "a".repeat(40),
				executionId: "implement-skip",
				repoIdentity: "__main__",
			}),
		).resolves.toMatchObject({
			status: "rejected",
			reason: "content_carryover_review_skipped",
		});
		expect(reviewRound).not.toHaveBeenCalled();
		store.close();
	});
});
