import { z } from "zod";
import { overallSchema } from "./contract.js";
import { discordId } from "./discord-message.js";

const base = z.object({
	guildId: discordId,
	threadId: discordId,
	cardMessageId: discordId,
	subjectId: z.string().regex(/^[a-f0-9]{64}$/),
});
const schema = z.discriminatedUnion("purpose", [
	base.extend({
		purpose: z.literal("clarification"),
		opinionMessageId: discordId,
		decisionMessageId: discordId.optional(),
		overall: overallSchema,
		decision: z.enum(["approved", "rework", "canceled"]),
	}),
	base.extend({ purpose: z.literal("ack"), replyMessageId: discordId }),
]);
/** Static wording and validated snowflakes only; original reply text stays in the immutable ledger. */
export function renderLearningMessage(value: unknown): {
	content: string;
	replyTo: string;
} {
	const input = schema.parse(value);
	const link = (messageId: string) =>
		`https://discord.com/channels/${input.guildId}/${input.threadId}/${messageId}`;
	const marker = `ship-judgment:${input.purpose}:${input.subjectId} ${input.purpose}:${input.subjectId}`;
	if (input.purpose === "ack")
		return {
			replyTo: input.replyMessageId,
			content: `已记录，未改变批准。批准或打回请回复[原审批卡](${link(input.cardMessageId)})。\n\`${marker}\``,
		};
	const machine = {
		can: "可",
		cannot: "不可",
		recommend_reject: "建议拒",
		undetermined: "不可判定",
	}[input.overall];
	const decision = { approved: "批准", rework: "打回", canceled: "取消" }[
		input.decision
	];
	const question =
		input.decision === "canceled"
			? "这次取消是方向或优先级变化，还是原判断遗漏了什么？"
			: input.overall === "cannot"
				? "这是条件变化，还是机器判断遗漏了什么？"
				: "机器的判据与您的考虑哪里不同？";
	const replyTo = input.decisionMessageId ?? input.cardMessageId;
	return {
		replyTo,
		content: `[机器试判](${link(input.opinionMessageId)})为「${machine}」，[您的决定](${link(replyTo)})为「${decision}」。${question}回复此条仅记录解释。\n\`${marker}\``,
	};
}
