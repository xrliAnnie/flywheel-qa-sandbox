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
import type { MergedGateGuard } from "../merged-gate-guard.js";
import type { GateMessageBinding } from "./gate-message-binding.js";
import { evaluateReactionSource } from "./reaction-approval-source.js";
import type { GateBinding } from "./types.js";
import {
	type GateResponseDb,
	type WriteGateResponseArgs,
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
	cardAuthority?: WriteGateResponseArgs["cardAuthority"];
	onResponseWritten?: Parameters<
		typeof writeGateResponseAndRunPostWrite
	>[0]["onResponseWritten"];
	/**
	 * FLY-1041 Chunk 5: shared founder-approval hold guard. Checked AFTER a
	 * founder ✅ is detected and BEFORE the write (Codex R2 note 2 — guarding
	 * at the poller call-site would spam held_declined every tick with no ✅).
	 * Absent → no hold check (byte-compat).
	 */
	isHeld?: (executionId: string) => boolean;
	/** FLY-1041 Chunk 4/5: attribution audit sink (see the text handler). */
	auditSink?: (stage: string, payload?: Record<string, unknown>) => void;
	/** FLY-1238: shared last-mile PR-state guard. */
	mergedGateGuard?: MergedGateGuard;
}

export interface ReactionApprovalHandlerArgs {
	gate: {
		questionId: string;
		executionId: string;
		checkpoint: string | null;
		createdAtMs: number;
	};
	ctx: {
		issueId: string;
		threadId: string;
		projectName?: string;
		projectRoot?: string;
	};
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

	// FLY-1041 Chunk 5: a founder ✅ on a HELD session (codex not green / QA
	// running / merge_block) must not be written — same contract as the text
	// and voice sources ("all founder surfaces hold"). Audited once per gate
	// message (the factory's event id dedupes re-polls).
	if (deps.isHeld?.(gate.executionId)) {
		deps.auditSink?.("held_declined", {
			questionId: gate.questionId,
			executionId: gate.executionId,
			source: "reaction",
		});
		return null;
	}

	if (deps.mergedGateGuard) {
		const guarded = await deps.mergedGateGuard({
			executionId: gate.executionId,
			issueId: args.ctx.issueId,
			questionId: gate.questionId,
			projectName: args.ctx.projectName ?? "",
			projectRoot: args.ctx.projectRoot,
			prNumber: session.pr_number ?? undefined,
			source: "reaction",
		});
		if (guarded.kind !== "continue") {
			deps.auditSink?.(`merged_gate_guard_${guarded.kind}`, {
				questionId: gate.questionId,
				...("reason" in guarded ? { reason: guarded.reason } : {}),
			});
			return {
				handled: [],
				retrySafe: guarded.kind !== "retry_later",
			};
		}
	}

	const write = deps.writeGateResponseImpl ?? writeGateResponseAndRunPostWrite;
	const res = await write({
		db: deps.db,
		store: { getSession: (e) => deps.store.getSession(e) },
		questionId: gate.questionId,
		executionId: gate.executionId,
		source: "reaction",
		targetMessageId: binding.targetMessageId,
		cardAuthority: deps.cardAuthority,
		actor: deps.canonicalFounderId,
		founderId: deps.canonicalFounderId,
		answer: '{"approved": true}',
		expectedCurrentReviewQuestionId: session.review_question_id ?? undefined,
		holdReasonFor: deps.isHeld
			? (executionId) => (deps.isHeld!(executionId) ? "qa_not_green" : null)
			: undefined,
		onResponseWritten: deps.onResponseWritten,
	});

	if (!res.written && !res.retrySafe) return { handled: [], retrySafe: false };
	return { handled: [gate.questionId], retrySafe: res.retrySafe };
}
