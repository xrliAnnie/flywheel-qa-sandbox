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

/** Structural CommDB surface (real CommDB satisfies it; tests inject a fake). */
export interface GateResponseDb {
	getMessageById(
		id: string,
	): { checkpoint: string | null; from_agent: string } | undefined;
	getResponse(id: string): { content: string; from_agent: string } | undefined;
	insertResponse(id: string, fromAgent: string, content: string): void;
}

/** Structural StateStore surface. */
export interface GateResponseStore {
	getSession(executionId: string): { status?: string } | undefined;
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
	/**
	 * Best-effort post-write side effects (flip awaiting_review→approved_to_ship +
	 * wake). Returns an observable outcome so the caller can decide retrySafe.
	 */
	onResponseWritten?: (info: {
		executionId: string;
		questionId: string;
		actor: string;
		answer: string;
	}) => Promise<{ ok: boolean }> | { ok: boolean } | void;
}

export interface WriteGateResponseResult {
	written: boolean;
	retrySafe: boolean;
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
		const out = await args.onResponseWritten({
			executionId: args.executionId,
			questionId: args.questionId,
			actor: args.actor,
			answer: args.answer,
		});
		// void / undefined → treat as ok (fire-and-forget hooks).
		return out == null ? true : out.ok !== false;
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

	const status = args.store.getSession(args.executionId)?.status;
	if (status !== "awaiting_review" && status !== "approved_to_ship") {
		return guardOk(`status_${status ?? "unknown"}`);
	}

	// Idempotent retry vs conflict.
	const prior = args.db.getResponse(args.questionId);
	if (prior) {
		if (isApproval(prior.content) !== isApproval(args.answer)) {
			return guardOk("conflicting_prior_response");
		}
		// Same decision already recorded — re-run the (idempotent) hook only.
		const ok = await runHook(args);
		return { written: false, retrySafe: ok, reason: "already_answered" };
	}

	// Fresh write, then the post-write hook.
	args.db.insertResponse(args.questionId, args.actor, args.answer);
	const ok = await runHook(args);
	return { written: true, retrySafe: ok };
}
