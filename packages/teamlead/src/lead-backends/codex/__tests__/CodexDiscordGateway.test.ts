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

function snowflakeAt(iso: string): string {
	const discordEpoch = 1_420_070_400_000n;
	return ((BigInt(new Date(iso).getTime()) - discordEpoch) << 22n).toString();
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
	it("records a cross-department receipt before journal accept and completes it after", () => {
		const order: string[] = [];
		const source = new FakeSource();
		const gw = new CodexDiscordGateway({
			source,
			router: {
				submit: () => {
					order.push("journal.accept");
					return { accepted: true, entryId: "entry-1" };
				},
			},
			botUserId: "self-bot",
			channelIds: ["round-1"],
			resolveReplyChannelId: () => "round-1",
			externalReceiptSaga: {
				begin(message) {
					order.push(`receipt.begin:${message.messageId}`);
				},
				complete(messageId) {
					order.push(`receipt.complete:${messageId}`);
				},
			},
		});

		expect(gw.handle(msg({ id: "cross-1", channelId: "round-1" }))).toBe(true);
		expect(order).toEqual([
			"receipt.begin:cross-1",
			"journal.accept",
			"receipt.complete:cross-1",
		]);
	});

	it("pins the cursor at either cross-store crash seam and converges on retry", () => {
		const source = new FakeSource();
		const accepted = new Set<string>();
		let beginFails = true;
		let completeFails = true;
		const begin = vi.fn(() => {
			if (beginFails) throw new Error("comm begin unavailable");
		});
		const complete = vi.fn(() => {
			if (completeFails) throw new Error("comm complete unavailable");
		});
		const submit = vi.fn((input: { idempotencyKey: string }) => {
			const fresh = !accepted.has(input.idempotencyKey);
			accepted.add(input.idempotencyKey);
			return { accepted: fresh, entryId: "entry-1" };
		});
		const gw = new CodexDiscordGateway({
			source,
			router: { submit },
			botUserId: "self-bot",
			channelIds: ["round-1"],
			resolveReplyChannelId: () => "round-1",
			externalReceiptSaga: { begin, complete },
			logger: silent,
		});
		const cross = msg({ id: "cross-crash", channelId: "round-1" });

		// receipt before submit failed: no durable Lead accept and no cursor advance.
		expect(gw.handle(cross)).toBe(false);
		expect(submit).not.toHaveBeenCalled();
		beginFails = false;
		// submit succeeded, but delivered transition failed: cursor remains pinned.
		expect(gw.handle(cross)).toBe(false);
		expect(accepted.size).toBe(1);
		completeFails = false;
		// Discord replay is a journal duplicate; the receipt completion is idempotent.
		expect(gw.handle(cross)).toBe(true);
		expect(accepted.size).toBe(1);
		expect(submit).toHaveBeenCalledTimes(2);
		expect(complete).toHaveBeenCalledTimes(2);
	});

	it("does not create or settle a receipt for ordinary same-channel chat", () => {
		const begin = vi.fn();
		const complete = vi.fn();
		const submit = vi.fn(() => ({ accepted: true, entryId: "entry-chat" }));
		const gw = new CodexDiscordGateway({
			source: new FakeSource(),
			router: { submit },
			botUserId: "self-bot",
			channelIds: ["chat-1"],
			externalReceiptSaga: { begin, complete },
		});

		expect(gw.handle(msg({ id: "chat-plain", channelId: "chat-1" }))).toBe(
			true,
		);
		expect(submit).toHaveBeenCalledTimes(1);
		expect(begin).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
	});

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

	it("prefixes the original payload with the message instant in founder local time", () => {
		const { gw, router } = make({
			founderTimezone: () => "America/Los_Angeles",
		});

		gw.handle(
			msg({
				id: "timestamped",
				timestampMs: new Date("2026-07-17T02:23:05.000Z").getTime(),
				content: "do the thing",
			}),
		);

		expect(router.submits[0].payload).toBe(
			"[sent 2026-07-16 19:23 PDT — founder 当前时区渲染]\ndo the thing",
		);
	});

	it("uses the old sent instant for a downtime replay, not processing time", () => {
		const { gw, router } = make({ founderTimezone: () => "Asia/Tokyo" });

		gw.handle(
			msg({
				id: "backlog",
				timestampMs: new Date("2026-07-16T02:23:05.000Z").getTime(),
				content: "sent while down",
			}),
		);

		expect(
			router.submits[0].payload.startsWith(
				"[sent 2026-07-16 11:23 GMT+9 — founder 当前时区渲染]",
			),
		).toBe(true);
	});

	it("re-renders an old instant when the current founder timezone changes", () => {
		let timezone = "America/Los_Angeles";
		const { gw, router } = make({ founderTimezone: () => timezone });
		const old = msg({
			id: "old-1",
			timestampMs: new Date("2026-07-17T02:23:05.000Z").getTime(),
		});

		gw.handle(old);
		timezone = "Asia/Tokyo";
		gw.handle({ ...old, id: "old-2" });

		expect(router.submits[0].payload).toContain("2026-07-16 19:23 PDT");
		expect(router.submits[1].payload).toContain("2026-07-17 11:23 GMT+9");
	});

	it("falls back to the snowflake instant when timestampMs is absent", () => {
		const { gw, router } = make({
			founderTimezone: () => "America/Los_Angeles",
		});

		gw.handle(
			msg({ id: snowflakeAt("2026-07-17T02:23:05.000Z"), content: "hi" }),
		);

		expect(router.submits[0].payload).toContain("2026-07-16 19:23 PDT");
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
