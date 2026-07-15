/**
 * FLY-799 Part A — ApprovalSignal abstraction (Annie: extensible to voice).
 *
 * Every source (reaction / text / [future] voice) normalizes one founder
 * input into a FULLY-BOUND `ApprovalSignal` (discriminated union, Codex R4 #1);
 * the gate-write path is source-agnostic once the signal is bound. Each variant
 * carries `questionId` + `prHeadSha` for audit symmetry, plus source-specific
 * evidence.
 */

/**
 * FLY-1041 Chunk 4: WHERE in the tier chain a text signal was decided (and
 * why) — the raw material for the `founder_ship_attribution` audit trail.
 * `tier3_runner_failed` is deliberately distinct from `tier3_unclear`: a
 * classifier spawn failure used to be folded into "unclear" and became
 * un-diagnosable in production (the 「嗯ship」 forensics gap).
 */
export interface ApprovalAttributionEvidence {
	stage:
		| "tier2_approve"
		| "tier2_downgrade"
		| "tier3_approve"
		| "tier3_reject"
		| "tier3_unclear"
		| "tier3_runner_failed";
	reason?: string;
}

export type ApprovalSignal =
	| {
			source: "reaction";
			kind: "approve";
			questionId: string;
			prHeadSha: string;
			targetMessageId: string;
			emoji: "✅";
			reactorUserId: string;
	  }
	| {
			source: "text";
			kind: "approve" | "reject" | "unclear";
			questionId: string;
			prHeadSha: string;
			messageId: string;
			authorUserId: string;
			/** FLY-1041 Chunk 4: attribution evidence (additive — optional). */
			evidence?: ApprovalAttributionEvidence;
	  }
	| {
			source: "voice";
			kind: "approve" | "reject" | "unclear";
			questionId: string;
			prHeadSha: string;
			transcriptId: string;
	  };

/** Shared per-gate context every source binds against. */
export interface GateBinding {
	questionId: string; // = session's current review_question_id
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	prHeadSha: string;
	prNumber?: number;
	threadId: string;
	canonicalFounderId: string;
	/** Ship-gate notification message id (required for ReactionSource). */
	targetMessageId?: string;
}
