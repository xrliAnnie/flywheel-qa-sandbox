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
 * `effectiveStage` is derived from the StateStore stage AUTHORITY and cross-checked
 * against the ledger's `phase`; on mismatch it is `undefined` = "suppress no gates"
 * (Codex R2 #4 fail-closed) — a stale / tampered ledger can never skip a mandatory
 * brainstorm/design gate.
 */

import type { ThreeStagePhase } from "flywheel-config";
import { parseProgress, resolveProgressPath } from "flywheel-config";

export type ResumeKind = "restart" | "terminate" | "reboot" | "handoff";

export interface ProgressResumeInfo {
	/** deterministic progress.md path (also injected to the runner as FLYWHEEL_PROGRESS_PATH). */
	progressPath: string;
	priorExecutionId: string;
	resumeKind: ResumeKind;
	/** phase to suppress up-to; undefined = suppress nothing (fail-closed on mismatch). */
	effectiveStage?: ThreeStagePhase;
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

export interface ProgressResumeDeps {
	docBaseDir: string;
	issueIdentifier: string;
	/** branch B name for the issue/role — MUST match WorktreeManager.worktreeName. */
	branchName: (issueId: string, role: string) => string;
	/** the most recent prior session for this issue/role (running/terminated), if any. */
	priorSession: (issueId: string, role: string) => PriorSessionRow | undefined;
	/** `git show <branch>:<path>` — the committed blob, or null if absent. */
	readBranchFile: (branch: string, path: string) => string | null;
	/** `git rev-parse <branch>` — the branch tip SHA, or null. */
	branchTip: (branch: string) => string | null;
}

const DESIGN_STAGES = new Set([
	"started",
	"onboard",
	"brainstorm",
	"research",
	"plan",
	"design_review",
	"design_done",
	"design",
]);
const IMPLEMENT_STAGES = new Set([
	"implement",
	"test",
	"code_review",
	"pr_created",
]);
const QA_STAGES = new Set(["qa", "approve", "ship", "code_review_qa"]);

/** Map a fine-grained pipeline stage to its three-stage phase (or undefined). */
export function stageToPhase(stage: string): ThreeStagePhase | undefined {
	if (DESIGN_STAGES.has(stage)) return "design";
	if (IMPLEMENT_STAGES.has(stage)) return "implement";
	if (QA_STAGES.has(stage)) return "qa";
	return undefined;
}

/**
 * Compute the resume decision, or null when the runner should start fresh (no
 * prior execution, or no committed progress.md on branch B).
 */
export function computeProgressResume(
	issueId: string,
	role: string,
	resumeKind: ResumeKind,
	deps: ProgressResumeDeps,
): ProgressResumeInfo | null {
	const prior = deps.priorSession(issueId, role);
	if (!prior) return null;

	const branch = deps.branchName(issueId, role);
	const progressPath = resolveProgressPath({
		docBaseDir: deps.docBaseDir,
		issueIdentifier: deps.issueIdentifier,
		...(prior.plan_path && { planPath: prior.plan_path }),
	});

	// Read the BRANCH blob — never the worktree fs (it may be gone on reboot).
	const blob = deps.readBranchFile(branch, progressPath);
	if (blob == null) return null;

	let ledgerPhase: ThreeStagePhase;
	try {
		ledgerPhase = parseProgress(blob).phase;
	} catch {
		// unparseable / non-ledger blob → do not resume (start fresh, fail-safe).
		return null;
	}

	const tip = deps.branchTip(branch);
	if (!tip) return null;

	// effectiveStage authority = StateStore stage; suppress only when it AGREES
	// with the ledger phase (else undefined = suppress nothing, fail-closed).
	const statePhase = prior.session_stage
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
