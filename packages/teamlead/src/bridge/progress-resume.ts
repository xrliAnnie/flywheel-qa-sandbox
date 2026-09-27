/**
 * FLY-795 c3: teamlead-side computation of the typed `progressResume` handed to
 * the Blueprint when a DEAD runner (explicit terminate / machine reboot) is
 * re-dispatched. This is the "resume from real progress, not from scratch" core.
 *
 * Layering (Codex R1 #2): this lives in teamlead (which has StateStore + git
 * access); `flywheel-edge-worker`'s Blueprint only RENDERS from the trusted
 * `progressResume` it receives — it never reaches into StateStore itself.
 *
 * Detection reads the BRANCH BLOB, never the worktree filesystem (Codex R2 #3):
 * on a reboot the worktree may be gone while `progress.md` survives as a pushed/
 * committed blob on branch B. It reuses FLY-793's worktree mechanism — the
 * resume dispatch sets `startPoint = <branch B tip>` + `shareParentBranch: true`,
 * so `git worktree add -B <branch> <tip>` rebuilds the worktree WITH progress.md
 * (no separate "don't branch -D" mode needed — align with 793, don't build two).
 *
 * `effectiveStage` is derived from the current persisted engine node (or the
 * prior session stage for manual legacy starts) and cross-checked
 * against the ledger's `phase`; on mismatch it is `undefined` = "suppress no gates"
 * (Codex R2 #4 fail-closed) — a stale / tampered ledger can never skip a mandatory
 * brainstorm/design gate.
 */

import type { WorkflowPhaseRole } from "flywheel-config";
import {
	isWorkflowPhaseRole,
	parseProgress,
	resolveProgressPath,
	stageToPhase,
} from "flywheel-config";
import type { StateStore } from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";

export type ResumeKind = "restart" | "terminate" | "reboot" | "handoff";

export interface ProgressResumeInfo {
	/** deterministic progress.md path (also injected to the runner as FLYWHEEL_PROGRESS_PATH). */
	progressPath: string;
	priorExecutionId: string;
	resumeKind: ResumeKind;
	/** phase to suppress up-to; undefined = suppress nothing (fail-closed on mismatch). */
	effectiveStage?: WorkflowPhaseRole;
	/** branch B tip SHA — reuses 793's worktree startPoint so progress.md survives. */
	startPoint: string;
	/** always true for a resume — reuse 793's single-branch worktree mechanism. */
	shareParentBranch: true;
}

export interface PriorSessionRow {
	execution_id: string;
	plan_path?: string;
	session_stage?: string;
}

export type MaybePromise<T> = T | Promise<T>;

/** Credentials deliberately excluded from resume authority. */
export interface WorkflowResumeIdentity {
	engineOwned?: boolean;
	executionId: string;
	activationId?: string;
	runId: string;
	nodeId: string;
	attempt: number;
}

export function assertWorkflowResumeAuthority(
	store: Pick<
		StateStore,
		| "getWorkflowRun"
		| "getWorkflowRunNode"
		| "getWorkflowActivation"
		| "listWorkflowRunNodes"
	>,
	identity: WorkflowResumeIdentity,
	issueId: string,
	projectName: string,
	role: string,
): { phase?: WorkflowPhaseRole } {
	const refuse = () => new Error("workflow_resume_authority_refused");
	try {
		const run = store.getWorkflowRun(identity.runId);
		const node = store.getWorkflowRunNode(
			identity.runId,
			identity.nodeId,
			identity.attempt,
		);
		const activation = identity.activationId
			? store.getWorkflowActivation(identity.activationId)
			: undefined;
		if (
			!run ||
			run.engine_owned !== 1 ||
			run.status !== "active" ||
			run.issue_id !== issueId ||
			run.project_name !== projectName ||
			!run.snapshot ||
			!node ||
			!["pending", "admitted", "running"].includes(node.state) ||
			node.execution_id !== identity.executionId ||
			store
				.listWorkflowRunNodes(identity.runId, identity.nodeId)
				.some((candidate) => candidate.attempt > identity.attempt) ||
			!activation ||
			activation.run_id !== identity.runId ||
			activation.node_id !== identity.nodeId ||
			activation.attempt !== identity.attempt ||
			activation.execution_id !== identity.executionId
		)
			throw refuse();
		const resolved = parseWorkflowRunSnapshot(run.snapshot).resolved.nodes.find(
			(candidate) => candidate.id === identity.nodeId,
		);
		if (!resolved) throw refuse();
		const phase = isWorkflowPhaseRole(resolved.type)
			? resolved.type
			: undefined;
		if (role !== (phase ?? "main")) throw refuse();
		return { phase };
	} catch {
		// No database exception or unknown binding may become a fresh legacy start.
		throw refuse();
	}
}

export interface ProgressResumeDeps {
	/** Presence distinguishes engine authority (including non-phase nodes) from legacy manual resume. */
	workflowPhase?: { phase?: WorkflowPhaseRole };
	docBaseDir: string;
	issueIdentifier: string;
	/** branch B name for the issue/role — MUST match WorktreeManager.worktreeName. */
	branchName: (issueId: string, role: string) => string;
	/** the most recent prior session for this issue/role (running/terminated), if any. */
	priorSession: (issueId: string, role: string) => PriorSessionRow | undefined;
	/** `git show <branch>:<path>` — the committed blob, or null if absent. */
	readBranchFile: (branch: string, path: string) => MaybePromise<string | null>;
	/** `git rev-parse <branch>` — the branch tip SHA, or null. */
	branchTip: (branch: string) => MaybePromise<string | null>;
	/**
	 * FLY-795 (code-review MED-4): discover the doc dir that actually carries a
	 * committed `progress.md` for this issue on the branch (e.g. via
	 * `git ls-tree -r <branch>` filtered to the issue-prefixed doc folders'
	 * `progress.md`), or null. Used when no `plan_path` is persisted yet (runner
	 * died before design_review) so a co-located, slug-named progress.md is still
	 * found instead of falling through to the deterministic default and missing it.
	 */
	discoverDocDir?: (branch: string) => MaybePromise<string | null>;
}

// FLY-795: `stageToPhase` moved to flywheel-config (progress-schema.ts) so the
// resume-detect side (here) and the write side (`flywheel-comm progress`
// phase-vs-stage cross-check) share ONE mapping. Re-exported for existing
// importers of this module.
export { stageToPhase };

/**
 * Compute the resume decision, or null when the runner should start fresh (no
 * prior execution, or no committed progress.md on branch B).
 */
export async function computeProgressResume(
	issueId: string,
	role: string,
	resumeKind: ResumeKind,
	deps: ProgressResumeDeps,
): Promise<ProgressResumeInfo | null> {
	const prior = deps.priorSession(issueId, role);
	if (!prior) return null;

	const branch = deps.branchName(issueId, role);
	// Path precedence: persisted plan_path dirname (①) → a doc dir discovered on the
	// branch that actually holds progress.md (②, MED-4: covers a runner that died
	// before plan_path was persisted, so its co-located slug-named ledger is still
	// found) → deterministic default (③). Discovery only when no plan_path.
	const discoveredDocDir = prior.plan_path
		? undefined
		: ((await deps.discoverDocDir?.(branch)) ?? undefined);
	const progressPath = resolveProgressPath({
		docBaseDir: deps.docBaseDir,
		issueIdentifier: deps.issueIdentifier,
		...(prior.plan_path && { planPath: prior.plan_path }),
		...(discoveredDocDir && { discoveredDocDir }),
	});

	// Read the BRANCH blob — never the worktree fs (it may be gone on reboot).
	const blob = await deps.readBranchFile(branch, progressPath);
	if (blob == null) return null;

	let ledgerPhase: WorkflowPhaseRole;
	try {
		ledgerPhase = parseProgress(blob).phase;
	} catch {
		// unparseable / non-ledger blob → do not resume (start fresh, fail-safe).
		return null;
	}

	const tip = await deps.branchTip(branch);
	if (!tip) return null;

	// Engine phase authority never comes from the prior content-source session.
	// Suppress only when current authority AGREES
	// with the ledger phase (else undefined = suppress nothing, fail-closed).
	const statePhase = deps.workflowPhase
		? deps.workflowPhase.phase
		: prior.session_stage
			? stageToPhase(prior.session_stage)
			: undefined;
	const effectiveStage =
		statePhase && statePhase === ledgerPhase ? statePhase : undefined;

	return {
		progressPath,
		priorExecutionId: prior.execution_id,
		resumeKind,
		...(effectiveStage && { effectiveStage }),
		startPoint: tip,
		shareParentBranch: true,
	};
}
