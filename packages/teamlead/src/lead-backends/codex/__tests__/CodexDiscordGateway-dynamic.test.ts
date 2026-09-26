import { describe, expect, it, vi } from "vitest";
import {
	CodexDiscordGateway,
	type DiscordInboundMessage,
	type DiscordInboundSource,
} from "../CodexDiscordGateway.js";
import { RoundtableThreadRegistry } from "../RoundtableThreadRegistry.js";

const silent = { warn: vi.fn() };

class FakeSource implements DiscordInboundSource {
	handler?: (m: DiscordInboundMessage) => boolean;
	onMessage(h: (m: DiscordInboundMessage) => boolean) {
		this.handler = h;
	}
	async start() {}
	async stop() {}
}

function fakeRouter() {
	const submits: Array<{ idempotencyKey: string; replyChannelId?: string }> =
		[];
	return {
		submits,
		submit: (i: {
			idempotencyKey: string;
			source: "discord" | "mailbox";
			payload: string;
			replyChannelId?: string;
		}) => {
			submits.push({
				idempotencyKey: i.idempotencyKey,
				replyChannelId: i.replyChannelId,
			});
			return { accepted: true, entryId: i.idempotencyKey };
		},
	};
}

function msg(over: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
	return {
		id: "m1",
		channelId: "thread-1",
		authorId: "other",
		authorBot: true,
		content: "<@self-bot> hi",
		mentions: ["self-bot"],
		...over,
	};
}

describe("CodexDiscordGateway — dynamic registry allowlist (FLY-314 Phase 2)", () => {
	it("accepts a message from a registered topic thread (would otherwise be dropped)", () => {
		const registry = new RoundtableThreadRegistry();
		const source = new FakeSource();
		const router = fakeRouter();
		const gw = new CodexDiscordGateway({
			source,
			router,
			botUserId: "self-bot",
			channelIds: ["chat-1"],
			registry,
			resolveReplyChannelId: (m) =>
				registry.has(m.channelId) ? m.channelId : undefined,
			logger: silent,
		});
		// before subscription: thread is NOT allowlisted → dropped (advance)
		expect(gw.handle(msg())).toBe(true);
		expect(router.submits).toHaveLength(0);
		// subscribe the thread → now accepted + routed back to itself
		registry.add("thread-1");
		expect(gw.handle(msg())).toBe(true);
		expect(router.submits).toHaveLength(1);
		expect(router.submits[0].replyChannelId).toBe("thread-1");
	});

	it("byte-compat: no registry → only static channels allowlisted", () => {
		const source = new FakeSource();
		const router = fakeRouter();
		const gw = new CodexDiscordGateway({
			source,
			router,
			botUserId: "self-bot",
			channelIds: ["chat-1"],
			logger: silent,
		});
		expect(gw.handle(msg({ channelId: "thread-1" }))).toBe(true);
		expect(router.submits).toHaveLength(0); // dropped — not allowlisted
		expect(gw.handle(msg({ channelId: "chat-1" }))).toBe(true);
		expect(router.submits).toHaveLength(1);
	});
});
