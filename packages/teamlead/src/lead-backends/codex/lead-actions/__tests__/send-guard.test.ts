import { describe, expect, it } from "vitest";
import {
	deriveSendIdempotencyKey,
	SendIdempotencyCache,
	SlidingWindowRateLimiter,
	shouldRefuseProactiveRoundtable,
} from "../send-guard.js";

describe("shouldRefuseProactiveRoundtable (FLY-676)", () => {
	it("refuses target=roundtable when autoContinue on", () => {
		expect(
			shouldRefuseProactiveRoundtable({
				target: "roundtable",
				autoContinue: true,
			}),
		).toBe(true);
		expect(
			shouldRefuseProactiveRoundtable({
				target: "  roundtable  ",
				autoContinue: true,
			}),
		).toBe(true);
	});
	it("does NOT refuse roundtable when autoContinue off (kill-switch / byte-compat)", () => {
		expect(
			shouldRefuseProactiveRoundtable({
				target: "roundtable",
				autoContinue: false,
			}),
		).toBe(false);
	});
	it("never refuses non-roundtable targets (chat, other)", () => {
		expect(
			shouldRefuseProactiveRoundtable({ target: "chat", autoContinue: true }),
		).toBe(false);
		expect(
			shouldRefuseProactiveRoundtable({ target: "random", autoContinue: true }),
		).toBe(false);
	});
});

describe("deriveSendIdempotencyKey", () => {
	it("is deterministic for the same (channel, text)", () => {
		const a = deriveSendIdempotencyKey("111", "hello");
		const b = deriveSendIdempotencyKey("111", "hello");
		expect(a).toBe(b);
	});

	it("differs by channel and by text", () => {
		expect(deriveSendIdempotencyKey("111", "hi")).not.toBe(
			deriveSendIdempotencyKey("222", "hi"),
		);
		expect(deriveSendIdempotencyKey("111", "hi")).not.toBe(
			deriveSendIdempotencyKey("111", "ho"),
		);
	});

	it("is not confusable across a channel/text boundary (NUL separator)", () => {
		// "11" + "1text" vs "111" + "text" must not collide.
		expect(deriveSendIdempotencyKey("11", "1text")).not.toBe(
			deriveSendIdempotencyKey("111", "text"),
		);
	});
});

describe("SlidingWindowRateLimiter (FLY-220 loop-safety)", () => {
	it("allows up to maxPerWindow then refuses", () => {
		const rl = new SlidingWindowRateLimiter({
			maxPerWindow: 2,
			windowMs: 1000,
		});
		expect(rl.tryAcquire("c", 0)).toBe(true);
		expect(rl.tryAcquire("c", 10)).toBe(true);
		expect(rl.tryAcquire("c", 20)).toBe(false); // over cap
	});

	it("is per-channel (one channel's cap does not starve another)", () => {
		const rl = new SlidingWindowRateLimiter({
			maxPerWindow: 1,
			windowMs: 1000,
		});
		expect(rl.tryAcquire("a", 0)).toBe(true);
		expect(rl.tryAcquire("a", 10)).toBe(false);
		expect(rl.tryAcquire("b", 10)).toBe(true); // different channel still ok
	});

	it("frees capacity after the window slides", () => {
		const rl = new SlidingWindowRateLimiter({
			maxPerWindow: 1,
			windowMs: 1000,
		});
		expect(rl.tryAcquire("c", 0)).toBe(true);
		expect(rl.tryAcquire("c", 500)).toBe(false);
		expect(rl.tryAcquire("c", 1001)).toBe(true); // first hit aged out
	});

	it("rejects invalid config", () => {
		expect(
			() => new SlidingWindowRateLimiter({ maxPerWindow: 0, windowMs: 1 }),
		).toThrow();
		expect(
			() => new SlidingWindowRateLimiter({ maxPerWindow: 1, windowMs: 0 }),
		).toThrow();
	});
});

describe("SendIdempotencyCache", () => {
	it("returns the prior message id within the TTL (collapses a retry)", () => {
		const cache = new SendIdempotencyCache(1000);
		const key = deriveSendIdempotencyKey("c", "hi");
		expect(cache.get(key, 0)).toBeUndefined();
		cache.record(key, "msg-1", 0);
		expect(cache.get(key, 500)).toBe("msg-1");
	});

	it("expires entries after the TTL", () => {
		const cache = new SendIdempotencyCache(1000);
		const key = deriveSendIdempotencyKey("c", "hi");
		cache.record(key, "msg-1", 0);
		expect(cache.get(key, 1001)).toBeUndefined();
	});

	it("rejects invalid TTL", () => {
		expect(() => new SendIdempotencyCache(0)).toThrow();
	});
});
