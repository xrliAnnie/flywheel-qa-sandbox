import { expect, it, vi } from "vitest";
import { writeJudgmentMessage } from "../discord-transport.js";

const signal = new AbortController().signal;
const input = {
	threadId: "123456789012345679",
	cardMessageId: "123456789012345678",
	botUserId: "123456789012345690",
	botToken: "test-token",
	content: "机器试判",
	signal,
};
it("posts one bounded automated message and retains the authenticated server receipt", async () => {
	const fetchImpl = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					id: "123456789012345682",
					channel_id: input.threadId,
					author: { id: input.botUserId, bot: true },
					content: "🤖[自动] 机器试判",
					timestamp: "2026-09-11T00:00:00+00:00",
					edited_timestamp: null,
				}),
			),
	);
	expect(await writeJudgmentMessage({ ...input, fetchImpl })).toEqual({
		kind: "posted",
		messageId: "123456789012345682",
		visibleAt: "2026-09-11T00:00:00.000Z",
	});
	const options = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
	expect(JSON.parse(String(options[1].body))).toMatchObject({
		allowed_mentions: { parse: [] },
		message_reference: { message_id: input.cardMessageId },
		content: "🤖[自动] 机器试判",
	});
	expect(options[1].redirect).toBe("error");
});
it("honors 429 retry time and never invents a receipt on a malformed success", async () => {
	const fetchImpl = vi.fn(
		async () =>
			new Response(JSON.stringify({ retry_after: 120 }), { status: 429 }),
	);
	expect(
		await writeJudgmentMessage({ ...input, fetchImpl, now: () => 1000 }),
	).toEqual({ kind: "failed", retryAt: 121000 });
	fetchImpl.mockImplementationOnce(
		async () => new Response(JSON.stringify({ id: "123456789012345682" })),
	);
	expect(await writeJudgmentMessage({ ...input, fetchImpl })).toEqual({
		kind: "uncertain",
	});
});

it("requires the owned message and an edit timestamp for PATCH receipts", async () => {
	const messageId = "123456789012345682";
	const receipt = {
		id: messageId,
		channel_id: input.threadId,
		author: { id: input.botUserId, bot: true },
		content: "🤖[自动] 机器试判",
		timestamp: "2026-09-11T00:00:00Z",
		edited_timestamp: null as string | null,
	};
	const fetchImpl = vi.fn(async () => new Response(JSON.stringify(receipt)));
	expect(
		await writeJudgmentMessage({ ...input, messageId, fetchImpl }),
	).toEqual({ kind: "uncertain" });
	receipt.edited_timestamp = "2026-09-11T00:00:02+00:00";
	expect(
		await writeJudgmentMessage({ ...input, messageId, fetchImpl }),
	).toEqual({
		kind: "posted",
		messageId,
		visibleAt: "2026-09-11T00:00:02.000Z",
	});
	receipt.author.id = "123456789012345691";
	expect(
		await writeJudgmentMessage({ ...input, messageId, fetchImpl }),
	).toEqual({ kind: "uncertain" });
});
