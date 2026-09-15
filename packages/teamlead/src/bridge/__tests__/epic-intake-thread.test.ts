import { expect, it, vi } from "vitest";
import { readEpicIntakeThreadMessage } from "../chat-thread-utils.js";

const thread = "123456789012345678";
const message = "223456789012345678";
it("reads only the exact receipt from Discord using bounded existing REST helper", async () => {
	const fetchImpl = vi.fn(
		async () =>
			new Response(
				JSON.stringify([
					{ id: "neighbor", channel_id: thread, author: { id: "other" } },
					{ id: message, channel_id: thread, author: { id: "lead" } },
				]),
			),
	) as unknown as typeof fetch;
	expect(
		await readEpicIntakeThreadMessage(thread, message, "fixture-token", {
			fetchImpl,
		}),
	).toEqual({ id: message, channelId: thread, authorId: "lead" });
	expect(fetchImpl).toHaveBeenCalledWith(
		`https://discord.com/api/v10/channels/${thread}/messages?around=${message}&limit=3`,
		expect.objectContaining({ signal: expect.any(AbortSignal) }),
	);
});
it("fails closed for missing, malformed, wrong-channel and unreadable receipts", async () => {
	for (const body of [
		[],
		[{ id: message, channel_id: "other", author: { id: "lead" } }],
		[{ id: message, channel_id: thread }],
		{},
	]) {
		await expect(
			readEpicIntakeThreadMessage(thread, message, "fixture-token", {
				fetchImpl: vi.fn(async () => new Response(JSON.stringify(body))),
			}),
		).rejects.toThrow();
	}
	await expect(
		readEpicIntakeThreadMessage(thread, message, "fixture-token", {
			fetchImpl: vi.fn(
				async () => new Response("unavailable", { status: 503 }),
			),
		}),
	).rejects.toThrow();
	const fetchImpl = vi.fn();
	await expect(
		readEpicIntakeThreadMessage("../bad", message, "fixture-token", {
			fetchImpl,
		}),
	).rejects.toThrow();
	expect(fetchImpl).not.toHaveBeenCalled();
});
