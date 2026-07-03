/**
 * FLY-799 Part A-3 — FounderShipApprovalClassifier (Tier-3).
 *
 * Reached ONLY for genuinely ambiguous founder free text (Tier-2 exact allowlist
 * missed, and it was not a ✅ reaction). Builds a strict prompt, runs the
 * on-demand headless Haiku classifier (subscription, not paid API), and maps the
 * verdict to a `ClassifierVerdict`.
 *
 * Security binding (Codex R1 #1): an "approve" is honored ONLY when the model
 * echoes `evidence_message_id === expectedMessageId` — the model must ground its
 * decision on the exact founder message being processed, not on some other
 * thread message. Any runner failure, malformed verdict, unknown decision, or
 * evidence mismatch → `unclear` (fail-closed → WAKE-only, no approval).
 */

import {
	type RunnerResult,
	runSubscriptionClassifier,
	type SubscriptionClassifierOpts,
} from "./subscription-claude-classifier-runner.js";

export interface FounderShipApprovalInput {
	/** Discord message id of the founder message being classified. */
	expectedMessageId: string;
	messageContent: string;
	questionId: string;
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	prHeadSha: string;
}

export type ClassifierVerdict =
	| { kind: "approve"; evidenceMessageId: string }
	| { kind: "reject"; reason: string }
	| { kind: "unclear" };

export type ClassifierRunnerImpl = (
	prompt: string,
	opts?: SubscriptionClassifierOpts,
) => Promise<RunnerResult>;

export interface ClassifierDeps {
	runnerImpl?: ClassifierRunnerImpl;
	model?: string;
	claudeBin?: string;
}

function buildPrompt(input: FounderShipApprovalInput): string {
	const issue = input.issueIdentifier ?? input.issueId;
	const shortHead = input.prHeadSha.slice(0, 12);
	return [
		"You are a STRICT ship-approval classifier for a software release gate.",
		`The founder sent this Discord message (id ${input.expectedMessageId}) replying to a ship-approval request for issue ${issue} (PR head ${shortHead}):`,
		"<<<FOUNDER_MESSAGE",
		input.messageContent,
		"FOUNDER_MESSAGE",
		"",
		`Decide whether this message CLEARLY and UNCONDITIONALLY approves shipping ${issue} RIGHT NOW.`,
		"Rules (fail-closed — when in doubt, answer unclear):",
		'- "approve" ONLY for an unambiguous present-tense approval of THIS issue.',
		'- "reject" for an explicit "do not ship" / "changes needed".',
		'- "unclear" for anything hedged, conditional, negated, about a different issue, a status question, an acknowledgement, or ambiguous.',
		"",
		'Output ONLY a JSON object, no other text: {"decision":"approve"|"reject"|"unclear","evidence_message_id":"<id>"}.',
		`The evidence_message_id MUST be exactly "${input.expectedMessageId}".`,
	].join("\n");
}

export async function classifyFounderShipApproval(
	input: FounderShipApprovalInput,
	deps: ClassifierDeps = {},
): Promise<ClassifierVerdict> {
	const runner = deps.runnerImpl ?? runSubscriptionClassifier;
	let res: RunnerResult;
	try {
		res = await runner(buildPrompt(input), {
			model: deps.model,
			claudeBin: deps.claudeBin,
		});
	} catch {
		return { kind: "unclear" }; // runner should never throw, belt-and-suspenders
	}
	if (!res.ok) return { kind: "unclear" };

	const v = res.verdict;
	if (typeof v !== "object" || v === null) return { kind: "unclear" };
	const decision = (v as { decision?: unknown }).decision;
	const evidence = (v as { evidence_message_id?: unknown }).evidence_message_id;

	if (decision === "approve") {
		// Binding: the model must have grounded on the EXACT founder message.
		if (typeof evidence !== "string" || evidence !== input.expectedMessageId) {
			return { kind: "unclear" };
		}
		return { kind: "approve", evidenceMessageId: evidence };
	}
	if (decision === "reject") {
		const reason = (v as { reason?: unknown }).reason;
		return {
			kind: "reject",
			reason: typeof reason === "string" ? reason : "founder rejected",
		};
	}
	// "unclear" or any unknown decision value → fail-closed.
	return { kind: "unclear" };
}
