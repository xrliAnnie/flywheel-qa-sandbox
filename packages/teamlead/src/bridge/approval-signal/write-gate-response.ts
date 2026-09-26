/**
 * FLY-799 Part A-4 — shared writeGateResponseAndRunPostWrite.
 *
 * The ONE trusted write primitive for `approve_to_ship` gate responses, shared
 * by Surface B (gate-response-router) and the founder-reply path (Codex R1 #3),
 * so the two can never drift into subtly-different approval semantics. Mirrors
 * the gate-response-router / approveExecution guards + idempotency:
 *   - checkpoint MUST be approve_to_ship;
 *   - questionId MUST equal the session's current review question (when known);
 *   - session MUST be awaiting_review (or already approved_to_ship — idempotent);
 *   - a prior IDENTICAL answer re-runs the post-write hook without double-writing;
 *   - a prior CONFLICTING answer is rejected (a different decision needs a new
 *     review round).
 *
 * `retrySafe` tells the founder-reply caller whether it may advance its
 * processed-through cursor: it is false ONLY when the response reached a durable
 * state but the post-write hook did not (so the caller re-runs next pass — the
 * hook is idempotent). All guard rejections are retrySafe (nothing to do here).
 */

import { isTrustedApprovalAttribution } from "flywheel-comm/founder-attribution";
import {
	isDeferrableReviewHoldReason,
	type ReviewHoldReason,
} from "../auto-qa-held.js";

export type FounderApprovalRouteSource =
	| "reaction"
	| "text"
	| "voice"
	| "deferred"
	| "actions"
	| "founder-consent";

export interface FounderApprovalCardAuthorityInput {
	executionId: string;
	source: FounderApprovalRouteSource;
	targetMessageId?: string;
}

export type FounderApprovalCardAuthority = (
	input: FounderApprovalCardAuthorityInput,
) => { ok: true } | { ok: false; reason: string };

/** Structural CommDB surface (real CommDB satisfies it; tests inject a fake). */
export interface GateResponseDb {
	getMessageById(
		id: string,
	): { checkpoint: string | null; from_agent: string } | undefined;
	getResponse(id: string): { content: string; from_agent: string } | undefined;
	insertResponse(id: string, fromAgent: string, content: string): void;
	insertFounderApprovalResponseWithSource?(input: {
		project: string;
		sourceEventId: string;
		questionId: string;
		fromAgent: string;
		content: string;
		expectedOwner: string;
		payload: unknown;
	}): boolean;
}

/** Structural StateStore surface. */
export interface GateResponseStore {
	getSession(executionId: string):
		| {
				status?: string;
				review_question_id?: string | null;
				project_name?: string;
				issue_id?: string;
				pr_head_sha?: string | null;
		  }
		| undefined;
	getActiveWorkflowRun?(
		projectName: string,
		issueId: string,
	): { run_id: string } | undefined;
}

export interface WriteGateResponseArgs {
	db: GateResponseDb;
	store: GateResponseStore;
	questionId: string;
	executionId: string;
	/** Actor written to the response: the founder id (founder-reply) or leadId (Surface B). */
	actor: string;
	/** '{"approved":true}' for approval, or feedback JSON/text. */
	answer: string;
	/** Session's current review_question_id — when set, only it is answerable. */
	expectedCurrentReviewQuestionId?: string;
	/** Live ship-review hold. Checked in this shared write boundary. */
	holdReasonFor?: (executionId: string) => ReviewHoldReason | null;
	/** Fixed by each production caller; every founder-write route is explicit. */
	source: FounderApprovalRouteSource;
	/** Reaction routes identify the exact card message being acted on. */
	targetMessageId?: string;
	/** Optional downstream authority seam. Absence preserves FLY-1244 behavior. */
	cardAuthority?: FounderApprovalCardAuthority;
	/** Canonical founder identity used to distinguish trusted approval writers. */
	founderId?: string;
	/** Frozen source metadata for a claims-enrolled workflow run. */
	founderSource?: {
		project: string;
		runId: string;
		issueId: string;
		approvedHead: string;
		classification: string;
		authorityId: string;
	};
	/**
	 * Best-effort post-write side effects (flip awaiting_review→approved_to_ship +
	 * wake). May return an `{ ok: boolean }` outcome (sync or via a Promise) so the
	 * caller can decide retrySafe; a void / fire-and-forget hook is treated as ok.
	 */
	onResponseWritten?: (info: {
		executionId: string;
		questionId: string;
		actor: string;
		answer: string;
		/** The CommDB the response was written to (the wake needs it). */
		db: GateResponseDb;
	}) => unknown;
}

export interface WriteGateResponseResult {
	written: boolean;
	retrySafe: boolean;
	disposition?: "written" | "already_applied" | "defer" | "reject";
	reason?: string;
}

function isApproval(answer: string): boolean {
	try {
		return JSON.parse(answer)?.approved === true;
	} catch {
		return false;
	}
}

async function runHook(args: WriteGateResponseArgs): Promise<boolean> {
	if (!args.onResponseWritten) return true;
	try {
		const out = await Promise.resolve(
			args.onResponseWritten({
				executionId: args.executionId,
				questionId: args.questionId,
				actor: args.actor,
				answer: args.answer,
				db: args.db,
			}),
		);
		// An { ok:false } outcome means the hook did not reach a safe state; a void
		// / fire-and-forget hook (or { ok:true }) is treated as ok.
		if (
			out &&
			typeof out === "object" &&
			(out as { ok?: unknown }).ok === false
		) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

export async function writeGateResponseAndRunPostWrite(
	args: WriteGateResponseArgs,
): Promise<WriteGateResponseResult> {
	const guardOk = (reason: string): WriteGateResponseResult => ({
		written: false,
		retrySafe: true,
		reason,
	});

	const question = args.db.getMessageById(args.questionId);
	if (!question) return guardOk("question_missing");
	if (question.checkpoint !== "approve_to_ship") {
		return guardOk("not_approve_to_ship");
	}
	if (
		args.expectedCurrentReviewQuestionId &&
		args.expectedCurrentReviewQuestionId !== args.questionId
	) {
		return guardOk("stale_review_question");
	}

	const liveSession = args.store.getSession(args.executionId);
	const status = liveSession?.status;
	if (status !== "awaiting_review" && status !== "approved_to_ship") {
		return guardOk(`status_${status ?? "unknown"}`);
	}

	// FLY-799 (Codex R1 HIGH-2): re-read the session's CURRENT review binding at
	// WRITE time — not the caller's snapshot. The founder-reply handler snapshots
	// the session, then the Tier-3 evaluation can take seconds; if a re-review
	// re-bound the session to a NEW review question meanwhile, the snapshot is
	// stale and this stale gate must NOT be answered (Surface B already re-reads
	// live via getCurrentReviewQuestionId — this gives the founder-reply path the
	// same TOCTOU-closed guard).
	const liveReviewQid = liveSession?.review_question_id;
	if (liveReviewQid && liveReviewQid !== args.questionId) {
		return guardOk("stale_review_question_live");
	}

	// Idempotent retry vs conflict.
	const prior = args.db.getResponse(args.questionId);
	if (prior) {
		if (isApproval(prior.content) !== isApproval(args.answer)) {
			return guardOk("conflicting_prior_response");
		}
		// Same decision already recorded — re-run the (idempotent) hook only.
		const ok = await runHook(args);
		return {
			written: false,
			retrySafe: ok,
			disposition: "already_applied",
			reason: "already_answered",
		};
	}

	// Holds guard NEW decisions only. A response already durable above must be
	// allowed to re-run its idempotent post-write hook; otherwise a hold that
	// arrives between write and hook recovery can strand an answered gate.
	const holdReason = args.holdReasonFor?.(args.executionId) ?? null;
	if (holdReason) {
		return {
			written: false,
			retrySafe: true,
			disposition: isDeferrableReviewHoldReason(holdReason)
				? "defer"
				: "reject",
			reason: `held_${holdReason}`,
		};
	}

	if (isApproval(args.answer) && args.cardAuthority) {
		try {
			const authority = args.cardAuthority({
				executionId: args.executionId,
				source: args.source,
				targetMessageId: args.targetMessageId,
			});
			if (!authority.ok) {
				return {
					written: false,
					retrySafe: true,
					disposition: "reject",
					reason: `card_authority_${authority.reason}`,
				};
			}
		} catch {
			return {
				written: false,
				retrySafe: true,
				disposition: "reject",
				reason: "card_authority_error",
			};
		}
	}

	// Fresh write, then the post-write hook.
	const activeRun =
		liveSession?.project_name && liveSession.issue_id
			? args.store.getActiveWorkflowRun?.(
					liveSession.project_name,
					liveSession.issue_id,
				)
			: undefined;
	const derivedFounderSource =
		activeRun &&
		liveSession?.project_name &&
		liveSession.issue_id &&
		liveSession.pr_head_sha
			? {
					project: liveSession.project_name,
					runId: activeRun.run_id,
					issueId: liveSession.issue_id,
					approvedHead: liveSession.pr_head_sha.toLowerCase(),
					classification:
						args.actor === "bridge"
							? "dashboard_founder_action"
							: args.actor === "bridge-founder-consent"
								? "founder_consent_enforce"
								: "founder_direct_signal",
					authorityId: args.questionId,
				}
			: undefined;
	const founderSource = args.founderSource ?? derivedFounderSource;
	const trustedFounderApproval =
		isApproval(args.answer) &&
		isTrustedApprovalAttribution(args.actor, args.founderId) &&
		founderSource !== undefined &&
		args.db.insertFounderApprovalResponseWithSource !== undefined;
	if (trustedFounderApproval) {
		const source = founderSource!;
		const wrote = args.db.insertFounderApprovalResponseWithSource!({
			project: source.project,
			sourceEventId: `founder-approval:${args.questionId}`,
			questionId: args.questionId,
			fromAgent: args.actor,
			content: args.answer,
			expectedOwner: args.executionId,
			payload: {
				schema_version: 1,
				run_id: source.runId,
				issue_id: source.issueId,
				question_id: args.questionId,
				response: { approved: true },
				actor: args.actor,
				approved_head: source.approvedHead,
				classification: source.classification,
				authority_id: source.authorityId,
			},
		});
		if (!wrote) {
			return {
				written: false,
				retrySafe: true,
				disposition: "reject",
				reason: "atomic_source_write_rejected",
			};
		}
	} else {
		args.db.insertResponse(args.questionId, args.actor, args.answer);
	}
	const ok = await runHook(args);
	return { written: true, retrySafe: ok, disposition: "written" };
}
