import { describe, expect, it, vi } from "vitest";
import {
	createGitHubCliSummaryVerifier,
	verifySummaryPullRequest,
} from "../summary-pr-verifier.js";

const valid = `---
project: flywheel
lead: eng-lead
period: 2026-08-21/2026-08-28
---
## Facts
FLY-2030 entered implementation.
## Judgment
The inflow contract is the critical path.
`;

function github(overrides: Record<string, unknown> = {}) {
	return {
		readPullRequest: vi.fn(async () => ({ headSha: "a".repeat(40) })),
		listPullRequestFiles: vi.fn(async () => [
			{
				path: "summaries/flywheel/2026-08-28--eng-lead--01.md",
				status: "added",
			},
		]),
		readTreeModes: vi.fn(
			async () =>
				new Map([["summaries/flywheel/2026-08-28--eng-lead--01.md", "100644"]]),
		),
		readFileAtRef: vi.fn(async () => valid),
		...overrides,
	};
}

describe("Raya summary PR read-only verifier", () => {
	it("the production adapter slurps every PR-files page", async () => {
		const run = vi.fn((args: string[]) => {
			if (args.includes("--paginate")) {
				return JSON.stringify([
					[{ filename: "summaries/a/2026-08-28--x--01.md", status: "added" }],
					[
						{
							filename: "summaries/b/2026-08-28--y--01.md",
							status: "modified",
						},
					],
				]);
			}
			throw new Error(`unexpected call: ${args.join(" ")}`);
		});
		const adapter = createGitHubCliSummaryVerifier({ run });
		await expect(
			adapter.listPullRequestFiles("xrliAnnie/raya", 7),
		).resolves.toEqual([
			{ path: "summaries/a/2026-08-28--x--01.md", status: "added" },
			{ path: "summaries/b/2026-08-28--y--01.md", status: "modified" },
		]);
		expect(run.mock.calls[0]![0]).toContain("--slurp");
	});

	it("the production adapter fails closed on a truncated recursive tree", async () => {
		const adapter = createGitHubCliSummaryVerifier({
			run: vi.fn(() => JSON.stringify({ truncated: true, tree: [] })),
		});
		await expect(
			adapter.readTreeModes("xrliAnnie/raya", "a".repeat(40)),
		).rejects.toThrow(/truncated/);
	});

	it("validates the complete current-head diff and returns that exact SHA", async () => {
		const gh = github();
		await expect(
			verifySummaryPullRequest(
				{ repo: "xrliAnnie/raya", prNumber: 7, granularity: "per-lead" },
				gh,
			),
		).resolves.toEqual({
			ok: true,
			verifiedHeadSha: "a".repeat(40),
			fileCount: 1,
		});
		expect(gh.listPullRequestFiles).toHaveBeenCalledWith("xrliAnnie/raya", 7);
	});

	it("rejects an extra path even when one valid summary exists", async () => {
		const gh = github({
			listPullRequestFiles: vi.fn(async () => [
				{
					path: "summaries/flywheel/2026-08-28--eng-lead--01.md",
					status: "added",
				},
				{ path: ".github/workflows/ship.yml", status: "added" },
			]),
		});
		await expect(
			verifySummaryPullRequest(
				{ repo: "xrliAnnie/raya", prNumber: 7, granularity: "per-lead" },
				gh,
			),
		).rejects.toThrow(/prefix|path/);
	});

	it("rejects executable markdown and non-enumerated runtime-affecting objects by git mode", async () => {
		for (const mode of ["100755", "120000", "160000"]) {
			const gh = github({
				readTreeModes: vi.fn(
					async () =>
						new Map([["summaries/flywheel/2026-08-28--eng-lead--01.md", mode]]),
				),
			});
			await expect(
				verifySummaryPullRequest(
					{ repo: "xrliAnnie/raya", prNumber: 7, granularity: "per-lead" },
					gh,
				),
			).rejects.toThrow(/mode/);
		}
	});

	it("rejects removed files and empty Judgment", async () => {
		await expect(
			verifySummaryPullRequest(
				{ repo: "xrliAnnie/raya", prNumber: 7, granularity: "per-lead" },
				github({
					listPullRequestFiles: vi.fn(async () => [
						{
							path: "summaries/flywheel/2026-08-28--eng-lead--01.md",
							status: "removed",
						},
					]),
				}),
			),
		).rejects.toThrow(/status/);
		await expect(
			verifySummaryPullRequest(
				{ repo: "xrliAnnie/raya", prNumber: 7, granularity: "per-lead" },
				github({
					readFileAtRef: vi.fn(async () =>
						valid.replace("The inflow contract is the critical path.", "   "),
					),
				}),
			),
		).rejects.toThrow(/Judgment/);
	});
});
