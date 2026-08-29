import { describe, expect, it } from "vitest";
import { buildLeadDiscordSend } from "../leadDiscordSend.js";

function fakeFetch(status: number, messageId = "m1") {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const impl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => ({ id: messageId }),
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe("buildLeadDiscordSend", () => {
	it("resolves the per-Lead token, posts to the channel, returns the message id", async () => {
		const { impl, calls } = fakeFetch(200, "msg-42");
		const send = buildLeadDiscordSend({
			resolveBotToken: (projectName, leadId) =>
				projectName === "growth" && leadId === "mufasa"
					? "tok-mufasa"
					: undefined,
			fetchImpl: impl,
		});
		const id = await send({
			projectName: "growth",
			leadId: "mufasa",
			channelId: "chan-1",
			text: "hi",
			nonce: "n",
		});
		expect(id).toBe("msg-42");
		expect(calls[0].url).toContain("/channels/chan-1/messages");
		expect(
			(calls[0].init.headers as Record<string, string>).Authorization,
		).toBe("Bot tok-mufasa");
		expect(JSON.parse(calls[0].init.body as string).content).toBe("hi");
	});

	it("throws when the Lead has no bot token (never posts with a wrong identity)", async () => {
		const { impl, calls } = fakeFetch(200);
		const send = buildLeadDiscordSend({
			resolveBotToken: () => undefined,
			fetchImpl: impl,
		});
		await expect(
			send({
				projectName: "p",
				leadId: "x",
				channelId: "c",
				text: "t",
				nonce: "n",
			}),
		).rejects.toThrow(/no bot token/);
		expect(calls).toHaveLength(0);
	});

	it("throws on a non-2xx Discord response (so the handler leaves it retryable)", async () => {
		const { impl } = fakeFetch(503);
		const send = buildLeadDiscordSend({
			resolveBotToken: () => "tok",
			fetchImpl: impl,
		});
		await expect(
			send({
				projectName: "p",
				leadId: "l",
				channelId: "c",
				text: "t",
				nonce: "n",
			}),
		).rejects.toThrow();
	});
});
