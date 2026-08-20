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
	authorizeLeadWrite,
	forwardedLeadAuthorizationEnv,
	LeadLeaseDeniedError,
	type LeadWriteAuthorization,
	type LeadWriteAuthorizationDeps,
	type MessageProvenance,
} from "flywheel-comm/lead-lease";
import {
	type FounderReworkHint,
	isExplicitFounderKickback,
} from "../../workflow-rework-hint.js";
import {
	isDeferrableReviewHoldReason,
	type ReviewHoldReason,
} from "../auto-qa-held.js";
import type { GateAuthorityView } from "./gate-authority-view.js";

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
	insertResponse(
		id: string,
		fromAgent: string,
		content: string,
		provenance?: MessageProvenance,
	): { written: true } | { written: false; reason: "gate_not_open" };
	insertFounderApprovalResponseWithSource?(input: {
		project: string;
		sourceEventId: string;
		questionId: string;
		fromAgent: string;
		content: string;
		expectedOwner: string;
		payload: unknown;
		provenance?: MessageProvenance;
	}): boolean;
	trustedFounderGateResponse?(input: {
		questionId: string;
		fromAgent: string;
		content: string;
		expectedOwner: string;
		msgId: string;
		now: string;
		approvalSource?: {
			project: string;
			sourceEventId: string;
			payload: unknown;
		};
	}): { responseId: string };
}

export interface FounderGateMessageContext {
	msgId: string;
	now: string;
}

/** Preserved caller identity, independent from the final founder attribution. */
export interface LeadRequestContext {
	requestingLeadId: string;
	projectName: string;
	identityDigest: string;
	leaseClaim?: { leaseKey: string; generation: number };
	/** Raw capability: request memory only; never include in persistence/logging. */
	carrierClaim?: string;
	provenance?: MessageProvenance;
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
	/** Engine-owned land_v1 authority; absent keeps the legacy session path. */
	gateAuthorityView?: GateAuthorityView;
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
	/** Server-confirmed non-approval intent; required when text is not self-explicit. */
	intent?: "kickback";
	/** Reaction routes identify the exact card message being acted on. */
	targetMessageId?: string;
	/** Optional downstream authority seam. Absence preserves FLY-1244 behavior. */
	cardAuthority?: FounderApprovalCardAuthority;
	/** Canonical founder identity used to distinguish trusted approval writers. */
	founderId?: string;
	/** FLY-1392: present only for founder thread/card ingress. */
	founderMessage?: FounderGateMessageContext;
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
	 * Server-interpreted routing hint for a trusted founder correction. This is
	 * never founder authority: the immutable feedback text remains the authority,
	 * while StateStore validates and versions this impact plan separately.
	 */
	founderRework?: FounderReworkHint;
	/**
	 * Present only for the token-authenticated Lead HTTP route. Internal founder
	 * writers omit this and retain their existing trusted-server path.
	 */
	leadRequest?: LeadRequestContext;
	/** Bridge-side control plane; request claim fields override only claim keys. */
	leadLeaseEnv?: NodeJS.ProcessEnv;
	/** Injectable OS seams for deterministic carrier/lstart tests. */
	leadWriteAuthorizationDeps?: LeadWriteAuthorizationDeps;
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

function leadRequestEnv(
	context: LeadRequestContext,
	base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return forwardedLeadAuthorizationEnv(
		{
			claimedLeadId: context.requestingLeadId,
			projectName: context.projectName,
			identityDigest: context.identityDigest,
			...(context.leaseClaim ? { leaseClaim: context.leaseClaim } : {}),
			...(context.carrierClaim ? { carrierClaim: context.carrierClaim } : {}),
		},
		base,
	);
}

function requestWriterProvenance(
	authorization: LeadWriteAuthorization,
	request: MessageProvenance | undefined,
): MessageProvenance {
	return {
		senderLeaseKey: authorization.provenance?.senderLeaseKey,
		senderGeneration: authorization.provenance?.senderGeneration,
		senderHolderPid: authorization.provenance?.senderHolderPid,
		senderHolderStart: authorization.provenance?.senderHolderStart,
		writerPid:
			typeof request?.writerPid === "number" &&
			Number.isSafeInteger(request.writerPid) &&
			request.writerPid > 0
				? request.writerPid
				: null,
		writerStart:
			typeof request?.writerStart === "string" && request.writerStart.length > 0
				? request.writerStart
				: null,
	};
}

export interface WriteGateResponseResult {
	written: boolean;
	retrySafe: boolean;
	disposition?:
		| "written"
		| "already_applied"
		| "defer"
		| "reject"
		| "neutral_not_written";
	reason?: string;
}

function isApproval(answer: string): boolean {
	try {
		return JSON.parse(answer)?.approved === true;
	} catch {
		return false;
	}
}

function founderFeedbackVerbatim(answer: string): string {
	try {
		const parsed = JSON.parse(answer) as { feedback?: unknown };
		return typeof parsed.feedback === "string" ? parsed.feedback : answer;
	} catch {
		return answer;
	}
}

function hasExplicitKickback(args: WriteGateResponseArgs): boolean {
	if (args.intent === "kickback") return true;
	return isExplicitFounderKickback(founderFeedbackVerbatim(args.answer));
}

function founderReworkPayload(args: WriteGateResponseArgs, approved: boolean) {
	if (approved || !args.founderRework) return {};
	return {
		rework: {
			target: args.founderRework.target,
			invalidation_scope: args.founderRework.invalidationScope,
			verification_policy: args.founderRework.verificationPolicy,
			interpreted_by: args.founderRework.interpretedBy,
			interpretation_reason: args.founderRework.interpretationReason,
		},
	};
}

async function runHook(args: WriteGateResponseArgs): Promise<boolean> {
	const engineAuthority = args.gateAuthorityView?.resolve(
		args.questionId,
		args.executionId,
	);
	if (engineAuthority && engineAuthority.authorityMode !== "runner_ship") {
		// The durable source projector advances the holder and activates land.
		// Flipping/waking the already-finished QA source execution is neither an
		// authority fact nor a required postcondition.
		return true;
	}
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
	if (args.leadRequest && args.founderRework) {
		throw new Error("lead requests cannot carry founder rework hints");
	}
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

	const engineAuthority = args.gateAuthorityView?.resolve(
		args.questionId,
		args.executionId,
	);
	const liveSession = args.store.getSession(args.executionId);
	const status = liveSession?.status;
	if (
		!engineAuthority &&
		status !== "awaiting_review" &&
		status !== "approved_to_ship"
	) {
		return guardOk(`status_${status ?? "unknown"}`);
	}
	if (
		engineAuthority &&
		engineAuthority.state !== "awaiting_review" &&
		engineAuthority.state !== "approved"
	) {
		return guardOk(`holder_${engineAuthority.state}`);
	}

	// FLY-799 (Codex R1 HIGH-2): re-read the session's CURRENT review binding at
	// WRITE time — not the caller's snapshot. The founder-reply handler snapshots
	// the session, then the Tier-3 evaluation can take seconds; if a re-review
	// re-bound the session to a NEW review question meanwhile, the snapshot is
	// stale and this stale gate must NOT be answered (Surface B already re-reads
	// live via getCurrentReviewQuestionId — this gives the founder-reply path the
	// same TOCTOU-closed guard).
	const liveReviewQid = liveSession?.review_question_id;
	if (!engineAuthority && liveReviewQid && liveReviewQid !== args.questionId) {
		return guardOk("stale_review_question_live");
	}

	let leadProvenance: MessageProvenance | undefined;
	if (args.leadRequest) {
		try {
			const authorization = authorizeLeadWrite(
				{
					claimedLeadId: args.leadRequest.requestingLeadId,
					env: leadRequestEnv(
						args.leadRequest,
						args.leadLeaseEnv ?? process.env,
					),
				},
				args.leadWriteAuthorizationDeps,
			);
			leadProvenance = requestWriterProvenance(
				authorization,
				args.leadRequest.provenance,
			);
		} catch (error) {
			return {
				written: false,
				retrySafe: true,
				disposition: "reject",
				reason:
					error instanceof LeadLeaseDeniedError
						? `lead_lease_denied:${error.reason}`
						: "lead_lease_authorization_error",
			};
		}
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

	if (!isApproval(args.answer) && !hasExplicitKickback(args)) {
		return {
			written: false,
			retrySafe: true,
			disposition: "neutral_not_written",
			reason: "explicit_kickback_required",
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

	if (
		isApproval(args.answer) &&
		engineAuthority &&
		args.source === "reaction" &&
		args.targetMessageId !== engineAuthority.cardMessageId
	) {
		return {
			written: false,
			retrySafe: true,
			disposition: "reject",
			reason: "card_authority_engine_card_mismatch",
		};
	}
	if (isApproval(args.answer) && args.cardAuthority && !engineAuthority) {
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
	const derivedFounderSource = engineAuthority
		? {
				project: engineAuthority.projectName,
				runId: engineAuthority.runId,
				issueId: engineAuthority.issueId,
				approvedHead: engineAuthority.headSha,
				classification:
					args.actor === "bridge"
						? "dashboard_founder_action"
						: args.actor === "bridge-founder-consent"
							? "founder_consent_enforce"
							: "founder_direct_signal",
				authorityId: args.questionId,
			}
		: activeRun &&
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
	const approved = isApproval(args.answer);
	const trustedFounderSourceDecision =
		(approved || engineAuthority !== undefined) &&
		isTrustedApprovalAttribution(args.actor, args.founderId) &&
		founderSource !== undefined;
	const trustedFounderDecision =
		trustedFounderSourceDecision &&
		args.db.insertFounderApprovalResponseWithSource !== undefined;
	const trustedFounderMessage =
		args.founderMessage &&
		isTrustedApprovalAttribution(args.actor, args.founderId) &&
		args.db.trustedFounderGateResponse !== undefined &&
		(!isApproval(args.answer) || founderSource !== undefined);
	if (trustedFounderMessage) {
		const founderMessage = args.founderMessage!;
		const source = founderSource;
		args.db.trustedFounderGateResponse!({
			questionId: args.questionId,
			fromAgent: args.actor,
			content: args.answer,
			expectedOwner: args.executionId,
			msgId: founderMessage.msgId,
			now: founderMessage.now,
			...(trustedFounderSourceDecision && source
				? {
						approvalSource: {
							project: source.project,
							sourceEventId: `${approved ? "founder-approval" : "founder-feedback"}:${args.questionId}:${founderMessage.msgId}`,
							payload: {
								schema_version: 1,
								run_id: source.runId,
								issue_id: source.issueId,
								question_id: args.questionId,
								response: approved
									? { approved: true }
									: {
											approved: false,
											feedback: founderFeedbackVerbatim(args.answer),
										},
								...founderReworkPayload(args, approved),
								actor: args.actor,
								approved_head: source.approvedHead,
								classification: source.classification,
								authority_id: source.authorityId,
								msg_id: founderMessage.msgId,
							},
						},
					}
				: {}),
		});
	} else if (trustedFounderDecision) {
		const source = founderSource!;
		const wrote = args.db.insertFounderApprovalResponseWithSource!({
			project: source.project,
			sourceEventId: `${approved ? "founder-approval" : "founder-feedback"}:${args.questionId}`,
			questionId: args.questionId,
			fromAgent: args.actor,
			content: args.answer,
			expectedOwner: args.executionId,
			payload: {
				schema_version: 1,
				run_id: source.runId,
				issue_id: source.issueId,
				question_id: args.questionId,
				response: approved
					? { approved: true }
					: {
							approved: false,
							feedback: founderFeedbackVerbatim(args.answer),
						},
				...founderReworkPayload(args, approved),
				actor: args.actor,
				approved_head: source.approvedHead,
				classification: source.classification,
				authority_id: source.authorityId,
			},
			...(leadProvenance ? { provenance: leadProvenance } : {}),
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
		const writeResult = leadProvenance
			? args.db.insertResponse(
					args.questionId,
					args.actor,
					args.answer,
					leadProvenance,
				)
			: args.db.insertResponse(args.questionId, args.actor, args.answer);
		if (!writeResult.written) {
			return {
				written: false,
				retrySafe: true,
				disposition: "reject",
				reason: `response_write_${writeResult.reason}`,
			};
		}
	}
	const ok = await runHook(args);
	return { written: true, retrySafe: ok, disposition: "written" };
}
