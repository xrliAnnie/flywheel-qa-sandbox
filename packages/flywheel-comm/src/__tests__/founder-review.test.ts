import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeFounderArtifactDigest,
	type FounderReviewRoundRecord,
	inspectCommittedFounderReviewArtifacts,
	inspectFounderReviewArtifactsAtCommit,
	resolveFounderReviewVerdict,
} from "../founder-review.js";

const ARTIFACT_A = computeFounderArtifactDigest([
	{ path: "product/doc/FLY-1/review.html", blobSha: "a".repeat(40) },
]);
const ARTIFACT_B = computeFounderArtifactDigest([
	{ path: "product/doc/FLY-1/review.html", blobSha: "b".repeat(40) },
]);

function round(input: {
	questionId: string;
	serverOrder: number;
	runId?: string;
	digest?: string;
	response?: { fromAgent: string; passed: boolean };
}): FounderReviewRoundRecord {
	const runId = input.runId ?? "run-1";
	const digest = input.digest ?? ARTIFACT_A;
	return {
		questionId: input.questionId,
		checkpoint: "founder_review",
		ownerExecutionId: `exec-${input.questionId}`,
		ownerRunId: runId,
		serverOrder: input.serverOrder,
		supersededAt: null,
		questionContent: JSON.stringify({
			version: 1,
			round: input.serverOrder,
			runId,
			artifactDigest: digest,
			hostedUrl: "https://reports.example/review",
			paths: ["product/doc/FLY-1/review.html"],
		}),
		response: input.response
			? {
					fromAgent: input.response.fromAgent,
					content: JSON.stringify({
						version: 1,
						passed: input.response.passed,
						artifactDigest: digest,
					}),
				}
			: undefined,
	};
}

describe("founder_review run verdict", () => {
	it("passes only when the latest current-artifact round has a trusted founder pass", () => {
		const result = resolveFounderReviewVerdict({
			runId: "run-1",
			authoritativeArtifactDigest: ARTIFACT_A,
			founderId: "123456789012345678",
			rounds: [
				round({
					questionId: "q1",
					serverOrder: 1,
					response: { fromAgent: "123456789012345678", passed: true },
				}),
			],
		});
		expect(result).toEqual({
			status: "passed",
			questionId: "q1",
			artifactDigest: ARTIFACT_A,
		});
	});

	it.each([
		["newer pending", undefined],
		["newer rejected", { fromAgent: "123456789012345678", passed: false }],
	])("does not reuse an older pass after a %s round", (_name, response) => {
		const result = resolveFounderReviewVerdict({
			runId: "run-1",
			authoritativeArtifactDigest: ARTIFACT_A,
			founderId: "123456789012345678",
			rounds: [
				round({
					questionId: "q1",
					serverOrder: 1,
					response: { fromAgent: "bridge", passed: true },
				}),
				round({ questionId: "q2", serverOrder: 2, response }),
			],
		});
		expect(result).toMatchObject({ status: "not_passed", questionId: "q2" });
	});

	it("fails closed for cross-run, Lead-attributed, and stale-artifact evidence", () => {
		const founderId = "123456789012345678";
		expect(
			resolveFounderReviewVerdict({
				runId: "run-1",
				authoritativeArtifactDigest: ARTIFACT_A,
				founderId,
				rounds: [
					round({
						questionId: "foreign",
						serverOrder: 1,
						runId: "run-old",
						response: { fromAgent: founderId, passed: true },
					}),
				],
			}),
		).toMatchObject({ status: "missing" });
		expect(
			resolveFounderReviewVerdict({
				runId: "run-1",
				authoritativeArtifactDigest: ARTIFACT_A,
				founderId,
				rounds: [
					round({
						questionId: "lead",
						serverOrder: 1,
						response: { fromAgent: "flywheel-product-lead", passed: true },
					}),
				],
			}),
		).toMatchObject({ status: "not_passed", questionId: "lead" });
		expect(
			resolveFounderReviewVerdict({
				runId: "run-1",
				authoritativeArtifactDigest: ARTIFACT_B,
				founderId,
				rounds: [
					round({
						questionId: "stale",
						serverOrder: 1,
						response: { fromAgent: founderId, passed: true },
					}),
				],
			}),
		).toMatchObject({ status: "stale_artifact", questionId: "stale" });
	});
});

describe("founder_review committed HTML evidence", () => {
	it("binds only a clean HTML blob from Git HEAD", () => {
		const repo = mkdtempSync(join(tmpdir(), "fly1758-artifact-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: repo });
			writeFileSync(join(repo, "review.html"), "<main>v1</main>");
			execFileSync("git", ["add", "review.html"], { cwd: repo });
			execFileSync(
				"git",
				[
					"-c",
					"user.name=Test",
					"-c",
					"user.email=test@example.com",
					"commit",
					"-qm",
					"review",
				],
				{ cwd: repo },
			);

			const blobs = inspectCommittedFounderReviewArtifacts({
				cwd: repo,
				paths: [join(repo, "review.html")],
			});
			expect(blobs).toEqual([
				{
					path: "review.html",
					blobSha: expect.stringMatching(/^[0-9a-f]{40,64}$/),
				},
			]);

			writeFileSync(join(repo, "review.html"), "<main>uncommitted</main>");
			expect(() =>
				inspectCommittedFounderReviewArtifacts({
					cwd: repo,
					paths: ["review.html"],
				}),
			).toThrow(/must be committed and clean/i);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("binds authority to HTML blobs, not unrelated HEAD movement", () => {
		const repo = mkdtempSync(join(tmpdir(), "fly1758-head-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
		const commit = (message: string) => {
			git("add", ".");
			git(
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-qm",
				message,
			);
			return git("rev-parse", "HEAD");
		};
		try {
			git("init", "-q");
			writeFileSync(join(repo, "review.html"), "<main>v1</main>");
			const htmlHead = commit("html v1");
			writeFileSync(join(repo, "progress.md"), "cursor 1");
			const progressHead = commit("progress");
			writeFileSync(join(repo, "review.html"), "<main>v2</main>");
			const changedHtmlHead = commit("html v2");

			const digestAt = (head: string) =>
				computeFounderArtifactDigest(
					inspectFounderReviewArtifactsAtCommit({
						repoRoot: repo,
						head,
						paths: ["review.html"],
					}),
				);
			expect(digestAt(progressHead)).toBe(digestAt(htmlHead));
			expect(digestAt(changedHtmlHead)).not.toBe(digestAt(htmlHead));
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("rejects missing, non-HTML, and outside-repository artifacts", () => {
		const repo = mkdtempSync(join(tmpdir(), "fly1758-artifact-"));
		const outside = join(tmpdir(), `fly1758-outside-${Date.now()}.html`);
		try {
			execFileSync("git", ["init", "-q"], { cwd: repo });
			writeFileSync(join(repo, "notes.txt"), "not interactive");
			writeFileSync(outside, "<main>outside</main>");
			expect(() =>
				inspectCommittedFounderReviewArtifacts({
					cwd: repo,
					paths: [],
				}),
			).toThrow(/at least one/i);
			expect(() =>
				inspectCommittedFounderReviewArtifacts({
					cwd: repo,
					paths: ["notes.txt"],
				}),
			).toThrow(/html/i);
			expect(() =>
				inspectCommittedFounderReviewArtifacts({
					cwd: repo,
					paths: [outside],
				}),
			).toThrow(/inside the Git repository/i);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outside, { force: true });
		}
	});
});
