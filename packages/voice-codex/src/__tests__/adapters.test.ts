import { describe, expect, it, vi } from "vitest";
import { DiscordMirrorClient, FlywheelCommDelivery } from "../adapters.js";

describe("DiscordMirrorClient", () => {
	it("uses Discord nonce enforcement and disables mentions", async () => {
		const fetchImpl = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({ id: "223456789012345678" }), {
					status: 200,
				}),
		);
		const mirror = new DiscordMirrorClient({
			token: "secret",
			timeoutMs: 2_000,
			fetchImpl,
		});
		expect(await mirror.post("123456789012345678", "hello", "noncea")).toEqual({
			messageId: "223456789012345678",
		});
		expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
			content: "hello",
			nonce: "noncea",
			enforce_nonce: true,
			allowed_mentions: { parse: [] },
		});
	});

	it("rejects content and nonces outside Discord's bounded contract", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const mirror = new DiscordMirrorClient({
			token: "secret",
			timeoutMs: 2_000,
			fetchImpl,
		});
		await expect(
			mirror.post("123456789012345678", "x".repeat(2_001), "nonce-a"),
		).rejects.toThrow(/discord_mirror_content_invalid/);
		await expect(
			mirror.post("123456789012345678", "hello", "x".repeat(26)),
		).rejects.toThrow(/discord_mirror_nonce_invalid/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("FlywheelCommDelivery", () => {
	it("passes content only on stdin and projects replay identity", async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					lane: "inserted_inbox",
					deliveryId: "chat:raya:223456789012345678",
				}),
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					origin: "voice",
					voiceSessionId: "11111111-1111-4111-8111-111111111111",
					authorId: "founder",
					text: "hello",
				}),
			});
		const delivery = new FlywheelCommDelivery({
			cliPath: "/comm.js",
			dbPath: "/comm.db",
			founderUserId: "founder",
			run,
		});
		const ingested = await delivery.ingest({
			leadId: "raya",
			voiceSessionId: "11111111-1111-4111-8111-111111111111",
			threadId: "123456789012345678",
			messageId: "223456789012345678",
			authorId: "qa",
			authorName: "QA",
			text: "hello",
			ts: "2026-09-09T00:00:00.000Z",
		});
		expect(ingested.lane).toBe("inserted_inbox");
		expect(run.mock.calls[0]?.[0]).not.toContain("hello");
		expect(run.mock.calls[0]?.[1]).toBe("hello");
		const args = run.mock.calls[0]?.[0] as string[];
		expect(args[args.indexOf("--author-id") + 1]).toBe("qa");
		expect(args[args.indexOf("--founder-id") + 1]).toBe("founder");
		expect(await delivery.read("chat:raya:223456789012345678")).toEqual({
			origin: "voice",
			voiceSessionId: "11111111-1111-4111-8111-111111111111",
			authorId: "founder",
			text: "hello",
		});
	});
});
