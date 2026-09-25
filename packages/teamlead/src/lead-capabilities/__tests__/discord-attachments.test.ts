import { afterEach, expect, it, vi } from "vitest";
import {
	DiscordInboundAttachmentError,
	fetchDiscordAttachment,
	fetchInboundDiscordAttachment,
} from "../discord-attachments.js";

const threadId = "111111111111111111",
	messageId = "222222222222222222",
	attachmentId = "333333333333333333";
afterEach(() => vi.useRealTimers());
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

it("applies the narrow inbound text policy and preserves an allowed UTF-8 charset", async () => {
	const f = fixture({ content_type: "text/plain; charset=UTF-8" });
	f.fetchImpl.mockResolvedValueOnce(
		Response.json({
			id: messageId,
			channel_id: threadId,
			attachments: [
				{
					id: attachmentId,
					size: 5,
					content_type: "text/plain; charset=UTF-8",
					url: `https://cdn.discordapp.com/attachments/${threadId}/${attachmentId}/note.txt`,
				},
			],
		}),
	);
	f.fetchImpl.mockResolvedValueOnce(
		new Response("hello", {
			headers: {
				"content-length": "5",
				"content-type": "text/plain; charset=utf-8",
			},
		}),
	);
	const result = await fetchInboundDiscordAttachment({
		...f.options,
		expected: { mimeType: "text/plain;charset=utf-8", sizeBytes: 5 },
	});
	expect(result).toEqual({
		data: Buffer.from("hello"),
		mimeType: "text/plain;charset=utf-8",
	});
	expect(
		new Headers(f.fetchImpl.mock.calls[1]![1]!.headers).get("authorization"),
	).toBeNull();
});

it("evaluates an untyped attachment independently from a valid image in the same message", async () => {
	const badAttachmentId = "444444444444444444";
	const image = Buffer.alloc(24);
	Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(image);
	image.writeUInt32BE(2, 16);
	image.writeUInt32BE(3, 20);
	const message = {
		id: messageId,
		channel_id: threadId,
		attachments: [
			{
				id: badAttachmentId,
				size: 10,
				url: `https://cdn.discordapp.com/attachments/${threadId}/${badAttachmentId}/unknown.bin`,
			},
			{
				id: attachmentId,
				size: image.length,
				content_type: "image/png",
				url: `https://cdn.discordapp.com/attachments/${threadId}/${attachmentId}/image.png`,
			},
		],
	};
	const fetchImpl = vi.fn<typeof fetch>(async (url) =>
		String(url).includes("/api/v10/")
			? Response.json(message)
			: new Response(image, {
					headers: {
						"content-length": String(image.length),
						"content-type": "image/png",
					},
				}),
	);
	const common = {
		threadId,
		messageId,
		botToken: "PRIVATE_TOKEN",
		secrets: ["PRIVATE_TOKEN"],
		signal: AbortSignal.timeout(15_000),
		assertCurrent: () => {},
		fetchImpl,
	};

	await expect(
		fetchInboundDiscordAttachment({
			...common,
			attachmentId,
			expected: { mimeType: "image/png", sizeBytes: image.length },
		}),
	).resolves.toEqual({ data: image, mimeType: "image/png" });
	await expect(
		fetchInboundDiscordAttachment({
			...common,
			attachmentId: badAttachmentId,
			expected: { mimeType: "image/png", sizeBytes: 10 },
		}),
	).rejects.toMatchObject({ reason: "invalid_metadata" });
	expect(fetchImpl).toHaveBeenCalledTimes(3);
	expect(
		fetchImpl.mock.calls.some(([url]) =>
			String(url).includes(`/${badAttachmentId}/`),
		),
	).toBe(false);
});

it("revalidates authority at fetch boundaries instead of every body chunk", async () => {
	const data = Buffer.alloc(64, 0x61);
	const assertCurrent = vi.fn();
	const fetchImpl = vi.fn<typeof fetch>(async (url) => {
		if (String(url).includes("/api/v10/")) {
			return Response.json({
				id: messageId,
				channel_id: threadId,
				attachments: [
					{
						id: attachmentId,
						size: data.length,
						content_type: "text/plain",
						url: `https://cdn.discordapp.com/attachments/${threadId}/${attachmentId}/note.txt`,
					},
				],
			});
		}
		let offset = 0;
		return new Response(
			new ReadableStream({
				pull(controller) {
					if (offset === data.length) {
						controller.close();
						return;
					}
					controller.enqueue(data.subarray(offset, ++offset));
				},
			}),
			{ headers: { "content-type": "text/plain" } },
		);
	});
	await expect(
		fetchInboundDiscordAttachment({
			threadId,
			messageId,
			attachmentId,
			botToken: "PRIVATE_TOKEN",
			secrets: ["PRIVATE_TOKEN"],
			signal: AbortSignal.timeout(15_000),
			assertCurrent,
			expected: { mimeType: "text/plain", sizeBytes: data.length },
			fetchImpl,
		}),
	).resolves.toEqual({ data, mimeType: "text/plain" });
	expect(assertCurrent.mock.calls.length).toBeLessThanOrEqual(6);
});

it.each([
	[
		"unsupported_type",
		{ content_type: "application/pdf" },
		{ mimeType: "application/pdf", sizeBytes: 5 },
		0,
	],
	[
		"unsupported_type",
		{ content_type: "text/plain; charset=iso-8859-1" },
		{ mimeType: "text/plain;charset=iso-8859-1", sizeBytes: 5 },
		0,
	],
	[
		"too_large",
		{ size: 32769, content_type: "text/plain" },
		{ mimeType: "text/plain", sizeBytes: 32769 },
		1,
	],
	[
		"invalid_metadata",
		{ content_type: "image/png" },
		{ mimeType: "image/jpeg", sizeBytes: 5 },
		1,
	],
])(
	"rejects %s from Discord metadata before CDN access",
	async (reason, overrides, expected, metadataCalls) => {
		const f = fixture(overrides);
		await expect(
			fetchInboundDiscordAttachment({ ...f.options, expected }),
		).rejects.toMatchObject({ reason });
		expect(f.fetchImpl).toHaveBeenCalledTimes(metadataCalls);
	},
);

it.each([
	[404, "not_found"],
	[403, "fetch_unavailable"],
	[429, "fetch_unavailable"],
	[503, "fetch_unavailable"],
])("maps Discord metadata HTTP %i to %s", async (status, reason) => {
	const f = fixture();
	f.fetchImpl.mockResolvedValueOnce(new Response(null, { status }));
	await expect(
		fetchInboundDiscordAttachment({
			...f.options,
			expected: { mimeType: "text/plain", sizeBytes: 5 },
		}),
	).rejects.toMatchObject({ reason });
});

it("rejects a truncated or conflicting CDN response as invalid content", async () => {
	const f = fixture();
	f.fetchImpl.mockResolvedValueOnce(
		Response.json({
			id: messageId,
			channel_id: threadId,
			attachments: [
				{
					id: attachmentId,
					size: 5,
					content_type: "text/plain",
					url: `https://cdn.discordapp.com/attachments/${threadId}/${attachmentId}/note.txt`,
				},
			],
		}),
	);
	f.fetchImpl.mockResolvedValueOnce(
		new Response("hell", {
			headers: { "content-length": "4", "content-type": "text/plain" },
		}),
	);
	await expect(
		fetchInboundDiscordAttachment({
			...f.options,
			expected: { mimeType: "text/plain", sizeBytes: 5 },
		}),
	).rejects.toMatchObject({ reason: "invalid_content" });
});

it("bounds a CDN stream that stops producing bytes", async () => {
	vi.useFakeTimers();
	const f = fixture();
	f.fetchImpl.mockResolvedValueOnce(
		Response.json({
			id: messageId,
			channel_id: threadId,
			attachments: [
				{
					id: attachmentId,
					size: 5,
					content_type: "text/plain",
					url: `https://cdn.discordapp.com/attachments/${threadId}/${attachmentId}/note.txt`,
				},
			],
		}),
	);
	f.fetchImpl.mockResolvedValueOnce(
		new Response(
			new ReadableStream({
				pull: () => new Promise(() => {}),
			}),
			{ headers: { "content-type": "text/plain" } },
		),
	);
	const pending = fetchInboundDiscordAttachment({
		...f.options,
		expected: { mimeType: "text/plain", sizeBytes: 5 },
	});
	const rejected = expect(pending).rejects.toMatchObject({ reason: "timeout" });
	await vi.advanceTimersByTimeAsync(15001);
	await rejected;
});

it("keeps typed inbound failures identifiable without exposing provider data", () => {
	const error = new DiscordInboundAttachmentError("busy");
	expect(error.message).toBe("discord_inbound_attachment_unavailable");
	expect(error.reason).toBe("busy");
});
