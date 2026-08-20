import { describe, expect, it } from "vitest";
import { evaluateTextSource } from "../approval-signal/text-approval-source.js";
import type { GateBinding } from "../approval-signal/types.js";

const GATE: Omit<GateBinding, "targetMessageId"> = {
	questionId: "Q-1",
	executionId: "EXEC-1",
	issueId: "issue-uuid",
	issueIdentifier: "FLY-1847",
	prHeadSha: "a".repeat(40),
	prNumber: 888,
	threadId: "T-1",
	canonicalFounderId: "FOUNDER-1",
};

const msg = (content: string, authorId = "FOUNDER-1") => ({
	id: "MSG-1",
	content,
	authorId,
});

describe("evaluateTextSource — card-anchored founder protocol", () => {
	it("ignores non-founder messages", async () => {
		await expect(
			evaluateTextSource({
				gate: GATE,
				message: msg("approve", "SOMEONE-ELSE"),
				replyToCard: true,
			}),
		).resolves.toBeNull();
	});

	it.each([
		"approve",
		"APPROVE",
		"approve。",
		"look good to me",
		"Look good to me!",
	])("accepts fixed card approval %j", async (content) => {
		const signal = await evaluateTextSource({
			gate: GATE,
			message: msg(content),
			replyToCard: true,
		});
		expect(signal).toMatchObject({
			kind: "approve",
			source: "text",
			messageId: "MSG-1",
			evidence: { stage: "card_reply_approve" },
		});
	});

	it.each([
		["打回。", undefined],
		["design: revise the flow.", "design"],
		["implement：fix the handler！", "implement"],
		["qa: rerun this case。", "qa"],
	] as const)(
		"accepts explicit card kickback %j with route %j",
		async (content, target) => {
			const signal = await evaluateTextSource({
				gate: GATE,
				message: msg(content),
				replyToCard: true,
			});
			expect(signal).toMatchObject({
				kind: "reject",
				evidence: { stage: "card_reply_reject" },
			});
			if (target) {
				expect(signal).toMatchObject({ founderRework: { target } });
			}
		},
	);

	it.each([
		"ship",
		"都可以了",
		"ok what's next",
		"approve?",
		"打回？",
		"还有什么要我决定的？",
		"[founder-review-summary:v1] issue=FLY-1847",
	])("keeps other card reply %j neutral", async (content) => {
		const signal = await evaluateTextSource({
			gate: GATE,
			message: msg(content),
			replyToCard: true,
		});
		expect(signal).toMatchObject({
			kind: "unclear",
			evidence: { stage: "card_reply_neither" },
		});
	});

	it.each([
		"approve",
		"ship",
		"都可以了",
		"打回。",
		"design: change this",
		"还有什么要我决定的？",
	])(
		"never turns ordinary thread speech %j into a verdict",
		async (content) => {
			const signal = await evaluateTextSource({
				gate: GATE,
				message: msg(content),
			});
			expect(signal).toMatchObject({
				kind: "unclear",
				evidence: {
					stage: "card_reply_neither",
					reason: "card_anchor_missing",
				},
			});
		},
	);
});
