import type { CoSPorts, LeadRef, LeadTransportUnavailable } from "./ports.js";

export type LeadQuestionStatus =
	| "posting"
	| "posted"
	| "answer_observed"
	| "delivered"
	| "expired"
	| "failed";

export type LeadQuestion = {
	ask: {
		askId: string;
		revision: number;
		to: LeadRef;
		body: string;
		expiresAt: number;
	};
	status: LeadQuestionStatus;
	createdAt: number;
	updatedAt: number;
	deliveryId?: string;
	transport?: LeadTransportUnavailable;
	answerMessageId?: string;
	answerBody?: string;
	answerFrom?: LeadRef;
};

export async function beginLeadQuestion(
	question: LeadQuestion,
	ports: CoSPorts,
): Promise<LeadQuestion> {
	const receipt = await ports.request({
		key: {
			requestId: question.ask.askId,
			revision: question.ask.revision,
		},
		to: question.ask.to,
		kind: "question",
		correlation: question.ask.askId,
		body: question.ask.body,
		expiresAt: question.ask.expiresAt,
	});
	if (receipt.status === "unavailable") {
		return { ...question, transport: receipt };
	}
	return {
		...question,
		status: "posted",
		deliveryId: receipt.deliveryId,
		transport: undefined,
	};
}

export function observeLeadAnswer(
	question: LeadQuestion,
	answer: {
		from: LeadRef;
		messageId: string;
		body: string;
		observedAt: number;
	},
): LeadQuestion {
	if (
		answer.from.project !== question.ask.to.project ||
		answer.from.leadId !== question.ask.to.leadId
	) {
		throw new Error("answer did not come from the canonical recipient Lead");
	}
	if (question.status !== "posted") {
		throw new Error("answer can only settle a posted Lead question");
	}
	if (!answer.messageId || !answer.body.trim()) {
		throw new Error("answer receipt is incomplete");
	}
	if (
		!Number.isSafeInteger(answer.observedAt) ||
		answer.observedAt < question.updatedAt
	) {
		throw new Error("answer observation time is invalid");
	}
	if (answer.observedAt > question.ask.expiresAt) {
		return { ...question, status: "expired", updatedAt: answer.observedAt };
	}
	return {
		...question,
		status: "answer_observed",
		updatedAt: answer.observedAt,
		answerMessageId: answer.messageId,
		answerBody: answer.body,
		answerFrom: answer.from,
	};
}
