import { canonicalizeWorktreePath } from "flywheel-edge-worker";

export interface CompletionWorktreeBranchObservation {
	path: string;
	generation: string;
	expectedBranch: string;
	observedBranch: string;
	observedHead: string;
}

interface CompletionBranchObservationInput {
	binding: { path: string; branch: string; generation: string };
	authority: { path: string; branch: string; headSha: string };
	prBinding: {
		targetRepoPath: string;
		headSha: string;
		worktreeBindingGeneration: string;
	};
}

interface CompletionBranchObservationDeps {
	readWorktreeGeneration(path: string): Promise<string | undefined>;
}

/**
 * Produce the server-only observation consumed by the completion transaction.
 * Nested-repository PRs and stale path/head/generation observations are ignored;
 * they must never rewrite the outer worktree binding.
 */
export async function observeCompletionWorktreeBranch(
	input: CompletionBranchObservationInput,
	deps: CompletionBranchObservationDeps,
): Promise<CompletionWorktreeBranchObservation | undefined> {
	const bindingPath = canonicalizeWorktreePath(input.binding.path);
	const authorityPath = canonicalizeWorktreePath(input.authority.path);
	if (
		authorityPath !== bindingPath ||
		canonicalizeWorktreePath(input.prBinding.targetRepoPath) !==
			authorityPath ||
		input.authority.headSha.toLowerCase() !==
			input.prBinding.headSha.toLowerCase() ||
		input.binding.generation !== input.prBinding.worktreeBindingGeneration ||
		!input.authority.branch ||
		input.authority.branch === "HEAD" ||
		input.authority.branch === "main" ||
		input.authority.branch === "master"
	) {
		return undefined;
	}
	const generation = await deps.readWorktreeGeneration(authorityPath);
	if (!generation || generation !== input.binding.generation) return undefined;
	return {
		path: authorityPath,
		generation,
		expectedBranch: input.binding.branch,
		observedBranch: input.authority.branch,
		observedHead: input.authority.headSha.toLowerCase(),
	};
}
