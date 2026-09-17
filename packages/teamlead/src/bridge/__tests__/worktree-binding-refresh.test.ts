import { describe, expect, it, vi } from "vitest";
import { observeCompletionWorktreeBranch } from "../worktree-binding-refresh.js";

const HEAD = "a".repeat(40);
const PATH = "/Users/x/Dev/flywheel-FLY-2664";

describe("completion worktree branch observation", () => {
	it("accepts a root-repository branch change bound to the same head and generation", async () => {
		await expect(
			observeCompletionWorktreeBranch(
				{
					binding: {
						path: PATH,
						branch: "flywheel-FLY-2664",
						generation: "gen-1",
					},
					authority: {
						path: PATH,
						branch: "docs/FLY-2664-cleanup",
						headSha: HEAD,
					},
					prBinding: {
						targetRepoPath: PATH,
						headSha: HEAD,
						worktreeBindingGeneration: "gen-1",
					},
				},
				{ readWorktreeGeneration: vi.fn(async () => "gen-1") },
			),
		).resolves.toEqual({
			path: PATH,
			generation: "gen-1",
			expectedBranch: "flywheel-FLY-2664",
			observedBranch: "docs/FLY-2664-cleanup",
			observedHead: HEAD,
		});
	});

	it.each([
		["nested repo", `${PATH}/nested`, "docs/FLY-2664-cleanup", HEAD, "gen-1"],
		["head mismatch", PATH, "docs/FLY-2664-cleanup", "b".repeat(40), "gen-1"],
		["generation mismatch", PATH, "docs/FLY-2664-cleanup", HEAD, "gen-2"],
		["protected branch", PATH, "main", HEAD, "gen-1"],
	] as const)(
		"rejects %s without a branch observation",
		async (_label, authorityPath, branch, headSha, generation) => {
			await expect(
				observeCompletionWorktreeBranch(
					{
						binding: {
							path: PATH,
							branch: "flywheel-FLY-2664",
							generation: "gen-1",
						},
						authority: {
							path: authorityPath,
							branch,
							headSha,
						},
						prBinding: {
							targetRepoPath: authorityPath,
							headSha: HEAD,
							worktreeBindingGeneration: generation,
						},
					},
					{ readWorktreeGeneration: vi.fn(async () => "gen-1") },
				),
			).resolves.toBeUndefined();
		},
	);
});
