/**
 * FLY-799 Part A — founder REACTION ship-approval handler.
 *
 * The per-gate analog of the text handler (`tryFounderShipApproval`): a founder
 * ✅ on the DURABLY-BOUND ship-gate message is a zero-AI approval. Unlike the
 * text path there is no inbound message — the gate-poller scans each pending
 * approve_to_ship gate every tick and calls this. It:
 *   narrows to the CURRENT review question of an awaiting_review session with a
 *   known pr_head → reads the stored (questionId,prHeadSha)->gateMessageId
 *   binding (A-0b; never inferred) → ReactionSource → on ✅ writes
 *   `{"approved":true}` attributed to the canonical founder via the shared write
 *   helper (flip + wake).
 *
 * Self-limiting: once the write flips the session to approved_to_ship the gate
 * drops out of the awaiting_review filter, so a re-poll can't double-approve
 * (and the shared write helper is idempotent regardless). Returns null (no
 * signal / narrow miss) → the gate-poller simply re-checks next tick.
 */

import type { ReactionFetcher } from "../../lead-backends/codex/gateway/founder-confirmation.js";
import type { GateMessageBinding } from "./gate-message-binding.js";
import { evaluateReactionSource } from "./reaction-approval-source.js";
import type { GateBinding } from "./types.js";
import {
	type GateResponseDb,
	writeGateResponseAndRunPostWrite,
} from "./write-gate-response.js";

interface HandlerSession {
	status?: string;
	review_question_id?: string | null;
	pr_head_sha?: string | null;
	pr_number?: number | null;
	issue_identifier?: string | null;
}

export interface ReactionApprovalHandlerDeps {
	canonicalFounderId: string;
	store: { getSession(executionId: string): HandlerSession | undefined };
	db: GateResponseDb;
	reactionFetcherImpl: ReactionFetcher;
	/** Read the single current binding for (executionId, questionId, prHeadSha). */
	readBindingImpl: (
		executionId: string,
		questionId: string,
		prHeadSha: string,
	) => GateMessageBinding | null;
	evaluateReactionImpl?: typeof evaluateReactionSource;
	writeGateResponseImpl?: typeof writeGateResponseAndRunPostWrite;
	onResponseWritten?: Parameters<
		typeof writeGateResponseAndRunPostWrite
	>[0]["onResponseWritten"];
}

export interface ReactionApprovalHandlerArgs {
	gate: {
		questionId: string;
		executionId: string;
		checkpoint: string | null;
		createdAtMs: number;
	};
	ctx: { issueId: string; threadId: string };
}

export async function tryFounderReactionApproval(
	args: ReactionApprovalHandlerArgs,
	deps: ReactionApprovalHandlerDeps,
): Promise<{ handled: string[]; retrySafe: boolean } | null> {
	const { gate } = args;

	// A-2: this must be the CURRENT review question of an awaiting_review session.
	const session = deps.store.getSession(gate.executionId);
	if (
		session?.status !== "awaiting_review" ||
		session.review_question_id !== gate.questionId
	) {
		return null;
	}
	if (!session.pr_head_sha) return null;

	// A-0b: the reaction target is ONLY the durably-bound gate message — never
	// inferred from a thread scan / timestamp. No binding → no reaction approval.
	const stored = deps.readBindingImpl(
		gate.executionId,
		gate.questionId,
		session.pr_head_sha,
	);
	if (!stored?.gateMessageId) return null;

	const binding: GateBinding = {
		questionId: gate.questionId,
		executionId: gate.executionId,
		issueId: args.ctx.issueId,
		issueIdentifier: session.issue_identifier ?? undefined,
		prHeadSha: session.pr_head_sha,
		prNumber: session.pr_number ?? undefined,
		threadId: stored.threadId,
		canonicalFounderId: deps.canonicalFounderId,
		targetMessageId: stored.gateMessageId,
	};

	const evaluateReaction = deps.evaluateReactionImpl ?? evaluateReactionSource;
	const signal = await evaluateReaction(binding, {
		fetcherImpl: deps.reactionFetcherImpl,
	});
	if (!signal) return null; // no ✅ yet → keep waiting, re-check next tick

	const write = deps.writeGateResponseImpl ?? writeGateResponseAndRunPostWrite;
	const res = await write({
		db: deps.db,
		store: { getSession: (e) => deps.store.getSession(e) },
		questionId: gate.questionId,
		executionId: gate.executionId,
		actor: deps.canonicalFounderId,
		answer: '{"approved": true}',
		expectedCurrentReviewQuestionId: session.review_question_id ?? undefined,
		onResponseWritten: deps.onResponseWritten,
	});

	if (!res.written && !res.retrySafe) return { handled: [], retrySafe: false };
	return { handled: [gate.questionId], retrySafe: res.retrySafe };
}
