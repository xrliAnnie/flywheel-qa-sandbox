import { describe, expect, it, vi } from "vitest";
import {
	createGitHubCliSummaryMergeGitHub,
	mergeSummaryPullRequest,
	reduceSummaryMergeReceipts,
} from "../summary-pr-merge.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const PATH = "summaries/flywheel/2026-08-28--eng-lead--01.md";
const CONTENT = `---
project: flywheel
lead: eng-lead
period: 2026-08-21/2026-08-28
---
## Facts
FLY-2131 entered implementation.
## Judgment
The summary merge fence is required before Raya activation.
`;

function github(overrides: Record<string, unknown> = {}) {
	return {
		readPullRequest: vi.fn(async () => ({
			headSha: SHA,
			state: "open" as const,
			merged: false,
			baseRepo: "xrliAnnie/raya",
			baseRef: "main",
		})),
		readRepository: vi.fn(async () => ({
			defaultBranch: "main",
			enabledMergeMethods: ["merge", "squash", "rebase"] as const,
		})),
		listPullRequestFiles: vi.fn(async () => [{ path: PATH, status: "added" }]),
		readTreeModes: vi.fn(async () => new Map([[PATH, "100644"]])),
		readFileAtRef: vi.fn(async () => CONTENT),
		mergePullRequest: vi.fn(async () => undefined),
		...overrides,
	};
}

function deps(gh = github()) {
	return {
		env: { FLYWHEEL_SUMMARY_GRANULARITY: "per-lead" },
		cwd: "/lead-workspace",
		github: gh,
		readLedger: vi.fn(() => ""),
		appendLedgerRow: vi.fn(),
		now: () => "2026-08-29T01:00:00.000Z",
	};
}

describe("summary merge safety fence", () => {
	it("binds the only merge call to the exact verified head and records arrays", async () => {
		const gh = github();
		const d = deps(gh);
		await expect(
			mergeSummaryPullRequest(
				{
					repo: "xrliAnnie/raya",
					prNumber: 7,
					roundId: "round-7",
				},
				d,
			),
		).resolves.toMatchObject({ action: "merged", verifiedHeadSha: SHA });
		expect(gh.mergePullRequest).toHaveBeenCalledExactlyOnceWith({
			repo: "xrliAnnie/raya",
			prNumber: 7,
			verifiedHeadSha: SHA,
			method: "merge",
		});
		expect(d.appendLedgerRow).toHaveBeenCalledExactlyOnceWith(
			"/lead-workspace/state/summary-merge-receipts.jsonl",
			expect.objectContaining({
				type: "merge",
				roundId: "round-7",
				repo: "xrliAnnie/raya",
				pr: 7,
				projects: ["flywheel"],
				files: [PATH],
				verifiedHeadSha: SHA,
				method: "merge",
			}),
		);
	});

	it.each(["xrliAnnie/other", "geoforge3d/project"])(
		"rejects forbidden repository %s before GitHub transport",
		async (repo) => {
			const gh = github();
			await expect(
				mergeSummaryPullRequest({ repo, prNumber: 7 }, deps(gh)),
			).rejects.toThrow(/summary_merge_repo_forbidden/);
			expect(gh.readPullRequest).not.toHaveBeenCalled();
			expect(gh.mergePullRequest).not.toHaveBeenCalled();
		},
	);

	it("fails closed when granularity is unselected", async () => {
		const gh = github();
		const d = deps(gh);
		d.env = {};
		await expect(
			mergeSummaryPullRequest({ repo: "xrliAnnie/raya", prNumber: 7 }, d),
		).rejects.toThrow(/summary_granularity_invalid/);
		expect(gh.readPullRequest).not.toHaveBeenCalled();
	});

	it.each([
		{ baseRepo: "fork/raya", baseRef: "main" },
		{ baseRepo: "xrliAnnie/raya", baseRef: "release" },
	])("rejects a fork or non-default base: %j", async (base) => {
		const gh = github({
			readPullRequest: vi.fn(async () => ({
				headSha: SHA,
				state: "open" as const,
				merged: false,
				...base,
			})),
		});
		await expect(
			mergeSummaryPullRequest(
				{ repo: "xrliAnnie/raya", prNumber: 7 },
				deps(gh),
			),
		).rejects.toThrow(/summary_merge_base_forbidden/);
		expect(gh.mergePullRequest).not.toHaveBeenCalled();
	});

	it("does not merge or retry when verification or the head fence fails", async () => {
		const invalid = github({
			listPullRequestFiles: vi.fn(async () => [
				{ path: "scripts/pwn.sh", status: "added" },
			]),
		});
		await expect(
			mergeSummaryPullRequest(
				{ repo: "xrliAnnie/raya", prNumber: 7 },
				deps(invalid),
			),
		).rejects.toThrow(/summary_pr_path_unsafe/);
		expect(invalid.mergePullRequest).not.toHaveBeenCalled();

		const moved = github();
		moved.readPullRequest
			.mockResolvedValueOnce({
				headSha: SHA,
				state: "open",
				merged: false,
				baseRepo: "xrliAnnie/raya",
				baseRef: "main",
			})
			.mockResolvedValueOnce({
				headSha: OTHER_SHA,
				state: "open",
				merged: false,
				baseRepo: "xrliAnnie/raya",
				baseRef: "main",
			});
		await expect(
			mergeSummaryPullRequest(
				{ repo: "xrliAnnie/raya", prNumber: 7 },
				deps(moved),
			),
		).rejects.toThrow(/summary_merge_pr_changed_during_verification/);
		expect(moved.mergePullRequest).not.toHaveBeenCalled();

		const rejected = github({
			mergePullRequest: vi.fn(async () => {
				throw new Error("head commit changed");
			}),
		});
		await expect(
			mergeSummaryPullRequest(
				{ repo: "xrliAnnie/raya", prNumber: 7 },
				deps(rejected),
			),
		).rejects.toThrow(/head commit changed/);
		expect(rejected.mergePullRequest).toHaveBeenCalledTimes(1);
	});

	it("reconciles a compliant merged PR without calling merge, then no-ops", async () => {
		const gh = github({
			readPullRequest: vi.fn(async () => ({
				headSha: SHA,
				state: "closed" as const,
				merged: true,
				baseRepo: "xrliAnnie/raya",
				baseRef: "main",
			})),
		});
		const d = deps(gh);
		await expect(
			mergeSummaryPullRequest({ repo: "xrliAnnie/raya", prNumber: 7 }, d),
		).resolves.toMatchObject({ action: "reconciled" });
		expect(gh.mergePullRequest).not.toHaveBeenCalled();
		expect(d.appendLedgerRow).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ reconciled: true, method: null }),
		);

		d.readLedger.mockReturnValue(
			`${JSON.stringify({ type: "merge", repo: "xrliAnnie/raya", pr: 7, verifiedHeadSha: SHA })}\n`,
		);
		d.appendLedgerRow.mockClear();
		await expect(
			mergeSummaryPullRequest({ repo: "xrliAnnie/raya", prNumber: 7 }, d),
		).resolves.toMatchObject({ action: "already-recorded" });
		expect(d.appendLedgerRow).not.toHaveBeenCalled();
	});

	it("fails a closed-unmerged or historically noncompliant PR without a receipt", async () => {
		const closed = github({
			readPullRequest: vi.fn(async () => ({
				headSha: SHA,
				state: "closed" as const,
				merged: false,
				baseRepo: "xrliAnnie/raya",
				baseRef: "main",
			})),
		});
		await expect(
			mergeSummaryPullRequest(
				{ repo: "xrliAnnie/raya", prNumber: 7 },
				deps(closed),
			),
		).rejects.toThrow(/summary_merge_pr_closed/);

		const badHistory = github({
			readPullRequest: vi.fn(async () => ({
				headSha: SHA,
				state: "closed" as const,
				merged: true,
				baseRepo: "xrliAnnie/raya",
				baseRef: "main",
			})),
			readFileAtRef: vi.fn(async () =>
				CONTENT.replace("## Judgment", "## Notes"),
			),
		});
		const d = deps(badHistory);
		await expect(
			mergeSummaryPullRequest({ repo: "xrliAnnie/raya", prNumber: 7 }, d),
		).rejects.toThrow(/Judgment/);
		expect(d.appendLedgerRow).not.toHaveBeenCalled();
	});

	it("requires an enabled target-repo method and never computes a cross-repo intersection", async () => {
		const gh = github({
			readRepository: vi.fn(async () => ({
				defaultBranch: "main",
				enabledMergeMethods: ["squash"] as const,
			})),
		});
		await expect(
			mergeSummaryPullRequest(
				{ repo: "xrliAnnie/raya", prNumber: 7 },
				deps(gh),
			),
		).rejects.toThrow(/summary_merge_method_disabled.*squash/);
		await expect(
			mergeSummaryPullRequest(
				{
					repo: "xrliAnnie/raya",
					prNumber: 7,
					method: "squash",
				},
				deps(gh),
			),
		).resolves.toMatchObject({ action: "merged", method: "squash" });
	});

	it("dry-runs open and merged states with zero merge and zero writes", async () => {
		for (const merged of [false, true]) {
			const gh = github({
				readPullRequest: vi.fn(async () => ({
					headSha: SHA,
					state: merged ? ("closed" as const) : ("open" as const),
					merged,
					baseRepo: "xrliAnnie/raya",
					baseRef: "main",
				})),
			});
			const d = deps(gh);
			await expect(
				mergeSummaryPullRequest(
					{ repo: "xrliAnnie/raya", prNumber: 7, dryRun: true },
					d,
				),
			).resolves.toMatchObject({ dryRun: true });
			expect(gh.mergePullRequest).not.toHaveBeenCalled();
			expect(d.appendLedgerRow).not.toHaveBeenCalled();
		}
	});

	it("surfaces a post-merge receipt failure with the merge fact", async () => {
		const gh = github();
		const d = deps(gh);
		d.appendLedgerRow.mockImplementation(() => {
			throw new Error("disk full");
		});
		await expect(
			mergeSummaryPullRequest({ repo: "xrliAnnie/raya", prNumber: 7 }, d),
		).rejects.toMatchObject({
			message: expect.stringContaining("summary_receipt_write_failed"),
			mergeOccurred: true,
			verifiedHeadSha: SHA,
		});
	});

	it("deduplicates repeated physical receipt rows by repo, PR, and verified head", () => {
		expect(
			reduceSummaryMergeReceipts([
				{ type: "merge", repo: "xrliAnnie/raya", pr: 7, verifiedHeadSha: SHA },
				{ type: "merge", repo: "xrliAnnie/raya", pr: 7, verifiedHeadSha: SHA },
				{ type: "round", roundId: "round-7", reviewedPrs: [7] },
			]).map(({ repo, pr, verifiedHeadSha }) => ({
				repo,
				pr,
				verifiedHeadSha,
			})),
		).toEqual([{ repo: "xrliAnnie/raya", pr: 7, verifiedHeadSha: SHA }]);
	});
});

describe("summary merge GitHub CLI adapter", () => {
	it("always emits --match-head-commit with the supplied verified SHA", async () => {
		const run = vi.fn(() => "");
		const adapter = createGitHubCliSummaryMergeGitHub({ run });
		await adapter.mergePullRequest({
			repo: "xrliAnnie/raya",
			prNumber: 7,
			verifiedHeadSha: SHA,
			method: "rebase",
		});
		expect(run).toHaveBeenCalledExactlyOnceWith([
			"pr",
			"merge",
			"7",
			"--repo",
			"xrliAnnie/raya",
			"--match-head-commit",
			SHA,
			"--rebase",
		]);
	});
});
