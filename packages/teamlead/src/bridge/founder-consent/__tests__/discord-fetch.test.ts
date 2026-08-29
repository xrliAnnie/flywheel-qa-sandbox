import { describe, expect, it } from "vitest";
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
