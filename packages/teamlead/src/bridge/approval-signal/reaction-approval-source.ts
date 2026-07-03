/**
 * FLY-799 Part A — ReactionSource.
 *
 * The zero-AI primary path: a founder ✅ on the ship-gate notification message is
 * a deterministic approval. Thin wrapper over the reusable
 * `checkReactionConfirmation` (pagination + fail-closed on 403/404/429/malformed
 * — Codex R3 "reuse"). Bound to the durable `targetMessageId` (A-0b): without a
 * binding there is NO approval — the target is never inferred from thread scan /
 * text / timestamp. Only the canonical founder's ✅ (exact id) counts; anything
 * else, or any REST failure, yields no signal (null → keep waiting, re-poll next
 * pass). ✅ only — 🆒 is not used (Annie).
 */

import {
	checkReactionConfirmation,
	FOUNDER_CONFIRM_EMOJI,
	type ReactionFetcher,
} from "../../lead-backends/codex/gateway/founder-confirmation.js";
import type { ApprovalSignal, GateBinding } from "./types.js";

export interface ReactionSourceDeps {
	fetcherImpl: ReactionFetcher;
}

export async function evaluateReactionSource(
	gate: GateBinding,
	deps: ReactionSourceDeps,
): Promise<ApprovalSignal | null> {
	// A-0b: no durable gate-message binding → refuse to approve (never inferred).
	if (!gate.targetMessageId) return null;

	const check = await checkReactionConfirmation(deps.fetcherImpl, {
		channelId: gate.threadId,
		messageId: gate.targetMessageId,
		founderId: gate.canonicalFounderId,
		emoji: FOUNDER_CONFIRM_EMOJI, // ✅
	});

	if (!check.confirmed) return null;

	return {
		source: "reaction",
		kind: "approve",
		questionId: gate.questionId,
		prHeadSha: gate.prHeadSha,
		targetMessageId: gate.targetMessageId,
		emoji: "✅",
		reactorUserId: gate.canonicalFounderId,
	};
}
