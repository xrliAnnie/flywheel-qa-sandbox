import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyLeadVoiceTokenIdentity } from "../bot-identity.js";

const botId = "323456789012345678";
describe("voice bot identity GET", () => {
	afterEach(() => vi.useRealTimers());
	it("checks the exact bot and never follows a token-bearing redirect", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify({ id: botId, bot: true })),
		);
		await verifyLeadVoiceTokenIdentity("private-token", botId, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://discord.com/api/v10/users/@me",
			expect.objectContaining({
				method: "GET",
				redirect: "error",
				headers: { Authorization: "Bot private-token" },
				signal: expect.any(AbortSignal),
			}),
		);
	});
	it.each([
		{ id: "wrong", bot: true },
		{ id: botId, bot: false },
		{ id: botId },
		null,
		[],
	])("rejects mismatched or malformed identity %j", async (payload) => {
		await expect(
			verifyLeadVoiceTokenIdentity(
				"secret",
				botId,
				async () => new Response(JSON.stringify(payload)),
			),
		).rejects.toThrow("lead_bot_identity_mismatch");
	});
	it.each([401, 403, 429, 500])(
		"rejects HTTP %s without disclosing response or credentials",
		async (status) => {
			await expect(
				verifyLeadVoiceTokenIdentity(
					"secret",
					botId,
					async () => new Response("secret-response", { status }),
				),
			).rejects.toThrow("voice_bot_identity_unavailable");
		},
	);
	it("bounds response-body parsing too, even if an adapter ignores abort", async () => {
		vi.useFakeTimers();
		const response = new Response(new ReadableStream({ start() {} }));
		const fetchImpl = vi.fn(async () => response);
		const result = expect(
			verifyLeadVoiceTokenIdentity("secret", botId, fetchImpl),
		).rejects.toThrow("voice_bot_identity_unavailable");
		await vi.advanceTimersByTimeAsync(2_000);
		await result;
		expect(fetchImpl.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
	});
	it("redacts transport and malformed JSON errors", async () => {
		for (const fetchImpl of [
			async () => {
				throw new Error("secret");
			},
			async () => new Response("secret"),
		]) {
			await expect(
				verifyLeadVoiceTokenIdentity("secret", botId, fetchImpl),
			).rejects.toThrow("voice_bot_identity_unavailable");
		}
	});
});
