import { expect, it, vi } from "vitest";
import {
	canonicalDigest,
	type FrozenPacket,
	type ProjectSnapshot,
} from "../contract.js";
import { collectProductionJudgment } from "../production-collect.js";
import { bindingFixture, CHANNEL, HEAD } from "./binding-fixture.js";

it("composes shared snapshots and frozen sources, preserving the original diff base and disposing every Git store", async () => {
	const { store } = await bindingFixture();
	try {
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
					base_ref: "release",
					filesComplete: true,
					files: [{ path: "a.ts" }],
				},
			],
		};
		const packet: FrozenPacket = {
			questionId: "q",
			channelId: CHANNEL,
			bindingDigest: canonicalDigest(
				store.readShipJudgmentBinding("q", CHANNEL),
			),
			targets: [
				{
					repo_identity: "__main__",
					pr_number: 2399,
					head_sha: HEAD,
					diff_base_sha: "c".repeat(40),
				},
			],
			sources: [{ source_id: "plan", kind: "plan", revision: "1", text: "R1" }],
			files: [{ repo_identity: "__main__", path: "a.ts" }],
			requirements: [],
			prompt: "Evaluate",
			model: {
				model: "fixture",
				effort: "high",
				configuration_digest: "d".repeat(64),
			},
		};
		store.getShipJudgmentInputs().freeze(packet, new Date().toISOString());
		const dispose = vi.fn(async () => {});
		const prepare = vi.fn(
			async (request: {
				repoIdentity: string;
				repoSlug: string;
				prNumber: number;
				headSha: string;
				diffBaseSha?: string;
			}) => ({
				gitDir: "/tmp/fixture.git",
				dispose,
				material: {
					...request,
					diffBaseSha: request.diffBaseSha ?? "c".repeat(40),
					reader: () => ({
						readText: async () => ({ text: "R1", blobSha: "e".repeat(40) }),
						listTextFiles: async () => [],
						diff: async () => ({
							text: "",
							files: [],
							complete: true,
							digest: "e".repeat(64),
						}),
					}),
				},
			}),
		);
		const merge = vi.fn(async () => ({
			verdict: "pass" as const,
			reason: "merge_clean",
		}));
		const source = {
			store,
			linearApiKey: "fixture",
			planRepoIdentity: "__main__",
			registry: { readReportHtml: () => "" },
			hosting: { vercelProjectName: "reports" },
		};
		const collect = vi.fn(async () => ({ status: "ready" as const, packet }));
		let current: ProjectSnapshot | undefined = snapshot;
		const deps = {
			source,
			repositories,
			refresh: {
				refresh: async () => ({ status: "ready" as const, snapshot }),
			},
			currentSnapshot: () => current,
			token: async () => "fixture",
			prepare,
			merge,
			collect,
		};
		const result = await collectProductionJudgment(
			"q",
			CHANNEL,
			deps,
			new AbortController().signal,
		);
		expect(result.collection.status).toBe("ready");
		expect(result.mechanical.verdict).toBe("pass");
		expect(prepare).toHaveBeenCalledWith(
			expect.objectContaining({
				diffBaseSha: "c".repeat(40),
				targetBaseSha: "b".repeat(40),
			}),
			expect.anything(),
			expect.any(AbortSignal),
		);
		expect(merge).toHaveBeenCalledWith(
			expect.objectContaining({ targetBaseSha: "b".repeat(40) }),
		);
		expect(dispose).toHaveBeenCalledTimes(1);
		const probeCache = store.getShipJudgmentProjectRefresh(),
			probeNow = Date.now();
		const lease = probeCache.begin("cache-test", probeNow);
		if (lease.status !== "claimed") throw new Error(lease.status);
		probeCache.finish(lease, snapshot, probeNow);
		const cachedDeps = { ...deps, mergeCache: probeCache, now: () => probeNow };
		merge.mockClear();
		for (let i = 0; i < 2; i++)
			expect(
				(
					await collectProductionJudgment(
						"q",
						CHANNEL,
						cachedDeps,
						new AbortController().signal,
					)
				).mechanical.verdict,
			).toBe("pass");
		expect(merge).toHaveBeenCalledTimes(1);

		collect.mockImplementationOnce(async () => {
			current = undefined;
			return { status: "ready", packet };
		});
		expect(
			(
				await collectProductionJudgment(
					"q",
					CHANNEL,
					deps,
					new AbortController().signal,
				)
			).mechanical.verdict,
		).toBe("undetermined");
		expect(dispose).toHaveBeenCalledTimes(4);
		current = snapshot;
		snapshot.prs.push({
			...snapshot.prs[0]!,
			pr_number: 77,
			head_sha: "9".repeat(40),
		});
		expect(
			(
				await collectProductionJudgment(
					"q",
					CHANNEL,
					deps,
					new AbortController().signal,
				)
			).mechanical,
		).toMatchObject({
			verdict: "fail",
			overlaps: [{ repo_identity: "__main__", pr_number: 77, path: "a.ts" }],
		});
		snapshot.prs.pop();
		const conflictingMerge = async () => ({
			verdict: "fail" as const,
			reason: "merge_conflict",
		});
		expect(
			(
				await collectProductionJudgment(
					"q",
					CHANNEL,
					{ ...deps, merge: conflictingMerge },
					new AbortController().signal,
				)
			).mechanical.verdict,
		).toBe("fail");
		const ownPr = snapshot.prs[0]!;
		const ownFiles = ownPr.files;
		ownPr.filesComplete = false;
		ownPr.files = [];
		ownPr.filesError = "github_body_budget";
		const ownUnknown = await collectProductionJudgment(
			"q",
			CHANNEL,
			deps,
			new AbortController().signal,
		);
		expect(ownUnknown.collection.status).toBe("ready");
		expect(ownUnknown.mechanical.verdict).toBe("undetermined");
		ownPr.filesComplete = true;
		ownPr.files = ownFiles;
		delete ownPr.filesError;
		snapshot.prs.push({
			...ownPr,
			pr_number: 78,
			filesComplete: false,
			files: [],
			filesError: "github_http_500",
		});
		const peerUnknown = await collectProductionJudgment(
			"q",
			CHANNEL,
			deps,
			new AbortController().signal,
		);
		expect(peerUnknown.collection.status).toBe("ready");
		expect(peerUnknown.mechanical.verdict).toBe("undetermined");
		// An unknown inventory in another repository cannot textually overlap this target.
		snapshot.repositories.push({
			repo_identity: "other",
			repo_slug: "owner/other",
			main_sha: "b".repeat(40),
		});
		snapshot.prs[snapshot.prs.length - 1]!.repo_identity = "other";
		const unrelated = await collectProductionJudgment(
			"q",
			CHANNEL,
			deps,
			new AbortController().signal,
		);
		expect(unrelated.collection.status).toBe("ready");
		expect(unrelated.mechanical.verdict).toBe("pass");
		snapshot.repositories.pop();
		snapshot.prs.pop();
		snapshot.prs[0]!.head_sha = "f".repeat(40);
		prepare.mockClear();
		expect(
			(
				await collectProductionJudgment(
					"q",
					CHANNEL,
					deps,
					new AbortController().signal,
				)
			).collection.status,
		).toBe("undetermined");
		expect(prepare).not.toHaveBeenCalled();
	} finally {
		store.close();
	}
});
