/**
 * Founder ship-card text source.
 *
 * Text can become a verdict only after Discord has proven that the founder
 * replied to the current immutable card. The anchored protocol is deliberately
 * finite and deterministic: approve / look good to me, or an explicit
 * kickback. Free thread speech never reaches a word list or an LLM.
 */

import {
	isExplicitFounderKickback,
	isFixedFounderCardApproval,
	makeFounderReworkHint,
	parseFounderReworkPrefix,
} from "../../workflow-rework-hint.js";
import type { ApprovalSignal, GateBinding } from "./types.js";

export interface TextSourceMessage {
	id: string;
	content: string;
	authorId: string;
}

export interface TextSourceArgs {
	gate: Omit<GateBinding, "targetMessageId">;
	message: TextSourceMessage;
	/** Verified Discord reply to THIS gate's bound ship card. */
	replyToCard?: boolean;
}

export async function evaluateTextSource(
	args: TextSourceArgs,
): Promise<ApprovalSignal | null> {
	const { gate, message } = args;
	if (message.authorId !== gate.canonicalFounderId) return null;

	const base = {
		source: "text" as const,
		questionId: gate.questionId,
		prHeadSha: gate.prHeadSha,
		messageId: message.id,
		authorUserId: message.authorId,
	};

	if (!args.replyToCard) {
		return {
			...base,
			kind: "unclear",
			evidence: {
				stage: "card_reply_neither",
				reason: "card_anchor_missing",
			},
		};
	}

	if (isFixedFounderCardApproval(message.content)) {
		return {
			...base,
			kind: "approve",
			evidence: { stage: "card_reply_approve" },
		};
	}

	if (isExplicitFounderKickback(message.content)) {
		const explicitPrefix = parseFounderReworkPrefix(message.content);
		return {
			...base,
			kind: "reject",
			evidence: { stage: "card_reply_reject" },
			...(explicitPrefix
				? {
						founderRework: makeFounderReworkHint(
							explicitPrefix.target,
							"founder-reply-prefix",
							`matched_prefix:${explicitPrefix.prefix}`,
						),
					}
				: {}),
		};
	}

	return {
		...base,
		kind: "unclear",
		evidence: { stage: "card_reply_neither" },
	};
}
