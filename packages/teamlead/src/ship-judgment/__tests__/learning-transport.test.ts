import { expect, it, vi } from "vitest";
import { writeLearningMessage } from "../learning-transport.js";

const input = {
	threadId: "123456789012345679",
	guildId: "123456789012345670",
	replyTo: "123456789012345678",
	botUserId: "123456789012345690",
	botToken: "fixture-token",
	content: "已记录，未改变批准",
	signal: new AbortController().signal,
};
const thread = {
	id: input.threadId,
	guild_id: input.guildId,
	type: 11,
	thread_metadata: { archived: false, locked: false },
};
it.each([
	[
		"archived",
		{ ...thread, thread_metadata: { archived: true } },
		"thread_archived",
	],
	[
		"wrong_guild",
		{ ...thread, guild_id: "123456789012345699" },
		"thread_identity_invalid",
	],
] as const)("does not POST to %s thread", async (_, data, code) => {
	const fetchImpl = vi.fn(async () => new Response(JSON.stringify(data)));
	expect(await writeLearningMessage({ ...input, fetchImpl })).toEqual({
		kind: "unavailable",
		code,
	});
	expect(fetchImpl).toHaveBeenCalledOnce();
});
it("preflights thread and sends one exact reply with authenticated response", async () => {
	const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			expect(body.message_reference).toEqual({
				message_id: input.replyTo,
				fail_if_not_exists: true,
			});
			expect(body.allowed_mentions).toEqual({ parse: [] });
			return new Response(
				JSON.stringify({
					id: "123456789012345695",
					channel_id: input.threadId,
					author: { id: input.botUserId, bot: true },
					content: body.content,
					timestamp: "2026-09-11T00:00:00.000Z",
				}),
			);
		}
		return new Response(JSON.stringify(thread));
	});
	expect(await writeLearningMessage({ ...input, fetchImpl })).toEqual({
		kind: "posted",
		messageId: "123456789012345695",
		visibleAt: "2026-09-11T00:00:00.000Z",
	});
	expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it.each(["preflight", "post"] as const)(
	"reports %s 403 as unavailable without retry",
	async (stage) => {
		const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) =>
			stage === "preflight" || init?.method === "POST"
				? new Response("{}", { status: 403 })
				: new Response(JSON.stringify(thread)),
		);
		expect(await writeLearningMessage({ ...input, fetchImpl })).toEqual({
			kind: "unavailable",
			code: "discord_forbidden",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(stage === "preflight" ? 1 : 2);
	},
);

it.each(["preflight", "post"] as const)(
	"distinguishes %s transport loss from an unknown POST result",
	async (stage) => {
		const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
			if (stage === "preflight" || init?.method === "POST")
				throw new Error("fixture lost response");
			return new Response(JSON.stringify(thread));
		});
		expect(await writeLearningMessage({ ...input, fetchImpl })).toEqual({
			kind: stage === "preflight" ? "failed" : "uncertain",
		});
	},
);
it.each(["preflight", "post"] as const)(
	"preserves %s retry-after without immediate retries",
	async (stage) => {
		const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) =>
			stage === "preflight" || init?.method === "POST"
				? new Response(JSON.stringify({ retry_after: 12.5 }), { status: 429 })
				: new Response(JSON.stringify(thread)),
		);
		expect(
			await writeLearningMessage({ ...input, fetchImpl, now: () => 1000 }),
		).toEqual({ kind: "failed", retryAt: 13500 });
		expect(fetchImpl).toHaveBeenCalledTimes(stage === "preflight" ? 1 : 2);
	},
);

it("rechecks sending permission after asynchronous preflight", async () => {
	let allowed = true;
	const fetchImpl = vi.fn(async () => {
		allowed = false;
		return new Response(JSON.stringify(thread));
	});
	expect(
		await writeLearningMessage({ ...input, fetchImpl, canPost: () => allowed }),
	).toEqual({ kind: "failed" });
	expect(fetchImpl).toHaveBeenCalledOnce();
});
