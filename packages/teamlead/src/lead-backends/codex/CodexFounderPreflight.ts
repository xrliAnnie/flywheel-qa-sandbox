/**
 * FLY-224 Phase 5 — CodexFounderPreflight: the Codex Lead's mandatory founder
 * authorization check before any founder-gated action (merge / ship /
 * runner-lifecycle). Plan §6 + Phase 0A §7; gatekept by team-lead as CONSUME-ONLY.
 *
 * This does NOT change or weaken the founder gate (FLY-175 / founder-only-authority
 * / the Bridge FounderConsentEvaluator). It is a read-only CONSUMER that reuses the
 * SAME `verifyApproval` (flywheel-comm) as a Claude Lead — the exact same CommDB +
 * StateStore authorization (review_question_id ↔ approved_to_ship ↔ pr_head_sha).
 * A Codex Lead is just "another caller" of the same authority; there is NO
 * Codex-specific bypass, allowlist, or exemption.
 *
 * FAIL-CLOSED is the hard contract: a turn may proceed to the gated action ONLY
 * when verifyApproval returns `approved === true` AND `reason === "approved"`.
 * EVERYTHING else rejects:
 *   - no approval (gate_not_answered / review_question_unbound / …),
 *   - FORGED approval (response_not_structured_approval — a bare-text "approved"),
 *   - STALE approval (pr_head_sha_mismatch — approved, then a commit was added),
 *   - unreadable DB / parse errors / a thrown verify / missing context.
 * Uncertainty is a rejection, never a blind send.
 *
 * `verify` is injected (the Phase 2b runtime wires the real flywheel-comm
 * `verifyApproval`); tests inject a fake. This is the enforcement PRIMITIVE — the
 * Codex Lead runtime MUST call `check()` before merge/ship/runner-lifecycle and
 * abort on `!allowed`.
 */

import type {
	VerifyApprovalArgs,
	VerifyApprovalReason,
	VerifyApprovalResult,
} from "flywheel-comm/verify-approval";

export type FounderGatedAction = "merge" | "ship" | "runner_lifecycle";

export interface FounderPreflightContext {
	action: FounderGatedAction;
	/** The session/exec whose approval is being verified. */
	execId: string;
	/** The runner's CURRENT PR head — full 40-hex sha (git rev-parse HEAD). */
	prHead: string;
	/** CommDB path. */
	dbPath: string;
	/** StateStore (teamlead.db) path override. */
	stateDbPath?: string;
}

export type PreflightReason =
	| VerifyApprovalReason
	| "missing_context"
	| "verify_threw";

export interface FounderPreflightDecision {
	allowed: boolean;
	reason: PreflightReason;
	action: FounderGatedAction;
	detail?: {
		questionId?: string;
		responseFrom?: string;
		status?: string;
		expectedPrHeadSha?: string;
	};
}

export type VerifyApprovalFn = (
	args: VerifyApprovalArgs,
) => VerifyApprovalResult;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export interface CodexFounderPreflightOptions {
	/** The authority check — the runtime wires flywheel-comm `verifyApproval`. */
	verify: VerifyApprovalFn;
	logger?: { warn: (m: string, c?: unknown) => void };
}

export class CodexFounderPreflight {
	private readonly verify: VerifyApprovalFn;
	private readonly logger: { warn: (m: string, c?: unknown) => void };

	constructor(opts: CodexFounderPreflightOptions) {
		if (typeof opts.verify !== "function") {
			throw new Error("CodexFounderPreflight: verify fn is required");
		}
		this.verify = opts.verify;
		this.logger = opts.logger ?? { warn: () => {} };
	}

	/**
	 * Verify founder authorization for `ctx.action`. FAIL-CLOSED: returns
	 * `allowed: true` ONLY for a genuine structured approval bound to the current
	 * PR head; any rejection reason, a thrown verify, or missing context →
	 * `allowed: false`.
	 */
	check(ctx: FounderPreflightContext): FounderPreflightDecision {
		// Fail-closed context validation — never call the gate (or proceed) on a
		// malformed request.
		if (!ctx.execId || !ctx.dbPath) {
			return this.reject(ctx, "missing_context");
		}
		if (!FULL_SHA_RE.test(ctx.prHead)) {
			// Mirror verify-approval's own reason for a bad head.
			return this.reject(ctx, "invalid_pr_head_format");
		}

		let result: VerifyApprovalResult;
		try {
			result = this.verify({
				execId: ctx.execId,
				prHead: ctx.prHead,
				dbPath: ctx.dbPath,
				stateDbPath: ctx.stateDbPath,
			});
		} catch (err) {
			this.logger.warn("founder preflight: verify threw → rejecting", {
				action: ctx.action,
				err: (err as Error).message,
			});
			return this.reject(ctx, "verify_threw");
		}

		// BOTH must hold — defense-in-depth (approved:true must carry reason
		// "approved"; anything else is treated as not-approved).
		const allowed = result.approved === true && result.reason === "approved";
		return {
			allowed,
			reason: result.reason,
			action: ctx.action,
			detail: {
				questionId: result.questionId,
				responseFrom: result.responseFrom,
				status: result.status,
				expectedPrHeadSha: result.expectedPrHeadSha,
			},
		};
	}

	private reject(
		ctx: FounderPreflightContext,
		reason: PreflightReason,
	): FounderPreflightDecision {
		return { allowed: false, reason, action: ctx.action };
	}
}
