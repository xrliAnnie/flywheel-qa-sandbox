/**
 * FLY-1041 Chunk 8 — founder receipt reaction PUT (unit).
 */
import { describe, expect, it, vi } from "vitest";
import { reactToFounderMessage } from "../approval-signal/founder-ack.js";

function fetchWith(status: number) {
	return vi.fn(async () => ({ ok: status < 300, status })) as unknown as
		| typeof fetch
		| ReturnType<typeof vi.fn>;
}

describe("reactToFounderMessage", () => {
	it("PUTs the bot reaction on the founder's message (emoji URI-encoded)", async () => {
		const fetchImpl = fetchWith(204);
		const r = await reactToFounderMessage({
			botToken: "tok",
			channelId: "T1",
			messageId: "M1",
			emoji: "✅",
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(r).toEqual({ ok: true, status: 204 });
		const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, RequestInit];
		expect(url).toBe(
			`https://discord.com/api/v10/channels/T1/messages/M1/reactions/${encodeURIComponent("✅")}/@me`,
		);
		expect(init.method).toBe("PUT");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bot tok",
		);
	});

	it("403 (missing ADD_REACTIONS) → ok:false with the status for the audit", async () => {
		const r = await reactToFounderMessage({
			botToken: "tok",
			channelId: "T1",
			messageId: "M1",
			emoji: "❓",
			fetchImpl: fetchWith(403) as typeof fetch,
		});
		expect(r).toEqual({ ok: false, status: 403 });
	});

	it("network throw → ok:false, never throws", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const r = await reactToFounderMessage({
			botToken: "tok",
			channelId: "T1",
			messageId: "M1",
			emoji: "✅",
			fetchImpl,
		});
		expect(r.ok).toBe(false);
	});
});
