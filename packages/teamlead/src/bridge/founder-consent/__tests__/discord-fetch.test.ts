import { describe, expect, it, vi } from "vitest";
import {
	annotateRoles,
	DiscordFetchError,
	DiscordFetcher,
	type FetchImpl,
} from "../discord-fetch.js";

const okFetch =
	(messages: unknown[]): FetchImpl =>
	async () => ({ ok: true, status: 200, json: async () => messages });

const errFetch =
	(status: number): FetchImpl =>
	async () => ({ ok: false, status, json: async () => ({}) });

describe("DiscordFetcher.fetchThreadMessages", () => {
	it("fetches and verifies one exact reply message without accepting foreign-channel evidence", async () => {
		const channelId = "111111111111111111",
			messageId = "222222222222222222";
		let actualChannel = channelId;
		const request = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				id: messageId,
				channel_id: actualChannel,
				content: "hello",
				timestamp: "2026-09-13T00:00:00Z",
				author: { id: "333333333333333333" },
			}),
		}));
		const f = new DiscordFetcher("tok", request);
		const signal = new AbortController().signal;
		expect(
			await f.fetchMessage(channelId, messageId, { signal }),
		).toMatchObject({ id: messageId, content: "hello" });
		expect(request).toHaveBeenCalledWith(
			`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
			{ method: "GET", headers: { Authorization: "Bot tok" }, signal },
		);
		actualChannel = "444444444444444444";
		await expect(f.fetchMessage(channelId, messageId)).rejects.toThrow(
			"Discord reply target mismatch",
		);
		await expect(f.fetchMessage(channelId, "../x")).rejects.toThrow(
			"invalid_discord_message_target",
		);
		expect(request).toHaveBeenCalledTimes(2);
	});
	it("passes a bounded before cursor and cancellation signal without changing legacy requests", async () => {
		const fetch = vi.fn(okFetch([]));
		const f = new DiscordFetcher("tok", fetch);
		const signal = new AbortController().signal;
		await f.fetchThreadMessages("123", 10, { before: "456", signal });
		expect(fetch).toHaveBeenLastCalledWith(
			"https://discord.com/api/v10/channels/123/messages?limit=10&before=456",
			{ method: "GET", headers: { Authorization: "Bot tok" }, signal },
		);
		await f.fetchThreadMessages("123", 10);
		expect(fetch).toHaveBeenLastCalledWith(
			"https://discord.com/api/v10/channels/123/messages?limit=10",
			{ method: "GET", headers: { Authorization: "Bot tok" } },
		);
		for (const before of ["", "1&limit=100", "1".repeat(21)]) {
			await expect(
				f.fetchThreadMessages("123", 10, { before }),
			).rejects.toThrow("invalid_discord_cursor");
		}
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("maps raw messages to {id, authorId, content, ts, isBot}", async () => {
		const f = new DiscordFetcher(
			"tok",
			okFetch([
				{
					id: "1",
					content: "hi",
					timestamp: "2026-05-28T10:00:00Z",
					author: { id: "u1", bot: false },
				},
			]),
		);
		const msgs = await f.fetchThreadMessages("thread", 50);
		expect(msgs).toEqual([
			{
				id: "1",
				authorId: "u1",
				content: "hi",
				ts: "2026-05-28T10:00:00Z",
				isBot: false,
			},
		]);
	});

	it.each([
		[401, "auth"],
		[403, "auth"],
		[404, "not_found"],
		[429, "rate_limited"],
		[500, "upstream"],
		[503, "upstream"],
	])("maps HTTP %i → %s error kind", async (status, kind) => {
		const f = new DiscordFetcher("tok", errFetch(status));
		await expect(f.fetchThreadMessages("t", 10)).rejects.toMatchObject({
			kind,
		});
	});

	it("throws network error when fetch rejects", async () => {
		const f = new DiscordFetcher("tok", async () => {
			throw new Error("dns");
		});
		await expect(f.fetchThreadMessages("t", 10)).rejects.toBeInstanceOf(
			DiscordFetchError,
		);
	});

	it("throws when body is not an array", async () => {
		const f = new DiscordFetcher("tok", async () => ({
			ok: true,
			status: 200,
			json: async () => ({ not: "array" }),
		}));
		await expect(f.fetchThreadMessages("t", 10)).rejects.toMatchObject({
			kind: "network",
		});
	});
});

describe("annotateRoles", () => {
	const ctx = {
		founderUserId: "F",
		leadBotIds: new Set(["L"]),
		runnerBotIds: new Set(["R"]),
	};
	const mk = (authorId: string, content = "", isBot = false) => ({
		id: `m-${authorId}`,
		authorId,
		content,
		ts: "t",
		isBot,
	});

	it("labels founder / lead / runner / bot / other", () => {
		const out = annotateRoles(
			[
				mk("F"),
				mk("L", "", true),
				mk("R", "", true),
				mk("X", "", true),
				mk("H", "human msg", false),
			],
			ctx,
		);
		expect(out.map((m) => m.role)).toEqual([
			"founder",
			"lead",
			"runner",
			"bot",
			"other",
		]);
	});

	it("detects runner via [Runner] content marker", () => {
		const out = annotateRoles([mk("Z", "[Runner] PR is up", true)], ctx);
		expect(out[0]?.role).toBe("runner");
	});
});
