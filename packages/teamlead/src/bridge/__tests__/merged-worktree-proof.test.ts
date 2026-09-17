import { describe, expect, it, vi } from "vitest";
import {
	buildMergedWorktreeProof,
	verifyMergedBranchCoverage,
} from "../merged-worktree-proof.js";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const MAIN = "c".repeat(40);
const ROOT = "/repo/flywheel";

const operation = {
	operationId: "land:FLY-2664:1234",
	operationGeneration: 7,
	projectName: "flywheel",
	issueId: "issue-2664",
	runId: "run-2664",
	prNumber: 1234,
	approvedHead: HEAD,
};

const receipt = {
	receiptId: "land:FLY-2664:1234:merge_confirmed",
	observedAt: "2026-09-17T20:00:00.000Z",
	receipt: {
		state: "MERGED",
		prNumber: 1234,
		headSha: HEAD,
		mergeSha: MERGE,
		baseRefName: "main",
		repoIdentity: "xrliAnnie/flywheel",
	},
};

function proof(overrides: Partial<typeof receipt.receipt> = {}) {
	return buildMergedWorktreeProof({
		operation,
		mergeReceipt: {
			...receipt,
			receipt: { ...receipt.receipt, ...overrides },
		},
		projectRoot: ROOT,
		trustedRepoIdentity: "xrliAnnie/flywheel",
	});
}

describe("merged worktree proof", () => {
	it("accepts only a merged main receipt bound to the operation head and trusted repo", () => {
		expect(proof()).toEqual({
			operationId: operation.operationId,
			operationGeneration: operation.operationGeneration,
			projectName: operation.projectName,
			issueId: operation.issueId,
			runId: operation.runId,
			repoIdentity: "xrliAnnie/flywheel",
			projectRoot: ROOT,
			prNumber: operation.prNumber,
			baseRefName: "main",
			mergedPrHead: HEAD,
			mergeSha: MERGE,
			mergeReceiptId: receipt.receiptId,
			observedAt: receipt.observedAt,
		});

		for (const invalid of [
			{ state: "OPEN" },
			{ baseRefName: "release" },
			{ headSha: "d".repeat(40) },
			{ mergeSha: "" },
			{ repoIdentity: "someone/else" },
			{ prNumber: 9999 },
		]) {
			expect(proof(invalid)).toBeUndefined();
		}
	});

	it("does not treat MERGED alone as trusted main-branch proof", () => {
		expect(proof({ baseRefName: undefined })).toBeUndefined();
		expect(proof({ repoIdentity: undefined })).toBeUndefined();
	});

	it("accepts an exact merged PR head without requiring ancestor history", async () => {
		const mergedProof = proof();
		expect(mergedProof).toBeDefined();
		const gitExec = vi.fn();

		expect(
			await verifyMergedBranchCoverage({
				proof: mergedProof!,
				projectRoot: ROOT,
				registeredBranch: "docs/FLY-2664-cleanup",
				registeredHead: HEAD,
				protectedBranches: [],
				gitExec,
			}),
		).toEqual({ ok: true, via: "exact_pr_head" });
		expect(gitExec).not.toHaveBeenCalled();
	});

	it("accepts only a trusted current-main ancestor and distinguishes exit 1 from probe errors", async () => {
		const mergedProof = proof();
		expect(mergedProof).toBeDefined();
		const registeredHead = "d".repeat(40);
		const outputs = new Map<
			string,
			{ code: number; stdout: string; stderr: string }
		>([
			[
				"remote get-url origin",
				{
					code: 0,
					stdout: "git@github.com:xrliAnnie/flywheel.git\n",
					stderr: "",
				},
			],
			[
				"ls-remote --heads origin refs/heads/main",
				{ code: 0, stdout: `${MAIN}\trefs/heads/main\n`, stderr: "" },
			],
			[
				"fetch --no-tags --quiet origin refs/heads/main",
				{ code: 0, stdout: "", stderr: "" },
			],
			[
				"rev-parse --verify FETCH_HEAD",
				{ code: 0, stdout: `${MAIN}\n`, stderr: "" },
			],
			[
				`merge-base --is-ancestor ${registeredHead} ${MAIN}`,
				{ code: 0, stdout: "", stderr: "" },
			],
		]);
		const gitExec = vi.fn(async (args: string[]) => {
			const key = args.filter((arg) => arg !== "-C" && arg !== ROOT).join(" ");
			return (
				outputs.get(key) ?? { code: 2, stdout: "", stderr: `unexpected:${key}` }
			);
		});
		const base = {
			proof: mergedProof!,
			projectRoot: ROOT,
			registeredBranch: "feat/FLY-2664-cleanup",
			registeredHead,
			protectedBranches: [] as string[],
			gitExec,
		};

		expect(await verifyMergedBranchCoverage(base)).toEqual({
			ok: true,
			via: "ancestor_of_main",
			mainSha: MAIN,
		});

		outputs.set(`merge-base --is-ancestor ${registeredHead} ${MAIN}`, {
			code: 1,
			stdout: "",
			stderr: "",
		});
		expect(await verifyMergedBranchCoverage(base)).toEqual({
			ok: false,
			detail: "head_not_merged",
		});

		outputs.set(`merge-base --is-ancestor ${registeredHead} ${MAIN}`, {
			code: 128,
			stdout: "",
			stderr: "fatal: bad object",
		});
		expect(await verifyMergedBranchCoverage(base)).toEqual({
			ok: false,
			detail: "merge_probe_unknown",
		});
	});

	it.each(["main", "master", "release/*"])(
		"rejects base or protected branch %s before destructive coverage checks",
		async (registeredBranch) => {
			const mergedProof = proof();
			expect(mergedProof).toBeDefined();
			const gitExec = vi.fn();
			const protectedBranches =
				registeredBranch === "release/*" ? ["release/*"] : [];
			const branch =
				registeredBranch === "release/*" ? "release/2026-09" : registeredBranch;

			expect(
				await verifyMergedBranchCoverage({
					proof: mergedProof!,
					projectRoot: ROOT,
					registeredBranch: branch,
					registeredHead: HEAD,
					protectedBranches,
					gitExec,
				}),
			).toEqual({ ok: false, detail: "protected_branch" });
			expect(gitExec).not.toHaveBeenCalled();
		},
	);
});
