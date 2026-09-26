import type { ProgressResumeInfo } from "./progress-resume.js";

/**
 * FLY-795: compute the restart-resilient resume decision for a (re-)dispatch.
 * Returns a ProgressResumeInfo when a prior execution + committed progress.md on
 * branch B are found; null ⇒ start fresh. Injected into RunDispatcher so the
 * live git/StateStore lookups stay out of the generic dispatcher.
 */
export type ResumeComputer = (
	issueId: string,
	role: string,
	projectName: string,
) => ProgressResumeInfo | null | Promise<ProgressResumeInfo | null>;

/** FLY-1718 P1: explanatory metadata for a structurally inherited branch. */
export interface ContinuityInherit {
	branch: string;
	sha: string;
	prNumber?: number;
	prUrl?: string;
}

/** FLY-1718 P1: origin-backed decision for an otherwise-fresh dispatch. */
export type ContinuityStartPoint =
	| ({ kind: "found" } & ContinuityInherit)
	| { kind: "missing"; branch?: string }
	| { kind: "indeterminate"; error: string };

export type ContinuityComputer = (input: {
	issueId: string;
	role: string;
	projectName: string;
	shareParentBranch?: boolean;
}) => Promise<ContinuityStartPoint>;

export class ContinuityIndeterminateError extends Error {
	readonly code = "CONTINUITY_INDETERMINATE";
	readonly retryable = true;

	constructor(public readonly detail: string) {
		super(`branch continuity is indeterminate: ${detail}`);
		this.name = "ContinuityIndeterminateError";
	}
}

export class FreshStartAuditError extends Error {
	readonly code = "FRESH_START_AUDIT_FAILED";

	constructor(detail: string) {
		super(`fresh-start override refused: ${detail}`);
		this.name = "FreshStartAuditError";
	}
}

export interface WorkflowStartPolicyRequest {
	issueId: string;
	role: string;
	projectName: string;
	startPoint?: string;
	shareParentBranch?: boolean;
	freshStart?: boolean;
}

export interface WorkflowStartPolicy {
	resume: ProgressResumeInfo | null;
	continuityInherit?: ContinuityInherit;
	continuityBranch?: string;
	skippedOriginTip?: string;
	startPoint?: string;
	shareParentBranch?: boolean;
}

/** Shared selection only: observers own refresh vs read-only evidence access.
 * Lifecycle admission, durable fresh-start audit, and worktree creation stay
 * with the caller. Preserve all context; a selected SHA alone loses semantics.
 */
export async function resolveWorkflowStartPolicy(
	request: WorkflowStartPolicyRequest,
	observers: {
		observeResume?: ResumeComputer;
		observeContinuity?: ContinuityComputer;
	},
): Promise<WorkflowStartPolicy> {
	if (request.freshStart && request.startPoint)
		throw new FreshStartAuditError(
			"freshStart cannot be combined with a caller-pinned start",
		);
	const computedResume =
		(await observers.observeResume?.(
			request.issueId,
			request.role,
			request.projectName,
		)) ?? null;
	const resume = request.freshStart ? null : computedResume;
	let continuityInherit: ContinuityInherit | undefined;
	let continuityBranch: string | undefined;
	let skippedOriginTip: string | undefined;
	if (!request.startPoint && !resume && observers.observeContinuity) {
		const continuity = await observers.observeContinuity({
			issueId: request.issueId,
			role: request.role,
			projectName: request.projectName,
			shareParentBranch: request.shareParentBranch,
		});
		if (continuity.kind === "indeterminate")
			throw new ContinuityIndeterminateError(continuity.error);
		continuityBranch = continuity.branch;
		if (continuity.kind === "found") {
			skippedOriginTip = continuity.sha;
			if (!request.freshStart)
				continuityInherit = {
					branch: continuity.branch,
					sha: continuity.sha,
					...(continuity.prNumber !== undefined
						? { prNumber: continuity.prNumber }
						: {}),
					...(continuity.prUrl ? { prUrl: continuity.prUrl } : {}),
				};
		}
	}
	return {
		resume,
		continuityInherit,
		continuityBranch,
		skippedOriginTip,
		startPoint:
			request.startPoint ?? resume?.startPoint ?? continuityInherit?.sha,
		shareParentBranch: request.shareParentBranch ?? (resume ? true : undefined),
	};
}
