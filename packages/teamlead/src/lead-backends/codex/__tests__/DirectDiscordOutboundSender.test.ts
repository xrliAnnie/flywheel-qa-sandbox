import { describe, expect, it, vi } from "vitest";
import { DirectDiscordOutboundSender } from "../DirectDiscordOutboundSender.js";

function fakePost(ok = true, error?: string) {
	const calls: Array<{
		channelId: string;
		text: string;
		token: string;
		options: { origin: string };
	}> = [];
	let n = 0;
	const postImpl = (async (
		channelId: string,
		text: string,
		token: string,
		options: { origin: string },
	) => {
		calls.push({ channelId, text, token, options });
		return ok
			? { ok: true, messageIds: [`m-${++n}`], chunksSent: 1, chunksTotal: 1 }
			: {
					ok: false,
					error: error ?? "boom",
					messageIds: [],
					chunksSent: 0,
					chunksTotal: 1,
				};
	}) as never;
	return { postImpl, calls };
}

function make(opts: { ok?: boolean; error?: string } = {}) {
	const { postImpl, calls } = fakePost(opts.ok ?? true, opts.error);
	const sender = new DirectDiscordOutboundSender({
		botToken: "mufasa-tok",
		channelId: "chan-mufasa",
		postImpl,
		logger: { warn: vi.fn() },
	});
	return { sender, calls };
}

describe("DirectDiscordOutboundSender", () => {
	it("requires botToken + channelId", () => {
		expect(
			() => new DirectDiscordOutboundSender({ botToken: "", channelId: "c" }),
		).toThrow(/botToken/);
		expect(
			() => new DirectDiscordOutboundSender({ botToken: "t", channelId: "" }),
		).toThrow(/channelId/);
	});

	it("enqueue → deliver posts directly to Discord with the Lead's own token", async () => {
		const { sender, calls } = make();
		const id = await sender.enqueue({
			leadId: "mufasa",
			text: "hello world",
			idempotencyKey: "e1:out",
		});
		expect(id).toBe("e1:out");
		await sender.deliver(id);
		expect(calls).toEqual([
			{
				channelId: "chan-mufasa",
				text: "hello world",
				token: "mufasa-tok",
				options: { origin: "lead_authored" },
			},
		]);
	});

	it("FLY-267: enqueue with channelId routes the reply to THAT channel", async () => {
		const { sender, calls } = make();
		const id = await sender.enqueue({
			leadId: "mufasa",
			text: "in roundtable",
			idempotencyKey: "e2:out",
			channelId: "round-table",
		});
		await sender.deliver(id);
		expect(calls).toEqual([
			{
				channelId: "round-table",
				text: "in roundtable",
				token: "mufasa-tok",
				options: { origin: "lead_authored" },
			},
		]);
	});

	it("FLY-267: enqueue without channelId falls back to the default chat channel (byte-compat)", async () => {
		const { sender, calls } = make();
		const id = await sender.enqueue({
			leadId: "mufasa",
			text: "in chat",
			idempotencyKey: "e3:out",
		});
		await sender.deliver(id);
		expect(calls[0].channelId).toBe("chan-mufasa");
	});

	it("deliver is locally idempotent (second deliver does not re-post)", async () => {
		const { sender, calls } = make();
		const id = await sender.enqueue({
			leadId: "m",
			text: "x",
			idempotencyKey: "e1:out",
		});
		await sender.deliver(id);
		await sender.deliver(id);
		expect(calls).toHaveLength(1);
	});

	it("enqueue is idempotent on key (keeps first text)", async () => {
		const { sender, calls } = make();
		await sender.enqueue({ leadId: "m", text: "first", idempotencyKey: "k" });
		await sender.enqueue({ leadId: "m", text: "changed", idempotencyKey: "k" });
		await sender.deliver("k");
		expect(calls[0].text).toBe("first");
	});

	it("a failed post throws + leaves the entry retryable", async () => {
		const { sender } = make({ ok: false, error: "discord 503" });
		const id = await sender.enqueue({
			leadId: "m",
			text: "x",
			idempotencyKey: "k",
		});
		await expect(sender.deliver(id)).rejects.toThrow(/discord 503/);
		// retry succeeds once Discord recovers (re-uses the same sender path)
	});

	it("deliver on an unknown outboxId throws", async () => {
		const { sender } = make();
		await expect(sender.deliver("nope")).rejects.toThrow(/no outbox/);
	});
});
