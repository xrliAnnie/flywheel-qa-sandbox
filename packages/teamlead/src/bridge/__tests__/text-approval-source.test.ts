/**
 * FLY-799 Part A — TextSource (RED first).
 *
 * Composes identity + Tier-2 exact allowlist + Tier-3 classifier into a bound
 * `ApprovalSignal`. Only the canonical founder's message produces a signal
 * (non-founder → null). Tier-2 exact approvals bypass the classifier (zero AI);
 * everything else falls to the injected classifier, whose verdict maps straight
 * through. The text signal always binds to the founder's OWN message id.
 */

import { describe, expect, it, vi } from "vitest";
import { evaluateTextSource } from "../approval-signal/text-approval-source.js";
import type { GateBinding } from "../approval-signal/types.js";

const GATE: Omit<GateBinding, "targetMessageId"> = {
	questionId: "Q-1",
	executionId: "EXEC-1",
	issueId: "issue-uuid",
	issueIdentifier: "FLY-799",
	prHeadSha: "a".repeat(40),
	prNumber: 799,
	threadId: "T-1",
	canonicalFounderId: "FOUNDER-1",
};

const msg = (content: string, authorId = "FOUNDER-1") => ({
	id: "MSG-1",
	content,
	authorId,
});

describe("evaluateTextSource — identity", () => {
	it("returns null for a non-founder author (never classifies)", async () => {
		const classifyImpl = vi.fn();
		const sig = await evaluateTextSource(
			{ gate: GATE, message: msg("ship", "SOMEONE-ELSE") },
			{ classifyImpl },
		);
		expect(sig).toBeNull();
		expect(classifyImpl).not.toHaveBeenCalled();
	});
});

describe("evaluateTextSource — Tier-2 fast path (zero AI)", () => {
	it("bare 'ship' → approve WITHOUT calling the classifier", async () => {
		const classifyImpl = vi.fn();
		const sig = await evaluateTextSource(
			{ gate: GATE, message: msg("ship") },
			{ classifyImpl },
		);
		expect(sig).toMatchObject({
			source: "text",
			kind: "approve",
			questionId: "Q-1",
			prHeadSha: GATE.prHeadSha,
			messageId: "MSG-1",
			authorUserId: "FOUNDER-1",
		});
		expect(classifyImpl).not.toHaveBeenCalled();
	});
});

describe("evaluateTextSource — Tier-3 fallback", () => {
	it("ambiguous text → classifier approve (evidence bound) → approve", async () => {
		const classifyImpl = vi
			.fn()
			.mockResolvedValue({ kind: "approve", evidenceMessageId: "MSG-1" });
		const sig = await evaluateTextSource(
			{ gate: GATE, message: msg("yeah alright then, fine by me") },
			{ classifyImpl },
		);
		expect(sig).toMatchObject({
			source: "text",
			kind: "approve",
			messageId: "MSG-1",
		});
		expect(classifyImpl).toHaveBeenCalledOnce();
	});

	it("ambiguous text → classifier reject → reject", async () => {
		const classifyImpl = vi
			.fn()
			.mockResolvedValue({ kind: "reject", reason: "x" });
		const sig = await evaluateTextSource(
			{ gate: GATE, message: msg("hmm not like this") },
			{ classifyImpl },
		);
		expect(sig).toMatchObject({ source: "text", kind: "reject" });
	});

	it("ambiguous text → classifier unclear → unclear", async () => {
		const classifyImpl = vi.fn().mockResolvedValue({ kind: "unclear" });
		const sig = await evaluateTextSource(
			{ gate: GATE, message: msg("how's it going") },
			{ classifyImpl },
		);
		expect(sig).toMatchObject({ source: "text", kind: "unclear" });
	});

	it("passes the founder's own message id as expectedMessageId to the classifier", async () => {
		const classifyImpl = vi.fn().mockResolvedValue({ kind: "unclear" });
		await evaluateTextSource(
			{ gate: GATE, message: msg("maybe") },
			{ classifyImpl },
		);
		const [input] = classifyImpl.mock.calls[0] as [
			{ expectedMessageId: string },
		];
		expect(input.expectedMessageId).toBe("MSG-1");
	});
});

describe("evaluateTextSource — explicit wrong-target fail-closed (Codex R1 HIGH-3)", () => {
	it("'ship FLY-756' in the FLY-799 gate → unclear, NEVER calls the classifier", async () => {
		const classifyImpl = vi.fn();
		const sig = await evaluateTextSource(
			{ gate: GATE, message: msg("ship FLY-756") },
			{ classifyImpl },
		);
		expect(sig?.kind).toBe("unclear");
		expect(classifyImpl).not.toHaveBeenCalled();
	});

	it("wrong PR '#123' → unclear, no classify", async () => {
		const classifyImpl = vi.fn();
		const sig = await evaluateTextSource(
			{ gate: GATE, message: msg("approve #123") },
			{ classifyImpl },
		);
		expect(sig?.kind).toBe("unclear");
		expect(classifyImpl).not.toHaveBeenCalled();
	});

	it("ambiguous text with an incidental bare number still reaches Tier-3", async () => {
		const classifyImpl = vi
			.fn()
			.mockResolvedValue({ kind: "approve", evidence_message_id: "MSG-1" });
		await evaluateTextSource(
			{ gate: GATE, message: msg("yeah lets do it, fixes 500 errors") },
			{ classifyImpl },
		);
		expect(classifyImpl).toHaveBeenCalledOnce();
	});
});
