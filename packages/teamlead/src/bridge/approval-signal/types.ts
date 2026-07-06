/**
 * FLY-799 Part A — ApprovalSignal abstraction (Annie: extensible to voice/image).
 *
 * Every source (reaction / text / image / [future] voice) normalizes one founder
 * input into a FULLY-BOUND `ApprovalSignal` (discriminated union, Codex R4 #1);
 * the gate-write path is source-agnostic once the signal is bound. Each variant
 * carries `questionId` + `prHeadSha` for audit symmetry, plus source-specific
 * evidence.
 */

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
	  }
	| {
			source: "image";
			kind: "approve" | "reject" | "unclear";
			questionId: string;
			prHeadSha: string;
			messageId: string;
			authorUserId: string;
			evidenceAttachmentIds: string[];
			imageHashes: string[];
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
