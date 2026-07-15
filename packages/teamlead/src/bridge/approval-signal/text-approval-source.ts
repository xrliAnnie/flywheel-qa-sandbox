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
import {
	hasExplicitMismatchedReference,
	matchTier2Approval,
} from "./tier2-allowlist.js";
import type { ApprovalSignal, GateBinding } from "./types.js";

export interface TextSourceMessage {
	id: string;
	content: string;
	authorId: string;
}

export interface TextSourceArgs {
	gate: Omit<GateBinding, "targetMessageId">;
	message: TextSourceMessage;
	/** FLY-1041 Chunk 7: verified Discord reply to THIS gate's ship card. */
	replyToCard?: boolean;
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

	const tier2Gate = {
		issueIdentifier: gate.issueIdentifier,
		prNumber: gate.prNumber,
	};

	// Tier-2 exact allowlist — zero AI, never calls the classifier.
	// FLY-1041 Fix C: affirmation-prefix normalization ("嗯ship" → "ship") is
	// default-ON with its own kill-switch (read per call — flip without a
	// Bridge restart). `FLYWHEEL_TIER2_PREFIX_NORM=0` → byte-compatible
	// pre-FLY-1041 matcher (「嗯ship」 downgrades to Tier-3).
	const prefixNorm = process.env.FLYWHEEL_TIER2_PREFIX_NORM !== "0";
	if (
		matchTier2Approval(message.content, tier2Gate, { prefixNorm }) === "approve"
	) {
		return { ...base, kind: "approve", evidence: { stage: "tier2_approve" } };
	}

	// FLY-799 (Codex R1 HIGH-3): an EXPLICIT wrong-target reference (`ship
	// FLY-756` / `#123` in this gate's thread) is a deterministic "not this one"
	// — fail-closed to WAKE-only, NEVER hand it to the Tier-3 LLM (which could
	// still approve it). Bare numbers are not references here (they still
	// downgrade to Tier-3), so an ordinary approval that happens to cite a number
	// is unaffected.
	if (hasExplicitMismatchedReference(message.content, tier2Gate)) {
		return {
			...base,
			kind: "unclear",
			evidence: {
				stage: "tier2_downgrade",
				reason: "explicit_mismatched_reference",
			},
		};
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
			replyToCard: args.replyToCard,
		},
		deps.classifierDeps,
	);

	// FLY-1041 Chunk 4: surface WHICH tier-3 outcome (and why) instead of
	// folding everything into a bare kind — a classifier spawn failure
	// (runnerFailed) is a different production problem than a model "unclear".
	const stage =
		verdict.kind === "approve"
			? ("tier3_approve" as const)
			: verdict.kind === "reject"
				? ("tier3_reject" as const)
				: verdict.runnerFailed
					? ("tier3_runner_failed" as const)
					: ("tier3_unclear" as const);
	const reason =
		verdict.kind === "reject"
			? verdict.reason
			: verdict.kind === "unclear"
				? verdict.reason
				: undefined;
	return {
		...base,
		kind: verdict.kind,
		evidence: { stage, ...(reason !== undefined ? { reason } : {}) },
	};
}
