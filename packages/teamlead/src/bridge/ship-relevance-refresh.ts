import type {
	ShipRelevantDeclaredPrRow,
	WorkflowNodePrBindingRow,
} from "../StateStore.js";
import type {
	ShipRelevantGitHubApi,
	ShipRelevantRunRefresh,
} from "./ship-relevant-diff.js";

export type { ShipRelevantRunRefresh } from "./ship-relevant-diff.js";

type PrimaryBinding = Pick<
	WorkflowNodePrBindingRow,
	"target_repo_identity" | "probe_repo_slug" | "pr_number" | "head_sha"
>;

type DeclaredBinding = Pick<
	ShipRelevantDeclaredPrRow,
	"repo_identity" | "probe_repo_slug" | "pr_number" | "frozen_head_sha"
>;

/**
 * Assemble one workflow run using a single GitHub API bound to the stable
 * project root. Repository selection lives in each absolute `/repos/...` API
 * path, so candidate worktree paths must never become process cwd authority.
 */
export function buildWorkflowShipRelevantRunRefresh(input: {
	executionId: string;
	primary: PrimaryBinding;
	declared: DeclaredBinding[];
	api: ShipRelevantGitHubApi;
}): ShipRelevantRunRefresh {
	const primary = {
		executionId: input.executionId,
		repoIdentity: input.primary.target_repo_identity,
		repoSlug: input.primary.probe_repo_slug,
		prNumber: input.primary.pr_number,
		prHeadSha: input.primary.head_sha,
		role: "primary" as const,
		api: input.api,
	};
	return {
		executionId: input.executionId,
		primary,
		declared: input.declared.map((candidate) => ({
			executionId: input.executionId,
			repoIdentity: candidate.repo_identity,
			repoSlug: candidate.probe_repo_slug,
			prNumber: candidate.pr_number,
			prHeadSha: candidate.frozen_head_sha,
			role: "declared" as const,
			api: input.api,
		})),
	};
}
