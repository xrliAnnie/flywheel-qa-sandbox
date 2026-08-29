import { describe, expect, it, vi } from "vitest";
import {
	CodexDiscordGateway,
	type DiscordInboundMessage,
	type DiscordInboundSource,
} from "../CodexDiscordGateway.js";

const silent = { warn: vi.fn() };

class FakeSource implements DiscordInboundSource {
	handler?: (m: DiscordInboundMessage) => boolean;
	started = false;
	stopped = false;
	onMessage(h: (m: DiscordInboundMessage) => boolean) {
		this.handler = h;
	}
	async start() {
		this.started = true;
	}
	async stop() {
		this.stopped = true;
	}
	emit(m: DiscordInboundMessage) {
		this.handler?.(m);
	}
}

function fakeRouter() {
	const submits: Array<{
		idempotencyKey: string;
		source: string;
		payload: string;
		replyChannelId?: string;
	}> = [];
	return {
		submits,
		submit: (i: {
			idempotencyKey: string;
			source: "discord" | "mailbox";
			payload: string;
			replyChannelId?: string;
		}) => {
			submits.push(i);
			return { accepted: true, entryId: i.idempotencyKey };
		},
	};
}

function make(
	over: Partial<
		Parameters<typeof CodexDiscordGateway.prototype.constructor>[0]
	> = {},
) {
	const source = new FakeSource();
	const router = fakeRouter();
	const gw = new CodexDiscordGateway({
		source,
		router,
		botUserId: "self-bot",
		channelIds: ["chat-1", "core-1"],
		logger: silent,
		...over,
	});
	return { source, router, gw };
}

function msg(over: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
	return {
		id: "m1",
		channelId: "chat-1",
		authorId: "annie",
		authorBot: false,
		content: "hello lead",
		...over,
	};
}

describe("CodexDiscordGateway — construction", () => {
	it("requires botUserId (echo immunity)", () => {
		const source = new FakeSource();
		expect(
			() =>
				new CodexDiscordGateway({
					source,
					router: fakeRouter(),
					botUserId: "",
					channelIds: ["c"],
				}),
		).toThrow(/botUserId/);
	});
});

describe("CodexDiscordGateway — reply routing (FLY-267 回)", () => {
	it("attaches replyChannelId from resolveReplyChannelId to the submitted input", () => {
		const { source, gw, router } = make({
			// route replies for the cross-dept channel back to it; chat → undefined
			resolveReplyChannelId: (m: DiscordInboundMessage) =>
				m.channelId === "round-1" ? m.channelId : undefined,
			channelIds: ["chat-1", "round-1"],
		});
		void gw.start();
		source.emit(msg({ id: "x1", channelId: "round-1", content: "yo" }));
		source.emit(msg({ id: "x2", channelId: "chat-1", content: "hi" }));
		expect(router.submits[0]).toMatchObject({
			idempotencyKey: "x1",
			replyChannelId: "round-1",
		});
		expect(router.submits[1].replyChannelId).toBeUndefined(); // chat → default
	});

	it("no resolveReplyChannelId → replyChannelId always undefined (byte-compat)", () => {
		const { source, gw, router } = make();
		void gw.start();
		source.emit(msg({ id: "y1", content: "hi" }));
		expect(router.submits[0].replyChannelId).toBeUndefined();
	});
});

describe("CodexDiscordGateway — forwarding + filters", () => {
	// handle() returns SAFE-TO-ADVANCE: an intentional drop (filter) is `true` (the
	// cursor may advance past it); a drop is VERIFIED by router.submits being empty.
	it("forwards an allowed channel message to router.submit (msgId + content)", () => {
		const { gw, router } = make();
		expect(gw.handle(msg({ id: "m9", content: "do the thing" }))).toBe(true);
		expect(router.submits).toEqual([
			{ idempotencyKey: "m9", source: "discord", payload: "do the thing" },
		]);
	});

	it("ECHO IMMUNITY: drops the Lead's own bot messages (FLY-220) — safe to advance", () => {
		const { gw, router } = make();
		expect(gw.handle(msg({ authorId: "self-bot", authorBot: true }))).toBe(
			true,
		);
		expect(router.submits).toHaveLength(0); // dropped, not forwarded
	});

	it("drops messages outside the channel allowlist (safe to advance)", () => {
		const { gw, router } = make();
		expect(gw.handle(msg({ channelId: "random-chan" }))).toBe(true);
		expect(router.submits).toHaveLength(0);
	});

	it("handles the core channel (second allowlisted channel)", () => {
		const { gw, router } = make();
		expect(gw.handle(msg({ channelId: "core-1", content: "coord" }))).toBe(
			true,
		);
		expect(router.submits[0].payload).toBe("coord");
	});

	it("skips empty / whitespace-only content (safe to advance)", () => {
		const { gw, router } = make();
		expect(gw.handle(msg({ content: "" }))).toBe(true);
		expect(gw.handle(msg({ content: "   \n " }))).toBe(true);
		expect(router.submits).toHaveLength(0);
	});

	it("drops a message with no id (can't dedup) — safe to advance", () => {
		const { gw, router } = make();
		expect(gw.handle(msg({ id: "" }))).toBe(true);
		expect(router.submits).toHaveLength(0);
	});

	it("allows another bot's message (other Leads) — only OWN bot is echo-filtered", () => {
		const { gw, router } = make();
		expect(
			gw.handle(msg({ authorId: "other-lead-bot", authorBot: true })),
		).toBe(true);
		expect(router.submits).toHaveLength(1);
	});
});

describe("CodexDiscordGateway — shouldHandle policy", () => {
	it("applies an injected predicate after the mandatory filters", () => {
		const { gw, router } = make({
			// only handle messages mentioning the trigger word
			shouldHandle: (m: DiscordInboundMessage) => m.content.includes("@lead"),
		});
		expect(gw.handle(msg({ content: "noise" }))).toBe(true); // dropped → advance
		expect(gw.handle(msg({ id: "m2", content: "hey @lead" }))).toBe(true);
		expect(router.submits.map((s) => s.idempotencyKey)).toEqual(["m2"]);
	});

	it("the predicate cannot override echo immunity (own bot still dropped)", () => {
		const { gw, router } = make({ shouldHandle: () => true });
		expect(gw.handle(msg({ authorId: "self-bot" }))).toBe(true); // dropped → advance
		expect(router.submits).toHaveLength(0);
	});
});

describe("CodexDiscordGateway — robustness", () => {
	it("a DURABLE-ACCEPT FAILURE returns false (do NOT advance) so the source retries (HIGH-4)", () => {
		const source = new FakeSource();
		const gw = new CodexDiscordGateway({
			source,
			router: {
				submit: () => {
					throw new Error("journal write boom");
				},
			},
			botUserId: "self-bot",
			channelIds: ["chat-1"],
			logger: silent,
		});
		// not propagated (listener keeps running) AND not safe-to-advance → retry
		expect(gw.handle(msg())).toBe(false);
	});

	it("resume redelivery: the gateway forwards duplicates (journal dedups downstream)", () => {
		const { gw, router } = make();
		gw.handle(msg({ id: "dup" }));
		gw.handle(msg({ id: "dup" })); // Discord resume re-emits
		// Gateway forwards both; dedup is the journal's job (idempotencyKey).
		expect(router.submits).toHaveLength(2);
		expect(router.submits.every((s) => s.idempotencyKey === "dup")).toBe(true);
	});
});

describe("CodexDiscordGateway — lifecycle", () => {
	it("start wires the handler + starts the source; emitted messages route", async () => {
		const { gw, source, router } = make();
		await gw.start();
		expect(source.started).toBe(true);
		source.emit(msg({ id: "live", content: "via emit" }));
		expect(router.submits).toEqual([
			{ idempotencyKey: "live", source: "discord", payload: "via emit" },
		]);
	});

	it("start is idempotent; stop stops the source", async () => {
		const { gw, source } = make();
		await gw.start();
		await gw.start(); // no-op
		await gw.stop();
		expect(source.stopped).toBe(true);
	});
});
