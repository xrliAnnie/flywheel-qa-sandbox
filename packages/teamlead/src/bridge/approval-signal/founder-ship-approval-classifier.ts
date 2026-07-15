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
	/**
	 * FLY-1041 Chunk 7: the message is a VERIFIED Discord reply to this exact
	 * gate's ship card — the prompt may treat short affirmations as approval of
	 * THIS gate (reject/unclear rules are NOT relaxed).
	 */
	replyToCard?: boolean;
}

export type ClassifierVerdict =
	| { kind: "approve"; evidenceMessageId: string }
	| { kind: "reject"; reason: string }
	/**
	 * FLY-1041 Chunk 4: "unclear" now distinguishes WHY. `runnerFailed` marks
	 * an infrastructure failure (spawn/timeout/login/rate-limit — the runner
	 * never produced a model verdict); a model "unclear" leaves it unset. The
	 * caller still fail-closes identically on every unclear — this is pure
	 * observability (the FLY-910 「嗯ship」 forensics were impossible because
	 * both cases collapsed to a bare "unclear").
	 */
	| { kind: "unclear"; runnerFailed?: boolean; reason?: string };

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
		...(input.replyToCard
			? [
					"This message is a DIRECT Discord reply to the ship-approval card for this exact gate — treat short affirmations (ok / okk / 嗯 / 好) as approval of THIS gate unless hedged or negative.",
					"",
				]
			: []),
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
	} catch (err) {
		// runner should never throw, belt-and-suspenders
		return {
			kind: "unclear",
			runnerFailed: true,
			reason: (err as Error).message,
		};
	}
	if (!res.ok) {
		return { kind: "unclear", runnerFailed: true, reason: res.reason };
	}

	const v = res.verdict;
	if (typeof v !== "object" || v === null) {
		return { kind: "unclear", reason: "malformed_verdict" };
	}
	const decision = (v as { decision?: unknown }).decision;
	const evidence = (v as { evidence_message_id?: unknown }).evidence_message_id;

	if (decision === "approve") {
		// Binding: the model must have grounded on the EXACT founder message.
		if (typeof evidence !== "string" || evidence !== input.expectedMessageId) {
			return { kind: "unclear", reason: "evidence_message_id_mismatch" };
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
