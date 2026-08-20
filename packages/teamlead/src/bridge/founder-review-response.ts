import type { CommDB } from "flywheel-comm/db";
import { parseFounderReviewQuestionContent } from "flywheel-comm/founder-review";
import {
	defaultGateMarkerDir,
	markGateMarkerAnsweredForExecution,
} from "flywheel-comm/gate-marker";
import {
	checkReactionConfirmation,
	FOUNDER_CONFIRM_EMOJI,
	type ReactionFetcher,
} from "../lead-backends/codex/gateway/founder-confirmation.js";
import type { StateStore } from "../StateStore.js";
import {
	isExplicitFounderKickback,
	isFixedFounderCardApproval,
} from "../workflow-rework-hint.js";

export type FounderReviewResponseWriteResult =
	| { written: true }
	| {
			written: false;
			reason:
				| "question_missing"
				| "card_binding_missing"
				| "binding_invalid"
				| "stale_round"
				| "gate_not_open";
	  };

export type FounderReviewReplyDecision =
	| { kind: "pass" }
	| { kind: "kickback"; feedback?: string }
	| { kind: "neither" };

export function classifyFounderReviewReply(
	text: string,
): FounderReviewReplyDecision {
	if (isFixedFounderCardApproval(text)) return { kind: "pass" };
	if (isExplicitFounderKickback(text)) {
		return /^\s*打回[。.!！?？]*\s*$/u.test(text)
			? { kind: "kickback" }
			: { kind: "kickback", feedback: text };
	}
	return { kind: "neither" };
}

/** One founder-only write seam shared by text replies and reaction approval. */
export function writeTrustedFounderReviewResponse(input: {
	store: StateStore;
	db: CommDB;
	questionId: string;
	executionId: string;
	fromAgent: string;
	founderId: string | undefined;
	passed: boolean;
	feedback?: string;
}): FounderReviewResponseWriteResult {
	const question = input.db.getMessageById(input.questionId);
	if (
		!question ||
		question.from_agent !== input.executionId ||
		question.checkpoint !== "founder_review"
	) {
		return { written: false, reason: "question_missing" };
	}
	const content = parseFounderReviewQuestionContent(question.content);
	const execution = input.store.getWorkflowExecutionBinding(input.executionId);
	const binding = input.store.getFounderReviewCardBindingByQuestion(
		input.questionId,
	);
	if (!binding) {
		return { written: false, reason: "card_binding_missing" };
	}
	if (
		!content ||
		!execution ||
		execution.run_id !== binding.run_id ||
		content.runId !== binding.run_id ||
		content.artifactDigest !== binding.artifact_digest
	) {
		return { written: false, reason: "binding_invalid" };
	}

	let newestOrder = -1;
	let newestQuestionId: string | undefined;
	for (const candidate of input.db.getQuestionsByCheckpoint("founder_review")) {
		const candidateExecution = input.store.getWorkflowExecutionBinding(
			candidate.from_agent,
		);
		if (candidateExecution?.run_id !== binding.run_id) continue;
		const family = input.db.getFounderReviewFamily(candidate.id);
		if (!family || family.question.supersededAt !== null) continue;
		if (family.question.serverOrder > newestOrder) {
			newestOrder = family.question.serverOrder;
			newestQuestionId = candidate.id;
		}
	}
	if (newestQuestionId !== input.questionId) {
		return { written: false, reason: "stale_round" };
	}
	const written = input.db.insertFounderReviewResponseIfGateOpen({
		questionId: input.questionId,
		fromAgent: input.fromAgent,
		founderId: input.founderId,
		expectedOwner: input.executionId,
		passed: input.passed,
		...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
	});
	if (!written) return { written: false, reason: "gate_not_open" };
	try {
		markGateMarkerAnsweredForExecution(
			defaultGateMarkerDir(),
			input.questionId,
			input.executionId,
		);
	} catch (error) {
		console.warn(
			`[founder-review] response committed but gate marker did not converge: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { written: true };
}

/** Observe ✅ only on the immutable review card, then use the shared writer. */
export async function tryFounderReviewReactionResponse(input: {
	store: StateStore;
	db: CommDB;
	questionId: string;
	executionId: string;
	threadId: string;
	founderId: string;
	reactionFetcher: ReactionFetcher;
}): Promise<
	FounderReviewResponseWriteResult | { written: false; reason: "no_reaction" }
> {
	const binding = input.store.getFounderReviewCardBindingByQuestion(
		input.questionId,
	);
	if (!binding) return { written: false, reason: "card_binding_missing" };
	const confirmation = await checkReactionConfirmation(input.reactionFetcher, {
		channelId: input.threadId,
		messageId: binding.message_id,
		founderId: input.founderId,
		emoji: FOUNDER_CONFIRM_EMOJI,
	});
	if (!confirmation.confirmed) {
		return { written: false, reason: "no_reaction" };
	}
	return writeTrustedFounderReviewResponse({
		store: input.store,
		db: input.db,
		questionId: input.questionId,
		executionId: input.executionId,
		fromAgent: "bridge",
		founderId: input.founderId,
		passed: true,
	});
}
