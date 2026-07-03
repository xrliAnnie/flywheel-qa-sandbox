/**
 * FLY-799 Part A — TextSource.
 *
 * Normalizes a founder free-text Discord message into a bound `ApprovalSignal`.
 * Pipeline: identity (canonical founder) → Tier-2 exact allowlist (zero AI) →
 * Tier-3 on-demand Haiku classifier (only for genuinely ambiguous text). The
 * signal always binds to the founder's OWN message id; the deliverer then
 * decides (approve → write gate; reject → feedback; unclear → WAKE-only).
 * Non-founder authors produce no signal (null) and never reach the classifier.
 */

import {
	type ClassifierDeps,
	classifyFounderShipApproval,
	type FounderShipApprovalInput,
} from "./founder-ship-approval-classifier.js";
import { matchTier2Approval } from "./tier2-allowlist.js";
import type { ApprovalSignal, GateBinding } from "./types.js";

export interface TextSourceMessage {
	id: string;
	content: string;
	authorId: string;
}

export interface TextSourceArgs {
	gate: Omit<GateBinding, "targetMessageId">;
	message: TextSourceMessage;
}

export type ClassifyImpl = (
	input: FounderShipApprovalInput,
	deps?: ClassifierDeps,
) => ReturnType<typeof classifyFounderShipApproval>;

export interface TextSourceDeps {
	classifyImpl?: ClassifyImpl;
	classifierDeps?: ClassifierDeps;
}

export async function evaluateTextSource(
	args: TextSourceArgs,
	deps: TextSourceDeps = {},
): Promise<ApprovalSignal | null> {
	const { gate, message } = args;

	// Identity: only the canonical founder's own message can be an approval.
	if (message.authorId !== gate.canonicalFounderId) return null;

	const base = {
		source: "text" as const,
		questionId: gate.questionId,
		prHeadSha: gate.prHeadSha,
		messageId: message.id,
		authorUserId: message.authorId,
	};

	// Tier-2 exact allowlist — zero AI, never calls the classifier.
	if (
		matchTier2Approval(message.content, {
			issueIdentifier: gate.issueIdentifier,
			prNumber: gate.prNumber,
		}) === "approve"
	) {
		return { ...base, kind: "approve" };
	}

	// Tier-3 — ambiguous free text only.
	const classify = deps.classifyImpl ?? classifyFounderShipApproval;
	const verdict = await classify(
		{
			expectedMessageId: message.id,
			messageContent: message.content,
			questionId: gate.questionId,
			executionId: gate.executionId,
			issueId: gate.issueId,
			issueIdentifier: gate.issueIdentifier,
			prHeadSha: gate.prHeadSha,
		},
		deps.classifierDeps,
	);

	return { ...base, kind: verdict.kind };
}
