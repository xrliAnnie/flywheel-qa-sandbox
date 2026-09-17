import { expect, it } from "vitest";
import { verifyFounderMessage } from "../founder-message.js";

const now = Date.parse("2026-09-14T20:00:00Z");
const snowflake = (time: number) =>
	((BigInt(time) - 1420070400000n) << 22n).toString();
const context = {
	founderId: "100000000000000001",
	canonicalFounderId: "100000000000000001",
	founderConfigVersion: 1,
	guildId: "100000000000000002",
	channelId: "100000000000000003",
	trustedChannelGuildId: "100000000000000002",
	cardId: snowflake(now - 1000),
	challenge: "ABCDEFGH",
	cardCreatedAt: now - 1000,
	preparedAt: now - 2000,
	proposalExpiresAt: now + 86400_000 - 2000,
	observedAt: now + 2000,
};
function message() {
	return {
		id: snowflake(now),
		channel_id: context.channelId,
		guild_id: context.guildId,
		author: { id: context.founderId, bot: false },
		type: 19,
		message_reference: {
			type: 0,
			message_id: context.cardId,
			channel_id: context.channelId,
			guild_id: context.guildId,
		},
		timestamp: new Date(now).toISOString(),
		edited_timestamp: null,
		content: "批准小红书 ABCDEFGH",
	};
}
it.each(["批准", "拒绝", "撤回"])(
	"accepts only the founder's explicit %s reply",
	(command) => {
		const result = verifyFounderMessage(
			{ ...message(), content: `${command}小红书 ABCDEFGH` },
			context,
		);
		expect(result.kind).toBe(
			{ 批准: "approved", 拒绝: "rejected", 撤回: "revoked" }[command],
		);
		expect(result.messageCreatedAt).toBe(now);
		expect(result.expiresAt).toBe(now + 15 * 60_000);
	},
);
it("normalizes only the mobile command and accepts a trusted channel-to-guild lookup", () => {
	const raw = {
		...message(),
		guild_id: undefined,
		content: "　批准小红书 ＡＢＣＤＥＦＧＨ！　",
	};
	expect(verifyFounderMessage(raw, context).kind).toBe("approved");
});
it.each([
	{ author: { id: "100000000000000099", bot: false } },
	{ author: { id: context.founderId, bot: true } },
	{ webhook_id: "100000000000000009" },
	{ type: 0 },
	{ edited_timestamp: new Date(now).toISOString() },
	{ message_reference: { ...message().message_reference, type: 1 } },
	{ message_snapshots: [{}] },
	{
		message_reference: {
			...message().message_reference,
			message_id: "100000000000000099",
		},
	},
	{ channel_id: "100000000000000099" },
	{ guild_id: "100000000000000099" },
	{ id: "123" },
	{ timestamp: new Date(now + 1).toISOString() },
	{ content: "好" },
	{ content: "批准小红书 ABCDEFGH!!" },
	{ content: "批准小红书  ABCDEFGH" },
	{ content: "批准小红书 HGFEDCBA" },
	{ content: "ship approved" },
])("rejects non-authoritative input %#", (change) => {
	expect(() =>
		verifyFounderMessage({ ...message(), ...change }, context),
	).toThrow();
});
it("rejects policy disagreement, stale messages, future timestamps and late observations", () => {
	expect(() =>
		verifyFounderMessage(message(), {
			...context,
			canonicalFounderId: "100000000000000099",
		}),
	).toThrow("founder_policy_invalid");
	expect(() =>
		verifyFounderMessage(message(), { ...context, cardCreatedAt: now + 1 }),
	).toThrow();
	expect(() =>
		verifyFounderMessage(message(), { ...context, observedAt: now - 31000 }),
	).toThrow();
	expect(() =>
		verifyFounderMessage(message(), {
			...context,
			observedAt: now + 15 * 60_000,
		}),
	).toThrow("founder_receipt_expired");
});
it("distinguishes unavailable Message Content from an incorrect command", () => {
	expect(() =>
		verifyFounderMessage({ ...message(), content: "" }, context),
	).toThrow("founder_content_unavailable");
});
