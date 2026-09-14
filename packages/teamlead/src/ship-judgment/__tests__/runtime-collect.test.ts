import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LinearIssue } from "../../bridge/linear-query.js";
import type { StrengthTwoEvidenceRecordRow } from "../../StateStore.js";
import { collectLiveJudgment } from "../runtime-collect.js";
import { bindingFixture, CHANNEL, HEAD } from "./binding-fixture.js";

describe("runtime material assembly", () => {
	it("assembles real binding/review state through the source adapters and rejects QA changes during a diff read", async () => {
		const { store } = await bindingFixture();
		try {
			store.insertCodexReviewJob({
				requestId: "review",
				executionId: "execution",
				issueId: "FLY-2399",
				projectName: "flywheel",
				reviewType: "design",
				questionId: "rq",
				targetPath: "engineering/doc/FLY-2399-x/plan.md",
			});
			store.completeCodexReviewJob("review", "APPROVED");
			const body = "<p>R1 test PASS</p>";
			const row = {
				run_id: "r",
				target_repo_identity: "__main__",
				head_sha: HEAD,
				record_id: "qa1",
				recorded_at: "2026-09-10T00:00:00Z",
				record_status: "satisfied",
				record_url_kind: "hosted_report",
				record_url: `https://reports.vercel.app/r/${"a".repeat(32)}/`,
				record_digest: createHash("sha256").update(body).digest("hex"),
				record_bytes: Buffer.byteLength(body),
			} as StrengthTwoEvidenceRecordRow;
			vi.spyOn(store, "listStrengthTwoRecordsForHead").mockImplementation(
				() => [row],
			);
			const diff = vi.fn(async () => ({
				text: "+implemented",
				files: [{ path: "a.ts", status: "A" }],
				complete: true,
				digest: "a".repeat(64),
			}));
			const deps = {
				store,
				linearApiKey: "private",
				planRepoIdentity: "__main__",
				lookupIssue: async () =>
					({
						id: "12345678-1234-4234-8234-123456789012",
						identifier: "FLY-2399",
						title: "Scope",
						description: "R1: implement",
						updatedAt: "2026-09-10T00:00:00Z",
					}) as LinearIssue,
				registry: { readReportHtml: () => body },
				hosting: { vercelProjectName: "reports" },
				git: [
					{
						repoIdentity: "__main__",
						repoSlug: "owner/repo",
						prNumber: 2399,
						headSha: HEAD,
						diffBaseSha: "b".repeat(40),
						reader: (_signal: AbortSignal) => ({
							listTextFiles: async () => [],
							readText: async () => ({
								text: "R1: implement",
								blobSha: "c".repeat(40),
							}),
							diff,
						}),
					},
				],
			};
			const result = await collectLiveJudgment("q", CHANNEL, deps);
			expect(result.status).toBe("ready");
			if (result.status !== "ready") throw new Error(result.reason);
			expect(result.packet.sources.map((source) => source.kind)).toEqual([
				"issue",
				"plan",
				"qa",
				"diff",
				"files",
			]);
			expect(result.packet.requirements.length).toBeGreaterThan(0);
			expect(JSON.stringify(result)).not.toContain("private");
			for (const git of [
				[],
				[{ ...deps.git[0]!, repoSlug: "attacker/repo" }],
				[{ ...deps.git[0]!, headSha: "f".repeat(40) }],
				[deps.git[0]!, deps.git[0]!],
			]) {
				diff.mockClear();
				expect(
					await collectLiveJudgment("q", CHANNEL, { ...deps, git }),
				).toMatchObject({
					status: "undetermined",
					reason: "git_material_missing",
				});
				expect(diff).not.toHaveBeenCalled();
			}
			const controller = new AbortController();
			controller.abort();
			expect(
				(await collectLiveJudgment("q", CHANNEL, deps, controller.signal))
					.status,
			).toBe("undetermined");
			expect(diff).not.toHaveBeenCalled();
			diff.mockImplementationOnce(async () => {
				row.record_id = "qa2";
				return {
					text: "+implemented",
					files: [{ path: "a.ts", status: "A" }],
					complete: true,
					digest: "a".repeat(64),
				};
			});
			expect(await collectLiveJudgment("q", CHANNEL, deps)).toMatchObject({
				status: "undetermined",
				reason: "binding_changed",
			});
			expect(
				await collectLiveJudgment("q", CHANNEL, { ...deps, git: [] }),
			).toMatchObject({ status: "undetermined" });
		} finally {
			store.close();
		}
	});
});
