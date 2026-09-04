import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { resolveFounderId } from "flywheel-comm/founder-attribution";
import {
	type FounderReviewVerdict,
	resolveFounderReviewVerdictAtCommit,
} from "flywheel-comm/founder-review";
import { ConfigLoader } from "flywheel-config";
import { loadProjects } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	nodeRequiresFounderReview,
	type WorkflowRunSnapshot,
} from "../workflow-run-snapshot.js";
import { commDbPathForProject } from "./commdb-path.js";
import { createStateStoreFounderReviewStateReader } from "./founder-review-state.js";

export type FounderReviewAuthorityResult =
	| { required: false; verdict: { status: "not_required" } }
	| { required: true; verdict: FounderReviewVerdict };

export async function founderReviewCheckpointEnabled(
	projectRoot: string,
): Promise<boolean> {
	const configPath = join(projectRoot, ".flywheel", "config.yaml");
	try {
		const config = await new ConfigLoader(async (path) =>
			readFileSync(path, "utf8"),
		).load(configPath);
		return config.checkpoints?.founder_review !== undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Shared Bridge authority seam used by completion, land, and finalization. */
export function evaluateFounderReviewAuthority(input: {
	enabled: boolean;
	store: StateStore;
	commDbPath: string;
	runId: string;
	nodeId: string;
	snapshot: WorkflowRunSnapshot;
	repoRoot: string;
	head: string;
	founderId: string | undefined;
}): FounderReviewAuthorityResult {
	if (
		!input.enabled ||
		!nodeRequiresFounderReview(input.snapshot, input.nodeId)
	) {
		return { required: false, verdict: { status: "not_required" } };
	}
	if (!existsSync(input.commDbPath)) {
		return {
			required: true,
			verdict: { status: "missing", reason: "no_round_for_run" },
		};
	}
	const commDb = CommDB.openReadonly(input.commDbPath);
	try {
		return {
			required: true,
			verdict: resolveFounderReviewVerdictAtCommit({
				reader: createStateStoreFounderReviewStateReader({
					store: input.store,
					commDb,
				}),
				runId: input.runId,
				repoRoot: input.repoRoot,
				head: input.head,
				founderId: input.founderId,
			}),
		};
	} finally {
		commDb.close();
	}
}

/**
 * Resolve the exact artifact-producing PR binding, then apply the shared
 * archive-aware founder-review verdict at that immutable head. This is the
 * common engine land/finalization precondition.
 */
export async function evaluateWorkflowFounderReviewPrecondition(input: {
	store: StateStore;
	runId: string;
	projectName: string;
	snapshot: WorkflowRunSnapshot;
	head: string;
	processEnv?: NodeJS.ProcessEnv;
}): Promise<{ eligible: true } | { eligible: false; reason: string }> {
	const producerIds = input.snapshot.manifest.nodes
		.filter((node) => node.founder_review === true)
		.map((node) => node.id);
	if (producerIds.length === 0) return { eligible: true };
	if (producerIds.length !== 1) {
		return { eligible: false, reason: "founder_review_producer_ambiguous" };
	}
	const exactHeadAuthority = input.store.resolveWorkflowExactHeadAuthority({
		runId: input.runId,
		headSha: input.head,
	});
	if (
		!exactHeadAuthority.valid ||
		exactHeadAuthority.binding.node_id !== producerIds[0]
	) {
		return {
			eligible: false,
			reason: "founder_review_artifact_binding_missing",
		};
	}
	const binding = exactHeadAuthority.binding;
	const failures: Array<{ repoRoot: string; error: unknown }> = [];
	let projectRoot: string | undefined;
	if (binding.target_repo_identity === "__main__") {
		try {
			projectRoot = loadProjects().find(
				(project) => project.projectName === input.projectName,
			)?.projectRoot;
		} catch (error) {
			failures.push({ repoRoot: "(project registry)", error });
		}
	}
	const repoRoots = [projectRoot, binding.target_repo_path].filter(
		(root, index, roots): root is string =>
			Boolean(root) && roots.indexOf(root) === index,
	);
	let authority: FounderReviewAuthorityResult | undefined;
	for (const repoRoot of repoRoots) {
		try {
			authority = evaluateFounderReviewAuthority({
				// The manifest capability is sealed by the engine. Never let the
				// artifact-producing checkout disable its own land/finalization gate.
				enabled: true,
				store: input.store,
				commDbPath: commDbPathForProject(input.projectName),
				runId: input.runId,
				nodeId: binding.node_id,
				snapshot: input.snapshot,
				repoRoot,
				head: exactHeadAuthority.authorityHead,
				founderId: resolveFounderId({
					processEnv: input.processEnv ?? process.env,
				}),
			});
			break;
		} catch (error) {
			failures.push({ repoRoot, error });
		}
	}
	if (!authority) {
		console.error(
			`[founder-review-authority] authority unavailable ${JSON.stringify({
				projectName: input.projectName,
				runId: input.runId,
				bindingRepoPath: binding.target_repo_path,
				failures: failures.map(({ repoRoot, error }) => ({
					repoRoot,
					errorType: error instanceof Error ? error.name : typeof error,
					error: error instanceof Error ? error.message : String(error),
				})),
			})}`,
		);
		return {
			eligible: false,
			reason: "founder_review_authority_unavailable",
		};
	}
	return authority.required && authority.verdict.status !== "passed"
		? {
				eligible: false,
				reason: `founder_review_${authority.verdict.status}`,
			}
		: { eligible: true };
}
