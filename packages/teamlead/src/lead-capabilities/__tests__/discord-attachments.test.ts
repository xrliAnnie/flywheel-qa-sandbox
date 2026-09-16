import { expect, it, vi } from "vitest";
import { fetchDiscordAttachment } from "../discord-attachments.js";

const threadId = "111111111111111111",
	messageId = "222222222222222222",
	attachmentId = "333333333333333333";
function fixture(overrides: Record<string, unknown> = {}) {
	const attachment = {
		id: attachmentId,
		size: 5,
		content_type: "text/plain",
		url: `https://cdn.discordapp.com/attachments/${threadId}/${attachmentId}/note.txt?ex=abc&hm=signature`,
		...overrides,
	};
	let current = true;
	const fetchImpl = vi.fn<typeof fetch>(async (url) =>
		String(url).includes("/api/v10/")
			? Response.json({
					id: messageId,
					channel_id: threadId,
					attachments: [attachment],
				})
			: new Response("hello", { headers: { "content-type": "text/plain" } }),
	);
	const options = {
		threadId,
		messageId,
		attachmentId,
		botToken: "PRIVATE_TOKEN",
		secrets: ["PRIVATE_TOKEN"],
		signal: AbortSignal.timeout(15000),
		assertCurrent: () => {
			if (!current) throw new Error("stale");
		},
		fetchImpl,
	};
	return {
		options,
		fetchImpl,
		revoke: () => {
			current = false;
		},
	};
}
it("resolves exact message attachment and downloads bounded bytes without forwarding credentials", async () => {
	const f = fixture(),
		result = await fetchDiscordAttachment(f.options);
	expect(result.data.toString()).toBe("hello");
	expect(result.mimeType).toBe("text/plain");
	expect(
		new Headers(f.fetchImpl.mock.calls[0]![1]!.headers).get("authorization"),
	).toBe("Bot PRIVATE_TOKEN");
	expect(
		new Headers(f.fetchImpl.mock.calls[1]![1]!.headers).get("authorization"),
	).toBeNull();
	expect(f.fetchImpl.mock.calls.every((c) => c[1]!.redirect === "error")).toBe(
		true,
	);
});
it.each([
	{ url: "https://foreign.invalid/a" },
	{
		url: `https://cdn.discordapp.com/attachments/999999999999999999/${attachmentId}/note.txt`,
	},
	{ size: 26214401 },
])(
	"rejects foreign or oversized attachment before CDN access: %j",
	async (overrides) => {
		const f = fixture(overrides);
		await expect(fetchDiscordAttachment(f.options)).rejects.toThrow();
		expect(f.fetchImpl).toHaveBeenCalledOnce();
	},
);
it("rejects redirects, revocation during metadata lookup, byte mismatch and secrets", async () => {
	const redirect = fixture();
	redirect.fetchImpl.mockResolvedValueOnce(
		new Response(null, {
			status: 302,
			headers: { location: "https://foreign.invalid" },
		}),
	);
	await expect(fetchDiscordAttachment(redirect.options)).rejects.toThrow();
	expect(redirect.fetchImpl).toHaveBeenCalledOnce();
	const stale = fixture();
	const original = stale.fetchImpl.getMockImplementation()!;
	stale.fetchImpl.mockImplementationOnce(async (...args) => {
		const response = await original(...args);
		stale.revoke();
		return response;
	});
	await expect(fetchDiscordAttachment(stale.options)).rejects.toThrow();
	expect(stale.fetchImpl).toHaveBeenCalledOnce();
	const size = fixture({ size: 6 });
	await expect(fetchDiscordAttachment(size.options)).rejects.toThrow();
	const secret = fixture({ size: 13 });
	secret.fetchImpl.mockImplementationOnce(async () =>
		Response.json({
			id: messageId,
			channel_id: threadId,
			attachments: [
				{
					id: attachmentId,
					size: 13,
					content_type: "text/plain",
					url: `https://cdn.discordapp.com/attachments/${threadId}/${attachmentId}/a.txt`,
				},
			],
		}),
	);
	secret.fetchImpl.mockResolvedValueOnce(
		new Response("PRIVATE_TOKEN", {
			headers: { "content-type": "text/plain" },
		}),
	);
	await expect(fetchDiscordAttachment(secret.options)).rejects.toThrow();
});
