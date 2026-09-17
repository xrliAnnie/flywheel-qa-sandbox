import { expect, it } from "vitest";
import { DiscordXhsSource } from "../discord-source.js";

const channelId = "100000000000000003",
	messageId = "100000000000000004",
	attachmentId = "100000000000000005";
const token = "synthetic-bot-secret";
it("uses bot authorization only for fixed Discord API requests, never attachment downloads", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetcher = async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		if (url.includes("/api/"))
			return Response.json({
				id: messageId,
				channel_id: channelId,
				attachments: [
					{
						id: attachmentId,
						url: `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/review.txt`,
						filename: "review.txt",
						size: 5,
					},
				],
			});
		return new Response("bytes");
	};
	const source = new DiscordXhsSource({ channelId, token, fetch: fetcher });
	await source.fetchMessage(channelId, messageId);
	expect(await source.readAttachment(attachmentId)).toEqual(
		Buffer.from("bytes"),
	);
	expect(calls[0]!.init.headers).toEqual({ Authorization: `Bot ${token}` });
	expect(calls[1]!.init.headers).toBeUndefined();
	expect(calls.every((call) => call.init.redirect === "error")).toBe(true);
});
it.each([
	"http://cdn.discordapp.com/x",
	"https://example.test/x",
	`https://cdn.discordapp.com/attachments/other/${attachmentId}/x`,
])("rejects untrusted attachment location %s", async (url) => {
	let calls = 0;
	const source = new DiscordXhsSource({
		channelId,
		token,
		fetch: async () => {
			calls++;
			return Response.json({
				id: messageId,
				channel_id: channelId,
				attachments: [{ id: attachmentId, url, filename: "x", size: 1 }],
			});
		},
	});
	await expect(source.fetchMessage(channelId, messageId)).rejects.toThrow(
		/^founder_source_unavailable$/,
	);
	expect(calls).toBe(1);
});
it("rejects cross-channel reads, unknown attachments, and oversized bodies", async () => {
	const source = new DiscordXhsSource({
		channelId,
		token,
		fetch: async () => new Response("x".repeat(600000)),
	});
	await expect(
		source.fetchMessage("100000000000000009", messageId),
	).rejects.toThrow();
	await expect(source.readAttachment(attachmentId)).rejects.toThrow();
	await expect(source.fetchMessage(channelId, messageId)).rejects.toThrow(
		/^founder_source_unavailable$/,
	);
});
it.each([403, 404, 429])(
	"scrubs HTTP %s and does not retry within one request",
	async (status) => {
		let calls = 0;
		const source = new DiscordXhsSource({
			channelId,
			token,
			fetch: async () => {
				calls++;
				return new Response(token, { status });
			},
		});
		await expect(source.fetchMessage(channelId, messageId)).rejects.toThrow(
			/^founder_source_unavailable$/,
		);
		expect(calls).toBe(1);
	},
);

it("resolves guild membership only for the configured review thread", async () => {
	const guildId = "100000000000000006";
	const source = new DiscordXhsSource({
		channelId,
		token,
		fetch: async () =>
			Response.json({ id: channelId, guild_id: guildId, type: 12 }),
	});
	expect(await source.channelGuild(channelId)).toBe(guildId);
	const wrong = new DiscordXhsSource({
		channelId,
		token,
		fetch: async () =>
			Response.json({ id: channelId, guild_id: guildId, type: 0 }),
	});
	await expect(wrong.channelGuild(channelId)).rejects.toThrow(
		/^founder_source_unavailable$/,
	);
});

it("requests a bounded newest-first page before the persisted scan position", async () => {
	let url = "";
	const source = new DiscordXhsSource({
		channelId,
		token,
		fetch: async (value) => {
			url = value;
			return Response.json([{ id: messageId, channel_id: channelId }]);
		},
	});
	expect(await source.listMessageIdsBefore("100000000000000099")).toEqual([
		messageId,
	]);
	expect(url).toBe(
		`https://discord.com/api/v10/channels/${channelId}/messages?limit=100&before=100000000000000099`,
	);
});
it("uploads complete review bytes with mentions disabled to its fixed thread", async () => {
	let init: RequestInit | undefined;
	const source = new DiscordXhsSource({
		channelId,
		token,
		fetch: async (_url, value) => {
			init = value;
			return Response.json({ id: messageId, channel_id: channelId });
		},
	});
	const bytes = Buffer.from("complete review");
	const result = await source.send(
		"card text",
		[{ name: "review.txt", bytes, sha256: "a".repeat(64) }],
		{ parse: [] },
	);
	expect(result).toBe(messageId);
	expect(init?.method).toBe("POST");
	const form = init?.body as FormData;
	expect(JSON.parse(String(form.get("payload_json")))).toEqual({
		content: "card text",
		allowed_mentions: { parse: [], replied_user: false },
		attachments: [{ id: 0, filename: "review.txt" }],
	});
	expect(
		Buffer.from(await (form.get("files[0]") as Blob).arrayBuffer()),
	).toEqual(bytes);
});
it("never accepts a request to enable mentions or upload above limits", async () => {
	let calls = 0;
	const source = new DiscordXhsSource({
		channelId,
		token,
		fetch: async () => {
			calls++;
			return Response.json({ id: messageId, channel_id: channelId });
		},
	});
	await expect(
		source.send("x", [], { parse: ["everyone"] } as never),
	).rejects.toThrow();
	await expect(
		source.send("x".repeat(2001), [], { parse: [] }),
	).rejects.toThrow();
	expect(calls).toBe(0);
});

it("cleans up only its own newly sent drafts, without a general delete surface", async () => {
	const methods: string[] = [];
	const source = new DiscordXhsSource({
		channelId,
		token,
		fetch: async (_url, init) => {
			methods.push(init.method ?? "GET");
			return init.method === "DELETE"
				? new Response(null, { status: 204 })
				: Response.json({ id: messageId, channel_id: channelId });
		},
	});
	await expect(source.remove(messageId)).rejects.toThrow(
		"preview_cleanup_failed",
	);
	expect(methods).toEqual([]);
	await source.send("draft", [], { parse: [] });
	await source.remove(messageId);
	await expect(source.remove(messageId)).rejects.toThrow(
		"preview_cleanup_failed",
	);
	expect(methods).toEqual(["POST", "DELETE"]);
});
it("projects fetched review messages without passing signed CDN URLs to the renderer", async () => {
	const source = new DiscordXhsSource({
		channelId,
		token,
		fetch: async () =>
			Response.json({
				id: messageId,
				channel_id: channelId,
				author: { id: "100000000000000006" },
				content: "material",
				attachments: [
					{
						id: attachmentId,
						filename: "review.txt",
						size: 5,
						url: `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/review.txt?signature=private`,
					},
				],
			}),
	});
	const projected = await source.fetch(messageId);
	expect(projected.attachments).toEqual([
		{ id: attachmentId, name: "review.txt", size: 5 },
	]);
	expect(JSON.stringify(projected)).not.toContain("private");
});
it("sends notification retries with a stable bounded nonce and mentions disabled", async () => {
	const payloads: Record<string, unknown>[] = [];
	const source = new DiscordXhsSource({
		channelId,
		token,
		fetch: async (_url, init) => {
			payloads.push(
				JSON.parse(String((init.body as FormData).get("payload_json"))),
			);
			return Response.json({
				id: messageId,
				channel_id: channelId,
				attachments: [],
			});
		},
	});
	await source.notify("xhs-approved:receipt-a", "已批准");
	await source.notify("xhs-approved:receipt-a", "已批准");
	expect(payloads[0]?.nonce).toEqual(payloads[1]?.nonce);
	expect(String(payloads[0]?.nonce)).toHaveLength(25);
	expect(payloads[0]?.enforce_nonce).toBe(true);
	expect(payloads[0]?.allowed_mentions).toEqual({
		parse: [],
		replied_user: false,
	});
	await expect(source.remove(messageId)).rejects.toThrow();
});
it.each([1 << 18, 1 << 19])(
	"preflights Message Content flag %s against a real unmentioned founder message",
	async (flags) => {
		const founderId = "100000000000000006",
			botId = "100000000000000007",
			guildId = "100000000000000008";
		const source = new DiscordXhsSource({
			channelId,
			token,
			fetch: async (url) => {
				if (url.endsWith("/users/@me"))
					return Response.json({ id: botId, bot: true });
				if (url.endsWith("/applications/@me")) return Response.json({ flags });
				if (url.endsWith(`/channels/${channelId}`))
					return Response.json({ id: channelId, guild_id: guildId, type: 11 });
				return Response.json([
					{
						id: messageId,
						channel_id: channelId,
						author: { id: founderId, bot: false },
						content: "plain human probe",
						mentions: [],
						type: 0,
					},
				]);
			},
		});
		await expect(
			source.preflight({ founderId, botId, guildId }),
		).resolves.toBeUndefined();
	},
);
it.each([
	"no-intent",
	"empty-page",
	"empty-content",
	"bot-message",
	"mentioned-bot",
	"wrong-bot",
	"wrong-guild",
	"403",
])("fails closed for preflight %s", async (failure) => {
	const founderId = "100000000000000006",
		botId = "100000000000000007",
		guildId = "100000000000000008";
	const source = new DiscordXhsSource({
		channelId,
		token,
		fetch: async (url) => {
			if (failure === "403") return new Response(null, { status: 403 });
			if (url.endsWith("/users/@me"))
				return Response.json({
					id: failure === "wrong-bot" ? founderId : botId,
					bot: true,
				});
			if (url.endsWith("/applications/@me"))
				return Response.json({ flags: failure === "no-intent" ? 0 : 1 << 19 });
			if (url.endsWith(`/channels/${channelId}`))
				return Response.json({
					id: channelId,
					guild_id: failure === "wrong-guild" ? founderId : guildId,
					type: 11,
				});
			return Response.json(
				failure === "empty-page"
					? []
					: [
							{
								id: messageId,
								channel_id: channelId,
								author: { id: founderId, bot: failure === "bot-message" },
								content: failure === "empty-content" ? "" : "probe",
								mentions: failure === "mentioned-bot" ? [{ id: botId }] : [],
								type: 0,
							},
						],
			);
		},
	});
	await expect(source.preflight({ founderId, botId, guildId })).rejects.toThrow(
		"founder_source_unavailable",
	);
});
