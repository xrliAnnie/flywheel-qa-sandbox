import { expect, it, vi } from "vitest";
import { canonicalDigest, type ProjectSnapshot } from "../contract.js";
import { buildEvidenceLedger } from "../evidence-ledger.js";
import { collectProductionJudgment } from "../production-collect.js";
import { bindingFixture, CHANNEL, HEAD, NOW } from "./binding-fixture.js";
import { evidenceMaterials } from "./evidence-fixture.js";

it.each([
	"complete",
	"no_qa",
	"no_design",
	"semantic_throw",
	"no_snapshot",
	"git_failure",
	"diff_budget",
	"partial_snapshot",
	"refresh_throw",
	"expired_snapshot",
])(
	"retains independent material through production collection: %s",
	async (scenario) => {
		const { store } = await bindingFixture();
		try {
			const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
			const target = evidenceMaterials(binding, NOW).targets[0]!;
			const qaToken = "a".repeat(32);
			target.qaAuthority!.summary = `QA report: https://reports.vercel.app/r/${qaToken}/`;
			vi.spyOn(store, "readShipJudgmentDesignApproval").mockReturnValue(
				scenario === "no_design" ? undefined : target.designApproval,
			);
			vi.spyOn(store, "readShipJudgmentCodeReviewAtHead").mockReturnValue(
				target.codeReview,
			);
			vi.spyOn(store, "readShipJudgmentQaAuthority").mockReturnValue(
				scenario === "no_qa"
					? { verdict: "undetermined", reason: "evidence_missing" }
					: target.qaAuthority!,
			);
			const repositories = [
				{ repo_identity: "__main__", repo_slug: "owner/repo" },
			];
			const snapshot: ProjectSnapshot = {
				configurationDigest: canonicalDigest(repositories),
				repositories: [{ ...repositories[0]!, main_sha: "b".repeat(40) }],
				prs: [
					{
						repo_identity: "__main__",
						pr_number: 2399,
						head_sha: HEAD,
						base_sha: "b".repeat(40),
						base_ref: "main",
						filesComplete: true,
						files: [{ path: "fix.ts" }],
					},
				],
			};
			const dispose = vi.fn(async () => {}),
				diff = vi.fn(async () => {
					if (scenario === "diff_budget")
						throw new Error("git_input_read_failed", {
							cause: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
						});
					return target.diff!;
				}),
				readText = vi.fn(async () => target.planBlob!);
			const prepare = vi.fn(async () => {
				if (scenario === "git_failure") throw new Error("git failed");
				return {
					gitDir: "/tmp/fixture.git",
					dispose,
					material: {
						repoIdentity: "__main__",
						repoSlug: "owner/repo",
						prNumber: 2399,
						headSha: HEAD,
						diffBaseSha: "b".repeat(40),
						reader: () => ({ diff, readText, listTextFiles: async () => [] }),
					},
				};
			});
			const result = await collectProductionJudgment(
				"q",
				CHANNEL,
				{
					source: {
						store,
						linearApiKey: "fixture",
						planRepoIdentity: "__main__",
						registry: { readReportHtml: () => "<h1>QA passed</h1>" },
						hosting: { vercelProjectName: "reports" },
					},
					repositories,
					refresh: {
						metadata: async () =>
							scenario === "no_snapshot" ? undefined : snapshot,
						refresh: async () =>
							scenario === "refresh_throw"
								? Promise.reject(new Error("private refresh detail"))
								: ["no_snapshot", "partial_snapshot"].includes(scenario)
									? {
											status: "undetermined" as const,
											reason: "github_unavailable",
										}
									: { status: "ready" as const, snapshot },
					},
					currentSnapshot: () =>
						scenario === "expired_snapshot" ? undefined : snapshot,
					token: async () => "fixture",
					prepare,
					merge: async () => ({ verdict: "pass", reason: "merge_clean" }),
					now: () => Date.parse(NOW),
					collect: async () => {
						if (scenario === "semantic_throw")
							throw new Error("model packet failed");
						return { status: "undetermined", reason: "qa_report_unretained" };
					},
				},
				new AbortController().signal,
			);
			expect(result.collection.status).toBe("undetermined");
			expect(result.materials).toBeDefined();
			const ledger = buildEvidenceLedger(result.materials, binding);
			const targetLedger = ledger.targets[0]!;
			const unavailable = [
				"no_snapshot",
				"git_failure",
				"diff_budget",
				"partial_snapshot",
				"refresh_throw",
				"expired_snapshot",
			].includes(scenario);
			expect(targetLedger.c.verdict).toBe(
				scenario === "no_qa" || unavailable ? "undetermined" : "pass",
			);
			expect(targetLedger.a.verdict).toBe(
				scenario === "no_design" || unavailable ? "undetermined" : "pass",
			);
			// The independent authority material remains inspectable, but a
			// collection without a completed semantic evaluation cannot authorize.
			expect(ledger.alignment).toMatchObject({
				verdict: "undetermined",
				missing: expect.arrayContaining(["input"]),
			});
			expect(ledger.coverage).toMatchObject({
				verdict: "undetermined",
				missing: expect.arrayContaining(["input"]),
			});
			expect(ledger.conflict.verdict).toBe(
				[
					"no_snapshot",
					"partial_snapshot",
					"refresh_throw",
					"expired_snapshot",
					"git_failure",
				].includes(scenario)
					? "undetermined"
					: "pass",
			);
			if (!["no_snapshot", "git_failure"].includes(scenario)) {
				expect(prepare).toHaveBeenCalledTimes(1);
				expect(diff).toHaveBeenCalledTimes(1);
				expect(dispose).toHaveBeenCalledTimes(1);
			}
			if (scenario === "refresh_throw")
				expect(result.materials.input).toEqual({
					status: "unavailable",
					reason: "project_refresh_failed",
				});
			if (scenario === "expired_snapshot")
				expect(result.materials.input).toEqual({
					status: "unavailable",
					reason: "mechanical_snapshot_changed_or_expired",
				});
			if (scenario === "no_design")
				expect(targetLedger.a.missing).toEqual([
					"design_review",
					"plan_at_head",
				]);
			if (scenario === "diff_budget") {
				expect(targetLedger.a.missing).toEqual(["pr_diff", "input"]);
				expect(result.materials.targets[0]!.planBlob).toBeDefined();
				expect(ledger.input).toEqual({
					status: "unavailable",
					reason: "diff_budget_exceeded",
				});
			}
			if (scenario === "no_qa")
				expect(targetLedger.c.missing).toEqual(["qa_claim", "qa_report"]);
		} finally {
			store.close();
		}
	},
);
