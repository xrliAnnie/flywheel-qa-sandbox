import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import type {
	LandOperationRow,
	LandVerifiedTargets,
	StateStore,
} from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import type { WithRepoLock } from "./repo-mutation-lock.js";

export interface BoundWorktreeCloseoutTarget {
	kind: "bound_worktree";
	path: string;
	branch: string;
	generation: string;
	projectRoot: string;
	parentIdentity: { path: string; dev: number; ino: number };
	sourceExecutionIds: string[];
	sourceRunId: string | null;
	sourceReceipt: string;
}

export interface WorktreeNotApplicableCloseoutTarget {
	kind: "worktree_not_applicable";
	executionId: string;
	reason: "pinned_engine_execution";
	nodeType: string;
	dispatchReceipt: string;
}

export type LandCloseoutTarget =
	| BoundWorktreeCloseoutTarget
	| WorktreeNotApplicableCloseoutTarget;

export interface LandTargetSnapshotV1 {
	version: 1;
	project: string;
	issueUuid: string;
	runId: string | null;
	targets: LandCloseoutTarget[];
}

export type ReadLandTargetSnapshotResult =
	| { ok: true; snapshot: LandTargetSnapshotV1 }
	| { ok: false; reason: string };

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => typeof entry === "string" && entry.length > 0)
	);
}

/**
 * Re-read the immutable intent-time target set before physical cleanup. The
 * canonical bytes and digest are checked again so finalization never guesses
 * from whichever Session rows happen to survive after merge.
 */
export function readLandTargetSnapshot(
	operation: LandOperationRow,
): ReadLandTargetSnapshotResult {
	if (
		operation.closeout_targets_version !== 1 ||
		!operation.closeout_targets_json ||
		!operation.closeout_targets_digest
	) {
		return { ok: false, reason: "land_target_snapshot_unavailable" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(operation.closeout_targets_json);
	} catch {
		return { ok: false, reason: "land_target_snapshot_invalid_json" };
	}
	if (
		canonicalJsonString(parsed) !== operation.closeout_targets_json ||
		canonicalSubmissionDigest(parsed) !== operation.closeout_targets_digest
	) {
		return { ok: false, reason: "land_target_snapshot_digest_mismatch" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, reason: "land_target_snapshot_invalid_shape" };
	}
	const snapshot = parsed as Record<string, unknown>;
	if (
		snapshot.version !== 1 ||
		snapshot.project !== operation.project_name ||
		snapshot.issueUuid !== operation.issue_id ||
		snapshot.runId !== operation.run_id ||
		!Array.isArray(snapshot.targets) ||
		snapshot.targets.length === 0
	) {
		return { ok: false, reason: "land_target_snapshot_identity_mismatch" };
	}
	const paths = new Set<string>();
	for (const candidate of snapshot.targets) {
		if (
			!candidate ||
			typeof candidate !== "object" ||
			Array.isArray(candidate)
		) {
			return { ok: false, reason: "land_target_snapshot_invalid_target" };
		}
		const target = candidate as Record<string, unknown>;
		if (target.kind === "bound_worktree") {
			const parent = target.parentIdentity;
			if (
				typeof target.path !== "string" ||
				typeof target.branch !== "string" ||
				typeof target.generation !== "string" ||
				typeof target.projectRoot !== "string" ||
				!parent ||
				typeof parent !== "object" ||
				Array.isArray(parent) ||
				typeof (parent as Record<string, unknown>).path !== "string" ||
				!Number.isSafeInteger((parent as Record<string, unknown>).dev) ||
				!Number.isSafeInteger((parent as Record<string, unknown>).ino) ||
				!isStringArray(target.sourceExecutionIds) ||
				!(
					typeof target.sourceRunId === "string" || target.sourceRunId === null
				) ||
				typeof target.sourceReceipt !== "string" ||
				paths.has(target.path)
			) {
				return { ok: false, reason: "land_target_snapshot_invalid_target" };
			}
			paths.add(target.path);
			continue;
		}
		if (
			target.kind !== "worktree_not_applicable" ||
			typeof target.executionId !== "string" ||
			target.reason !== "pinned_engine_execution" ||
			typeof target.nodeType !== "string" ||
			typeof target.dispatchReceipt !== "string"
		) {
			return { ok: false, reason: "land_target_snapshot_invalid_target" };
		}
	}
	return { ok: true, snapshot: parsed as LandTargetSnapshotV1 };
}

export interface PrepareLandIntentInput {
	runId?: string;
	issueId: string;
	projectName: string;
	prNumber: number;
	approvedHead: string;
	now: string;
}

export interface PrepareLandIntentDeps {
	resolveProjectRoot(projectName: string): string | undefined;
	getRegisteredWorktree(
		mainRepoPath: string,
		worktreePath: string,
	): Promise<{
		path: string;
		branch?: string | null;
		head?: string | null;
		isDetached?: boolean;
	} | null>;
	readWorktreeGeneration(worktreePath: string): Promise<string | undefined>;
	withRepoLock?: WithRepoLock;
	realpath?: typeof realpath;
	stat?: typeof stat;
}

export type PrepareLandIntentResult =
	| { ok: true; operation: LandOperationRow }
	| {
			ok: false;
			reason: "land_target_snapshot_unavailable";
			missing: string[];
			retryable: boolean;
	  };

function engineTarget(
	store: StateStore,
	runId: string,
	executionId: string,
): WorktreeNotApplicableCloseoutTarget | undefined {
	const run = store.getWorkflowRun(runId);
	if (!run?.snapshot || store.getSession(executionId)) return undefined;
	if (store.getLaunchClaim(executionId)) return undefined;
	const activations = store
		.listWorkflowActivationsForActor(executionId)
		.filter((activation) => activation.run_id === runId);
	if (activations.length === 0) return undefined;
	try {
		const snapshot = parseWorkflowRunSnapshot(run.snapshot);
		const nodes = new Map(
			snapshot.manifest.nodes.map((node) => [node.id, node] as const),
		);
		if (
			activations.some(
				(activation) => nodes.get(activation.node_id)?.execution !== "engine",
			)
		) {
			return undefined;
		}
		return {
			kind: "worktree_not_applicable",
			executionId,
			reason: "pinned_engine_execution",
			nodeType: nodes.get(activations[0]!.node_id)?.type ?? "unknown",
			dispatchReceipt: activations
				.map((activation) => activation.activation_id)
				.sort()
				.join(","),
		};
	} catch {
		return undefined;
	}
}

function isBindinglessLandEngineExecution(
	store: StateStore,
	runId: string,
	executionId: string,
): boolean {
	const run = store.getWorkflowRun(runId);
	const runNode = store.getWorkflowRunNodeForExecution(executionId);
	if (!run?.snapshot || !runNode || runNode.run_id !== runId) return false;
	try {
		const node = parseWorkflowRunSnapshot(run.snapshot).manifest.nodes.find(
			(candidate) => candidate.id === runNode.node_id,
		);
		return node?.type === "land" && node.execution === "engine";
	} catch {
		return false;
	}
}

/**
 * Capture the complete, verified closeout target set before a land intent can
 * become runnable. All filesystem/git awaits finish before the SQLite insert.
 */
export async function prepareLandIntent(
	store: StateStore,
	input: PrepareLandIntentInput,
	deps: PrepareLandIntentDeps,
): Promise<PrepareLandIntentResult> {
	const projectRoot = deps.resolveProjectRoot(input.projectName);
	if (!projectRoot) {
		return {
			ok: false,
			reason: "land_target_snapshot_unavailable",
			missing: ["project_root_unavailable"],
			retryable: true,
		};
	}
	const run = input.runId ? store.getWorkflowRun(input.runId) : undefined;
	if (
		input.runId &&
		(!run ||
			run.issue_id !== input.issueId ||
			run.project_name !== input.projectName)
	) {
		return {
			ok: false,
			reason: "land_target_snapshot_unavailable",
			missing: ["workflow_run_identity_mismatch"],
			retryable: false,
		};
	}

	const executionIds = [
		...new Set(
			input.runId
				? store
						.listRunAttributedExecutions(input.runId)
						.filter((executionId) => !/^mat:[0-9a-f]{64}$/.test(executionId))
				: store
						.getSessionsByIssue(input.issueId)
						.filter((session) => session.project_name === input.projectName)
						.map((session) => session.execution_id),
		),
	];
	if (executionIds.length === 0) {
		return {
			ok: false,
			reason: "land_target_snapshot_unavailable",
			missing: ["closeout_inventory_empty"],
			retryable: true,
		};
	}
	const latestExecutionByAttempt = new Map<string, string>();
	if (input.runId) {
		for (const executionId of executionIds) {
			const node = store.getWorkflowRunNodeForExecution(executionId);
			if (!node || node.run_id !== input.runId) continue;
			const latest = store
				.listWorkflowRunNodes(input.runId, node.node_id)
				.at(-1)?.execution_id;
			if (latest) latestExecutionByAttempt.set(executionId, latest);
		}
	}
	executionIds.sort((left, right) => {
		const leftLatest = latestExecutionByAttempt.get(left);
		const rightLatest = latestExecutionByAttempt.get(right);
		const leftIsHistorical = leftLatest !== undefined && leftLatest !== left;
		const rightIsHistorical =
			rightLatest !== undefined && rightLatest !== right;
		return (
			Number(leftIsHistorical) - Number(rightIsHistorical) ||
			left.localeCompare(right)
		);
	});

	const inspect = async (): Promise<
		| { ok: true; targets: LandCloseoutTarget[] }
		| { ok: false; missing: string[] }
	> => {
		const missing: string[] = [];
		const byBinding = new Map<string, BoundWorktreeCloseoutTarget>();
		const currentByPath = new Map<string, BoundWorktreeCloseoutTarget>();
		const notApplicable: WorktreeNotApplicableCloseoutTarget[] = [];
		const realpathFn = deps.realpath ?? realpath;
		const statFn = deps.stat ?? stat;
		let canonicalProjectRoot: string;
		try {
			canonicalProjectRoot = await realpathFn(projectRoot);
		} catch {
			return { ok: false, missing: ["project_root_unresolvable"] };
		}
		for (const executionId of executionIds) {
			const binding = store.getWorktreeBinding(executionId);
			if (!binding) {
				if (
					input.runId &&
					isBindinglessLandEngineExecution(store, input.runId, executionId)
				) {
					continue;
				}
				const engine = input.runId
					? engineTarget(store, input.runId, executionId)
					: undefined;
				if (engine) notApplicable.push(engine);
				else missing.push(`${executionId}:worktree_binding_unavailable`);
				continue;
			}
			let canonicalPath: string;
			try {
				canonicalPath = await realpathFn(binding.path);
			} catch {
				missing.push(`${executionId}:worktree_path_unresolvable`);
				continue;
			}
			if (dirname(canonicalPath) !== dirname(canonicalProjectRoot)) {
				missing.push(`${executionId}:worktree_parent_mismatch`);
				continue;
			}
			const latestExecutionId = latestExecutionByAttempt.get(executionId);
			if (latestExecutionId && latestExecutionId !== executionId) {
				const current = currentByPath.get(canonicalPath);
				if (
					!current ||
					!current.sourceExecutionIds.includes(latestExecutionId)
				) {
					missing.push(
						`${executionId}:superseding_worktree_binding_unavailable`,
					);
					continue;
				}
				current.sourceExecutionIds.push(executionId);
				current.sourceExecutionIds.sort();
				continue;
			}
			let registered: Awaited<
				ReturnType<PrepareLandIntentDeps["getRegisteredWorktree"]>
			>;
			try {
				registered = await deps.getRegisteredWorktree(
					canonicalProjectRoot,
					canonicalPath,
				);
			} catch {
				missing.push(`${executionId}:worktree_registration_unavailable`);
				continue;
			}
			if (!registered) {
				missing.push(`${executionId}:worktree_not_registered`);
				continue;
			}
			if (
				registered.isDetached ||
				registered.branch !== binding.branch ||
				(await realpathFn(registered.path)) !== canonicalPath
			) {
				missing.push(`${executionId}:worktree_registration_mismatch`);
				continue;
			}
			let generation: string | undefined;
			try {
				generation = await deps.readWorktreeGeneration(canonicalPath);
			} catch {
				generation = undefined;
			}
			if (!generation || generation !== binding.generation) {
				missing.push(`${executionId}:worktree_generation_mismatch`);
				continue;
			}
			const parentPath = dirname(canonicalPath);
			const parent = await statFn(parentPath);
			const key = `${canonicalPath}\0${binding.branch}\0${generation}`;
			const prior = byBinding.get(key);
			if (prior) {
				prior.sourceExecutionIds.push(executionId);
				prior.sourceExecutionIds.sort();
				continue;
			}
			byBinding.set(key, {
				kind: "bound_worktree",
				path: canonicalPath,
				branch: binding.branch,
				generation,
				projectRoot: canonicalProjectRoot,
				parentIdentity: {
					path: parentPath,
					dev: Number(parent.dev),
					ino: Number(parent.ino),
				},
				sourceExecutionIds: [executionId],
				sourceRunId: input.runId ?? null,
				sourceReceipt: `state_session_binding:${executionId}:${generation}`,
			});
			currentByPath.set(canonicalPath, byBinding.get(key)!);
		}
		return missing.length > 0
			? { ok: false, missing: [...new Set(missing)].sort() }
			: {
					ok: true,
					targets: [...byBinding.values(), ...notApplicable].sort(
						(left, right) =>
							(left.kind === "bound_worktree"
								? left.path
								: left.executionId
							).localeCompare(
								right.kind === "bound_worktree"
									? right.path
									: right.executionId,
							),
					),
				};
	};

	const inspected = deps.withRepoLock
		? await deps.withRepoLock(projectRoot, inspect)
		: await inspect();
	if (!inspected.ok) {
		return {
			ok: false,
			reason: "land_target_snapshot_unavailable",
			missing: inspected.missing,
			retryable: true,
		};
	}

	const snapshot: LandTargetSnapshotV1 = {
		version: 1,
		project: input.projectName,
		issueUuid: input.issueId,
		runId: input.runId ?? null,
		targets: inspected.targets,
	};
	const verifiedTargets: LandVerifiedTargets = {
		json: canonicalJsonString(snapshot),
		digest: canonicalSubmissionDigest(snapshot),
		version: 1,
		attributionDigest: canonicalSubmissionDigest(executionIds),
		observedAt: input.now,
	};
	return {
		ok: true,
		operation: store.ensureLandOperation({
			...input,
			verifiedTargets,
		}),
	};
}
