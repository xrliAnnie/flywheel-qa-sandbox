import { expect, it, vi } from "vitest";
import { sendDiscordAttachments } from "../discord-attachments.js";

const threadId = "111111111111111111",
	messageId = "222222222222222222";
function fixture() {
	const fetchImpl = vi.fn<typeof fetch>(async () =>
		Response.json({ id: messageId, channel_id: threadId }),
	);
	return {
		threadId,
		nonce: "1234567890123456789012345",
		text: "report",
		botToken: "PRIVATE_TOKEN",
		secrets: ["BROKER_SECRET"],
		files: [{ data: Buffer.from("hello"), mimeType: "text/plain" }],
		signal: new AbortController().signal,
		assertCurrent: vi.fn(),
		fetchImpl,
	};
}
it("sends bounded multipart bytes with deterministic filenames, nonce and mentions disabled", async () => {
	const f = fixture();
	expect(await sendDiscordAttachments(f)).toEqual({ messageId });
	expect(f.fetchImpl).toHaveBeenCalledOnce();
	const [url, init] = f.fetchImpl.mock.calls[0]!;
	expect(url).toBe(`https://discord.com/api/v10/channels/${threadId}/messages`);
	expect(init!.redirect).toBe("error");
	expect(new Headers(init!.headers).get("authorization")).toBe(
		"Bot PRIVATE_TOKEN",
	);
	const form = init!.body as FormData;
	const payload = JSON.parse(form.get("payload_json") as string);
	expect(payload).toMatchObject({
		nonce: f.nonce,
		enforce_nonce: true,
		allowed_mentions: { parse: [] },
		attachments: [{ id: 0, filename: "attachment-1.txt" }],
	});
	expect(payload.content).toBe(f.text);
	const file = form.get("files[0]") as File;
	expect(file.type).toBe("text/plain");
	expect(await file.text()).toBe("hello");
});
it("rejects malformed, oversized, secret-bearing and empty uploads before sending", async () => {
	for (const patch of [
		{ threadId: "../other" },
		{ nonce: "bad nonce" },
		{ files: [] },
		{
			files: Array.from({ length: 11 }, () => ({
				data: Buffer.from("a"),
				mimeType: "text/plain",
			})),
		},
		{
			files: [
				{ data: Buffer.alloc(25 * 1024 * 1024 + 1), mimeType: "text/plain" },
			],
		},
		{ files: [{ data: Buffer.alloc(0), mimeType: "text/plain" }] },
		{ files: [{ data: Buffer.from("PRIVATE_TOKEN"), mimeType: "text/plain" }] },
		{ files: [{ data: Buffer.from("ok"), mimeType: "evil/header" }] },
		{ text: "BROKER_SECRET" },
		{ text: "x".repeat(2001) },
	]) {
		const f = fixture();
		await expect(sendDiscordAttachments({ ...f, ...patch })).rejects.toThrow(
			"discord_attachment_send_unknown",
		);
		expect(f.fetchImpl).not.toHaveBeenCalled();
	}
});
it("does not send after scope revocation", async () => {
	const f = fixture();
	f.assertCurrent.mockImplementation(() => {
		throw new Error("stale");
	});
	await expect(sendDiscordAttachments(f)).rejects.toThrow(
		"discord_attachment_send_unknown",
	);
	expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("does not retry ambiguous failures or expose provider bodies", async () => {
	for (const response of [
		new Response("PRIVATE_TOKEN", { status: 429 }),
		new Response(null, {
			status: 302,
			headers: { location: "https://foreign.invalid" },
		}),
		Response.json({ id: messageId, channel_id: "333333333333333333" }),
		Response.json({ id: "PRIVATE_TOKEN", channel_id: threadId }),
		new Response("x".repeat(262145), {
			headers: { "content-type": "application/json" },
		}),
	]) {
		const f = fixture();
		f.fetchImpl.mockResolvedValue(response);
		await expect(sendDiscordAttachments(f)).rejects.toThrow(
			/^discord_attachment_send_unknown$/,
		);
		expect(f.fetchImpl).toHaveBeenCalledOnce();
	}
});
it("aborts even when provider ignores cancellation", async () => {
	const f = fixture(),
		controller = new AbortController();
	f.fetchImpl.mockImplementation(() => new Promise(() => {}));
	const pending = sendDiscordAttachments({ ...f, signal: controller.signal });
	await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
	controller.abort();
	await expect(pending).rejects.toThrow("discord_attachment_send_unknown");
});
it("rejects stale success and leaves reconciliation to the durable caller", async () => {
	const f = fixture();
	f.fetchImpl.mockImplementation(async () => {
		f.assertCurrent.mockImplementation(() => {
			throw new Error("stale");
		});
		return Response.json({ id: messageId, channel_id: threadId });
	});
	await expect(sendDiscordAttachments(f)).rejects.toThrow(
		"discord_attachment_send_unknown",
	);
	expect(f.fetchImpl).toHaveBeenCalledOnce();
});
