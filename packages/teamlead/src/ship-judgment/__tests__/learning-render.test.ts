import { expect, it } from "vitest";
import { renderLearningMessage } from "../learning-render.js";

const base = {
	guildId: "123456789012345670",
	threadId: "123456789012345679",
	cardMessageId: "123456789012345678",
	subjectId: "a".repeat(64),
};
it("links original judgment and decision with a narrow clarification question", () => {
	const message = renderLearningMessage({
		...base,
		purpose: "clarification",
		opinionMessageId: "123456789012345680",
		decisionMessageId: "123456789012345681",
		overall: "cannot",
		decision: "approved",
	});
	expect(message.replyTo).toBe("123456789012345681");
	expect(message.content).toContain("条件变化");
	expect(message.content).toContain("判断遗漏");
	expect(message.content).toContain(
		"https://discord.com/channels/123456789012345670/123456789012345679/123456789012345680",
	);
	expect(message.content).toContain(
		"https://discord.com/channels/123456789012345670/123456789012345679/123456789012345681",
	);
	expect(message.content).toContain("clarification:" + base.subjectId);
	expect(message.content.length).toBeLessThan(2000);
});
it("acknowledges the exact reply without implying that the original card was approved", () => {
	const message = renderLearningMessage({
		...base,
		purpose: "ack",
		replyMessageId: "123456789012345682",
	});
	expect(message.replyTo).toBe("123456789012345682");
	expect(message.content).toContain("已记录，未改变批准");
	expect(message.content).toContain("批准或打回请回复");
	expect(message.content).toContain("/123456789012345678");
	expect(message.content).not.toContain("@everyone");
});
it("rejects malformed link/marker identifiers", () => {
	expect(() =>
		renderLearningMessage({
			...base,
			purpose: "ack",
			replyMessageId: "123456789012345682",
			guildId: "@everyone",
		}),
	).toThrow();
});
