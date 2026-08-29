/**
 * FLY-404 — DiscordTypingNotifier unit tests. The keepalive loop + the safety cap
 * are exercised with an INJECTED scheduler (no real timers) + an injected clock, so
 * every assertion is deterministic. `sendImpl` is a fake (no network).
 */

import { describe, expect, it, vi } from "vitest";
import { DiscordTypingNotifier } from "../DiscordTypingNotifier.js";

/** A fake scheduler that records active interval callbacks so a test can fire
 * them on demand (`tickAll`) and assert how many loops are live (`activeCount`). */
function fakeScheduler() {
	const active = new Map<number, () => void>();
	let seq = 0;
	return {
		impl: {
			setInterval: (cb: () => void): ReturnType<typeof setInterval> => {
				const id = ++seq;
				active.set(id, cb);
				return id as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: (h: ReturnType<typeof setInterval>): void => {
				active.delete(h as unknown as number);
			},
		},
		tickAll: () => {
			for (const cb of [...active.values()]) cb();
		},
		activeCount: () => active.size,
	};
}

/** Drain microtasks so the async `fire()` (and its failure accounting) settles. */
const flush = () => new Promise((r) => setImmediate(r));

function make(
	overrides: {
		sendImpl?: (
			c: string,
			t: string,
		) => Promise<{ ok: boolean; error?: string }>;
		now?: () => number;
		maxDurationMs?: number;
		maxConsecutiveFailures?: number;
	} = {},
) {
	const sched = fakeScheduler();
	const sendImpl =
		overrides.sendImpl ?? vi.fn(async () => ({ ok: true }) as const);
	const notifier = new DiscordTypingNotifier({
		botToken: "bot-token",
		defaultChannelId: "chat-default",
		sendImpl,
		refreshMs: 8000,
		maxDurationMs: overrides.maxDurationMs ?? 600_000,
		maxConsecutiveFailures: overrides.maxConsecutiveFailures ?? 3,
		scheduler: sched.impl,
		now: overrides.now ?? (() => 0),
		logger: { warn: vi.fn() },
	});
	return { notifier, sendImpl, sched };
}

describe("DiscordTypingNotifier (FLY-404)", () => {
	it("start() fires typing immediately with the bot token + resolved channel", async () => {
		const { notifier, sendImpl } = make();
		notifier.start();
		await flush();
		expect(sendImpl).toHaveBeenCalledTimes(1);
		expect(sendImpl).toHaveBeenCalledWith("chat-default", "bot-token");
		notifier.close();
	});

	it("start(channelId) routes typing to that channel (cross-dept)", async () => {
		const { notifier, sendImpl } = make();
		notifier.start("round-1");
		await flush();
		expect(sendImpl).toHaveBeenCalledWith("round-1", "bot-token");
		notifier.close();
	});

	it("keepalive: each interval tick re-fires typing (Discord ~10s expiry)", async () => {
		const { notifier, sendImpl, sched } = make();
		notifier.start();
		await flush();
		expect(sendImpl).toHaveBeenCalledTimes(1); // immediate
		sched.tickAll();
		await flush();
		expect(sendImpl).toHaveBeenCalledTimes(2); // refresh
		sched.tickAll();
		await flush();
		expect(sendImpl).toHaveBeenCalledTimes(3);
		notifier.close();
	});

	it("stop() clears the keepalive — no more refreshes", async () => {
		const { notifier, sendImpl, sched } = make();
		notifier.start();
		await flush();
		expect(sched.activeCount()).toBe(1);
		notifier.stop();
		expect(sched.activeCount()).toBe(0);
		sched.tickAll(); // nothing scheduled → no-op
		await flush();
		expect(sendImpl).toHaveBeenCalledTimes(1);
	});

	it("start() is idempotent per channel (one loop, not stacked)", async () => {
		const { notifier, sched } = make();
		notifier.start();
		notifier.start(); // same default channel
		expect(sched.activeCount()).toBe(1);
		notifier.close();
	});

	it("safety cap: a tick past maxDurationMs self-stops the loop", async () => {
		let clock = 0;
		const { notifier, sendImpl, sched } = make({
			now: () => clock,
			maxDurationMs: 10_000,
		});
		notifier.start();
		await flush();
		expect(sendImpl).toHaveBeenCalledTimes(1);
		clock = 9_000; // under cap → refreshes
		sched.tickAll();
		await flush();
		expect(sendImpl).toHaveBeenCalledTimes(2);
		clock = 11_000; // over cap → self-stop, NO new send
		sched.tickAll();
		await flush();
		expect(sendImpl).toHaveBeenCalledTimes(2);
		expect(sched.activeCount()).toBe(0);
	});

	it("circuit breaker: stops after N consecutive send failures", async () => {
		const sendImpl = vi.fn(async () => ({ ok: false, error: "429" }) as const);
		const { notifier, sched } = make({ sendImpl, maxConsecutiveFailures: 3 });
		notifier.start();
		await flush(); // failure 1 (immediate)
		expect(sched.activeCount()).toBe(1);
		sched.tickAll();
		await flush(); // failure 2
		expect(sched.activeCount()).toBe(1);
		sched.tickAll();
		await flush(); // failure 3 → breaker trips → loop stops
		expect(sched.activeCount()).toBe(0);
		expect(sendImpl).toHaveBeenCalledTimes(3);
	});

	it("a success resets the consecutive-failure counter", async () => {
		const results = [
			{ ok: false, error: "x" },
			{ ok: false, error: "x" },
			{ ok: true },
			{ ok: false, error: "x" },
			{ ok: false, error: "x" },
		];
		let i = 0;
		const sendImpl = vi.fn(async () => results[i++] ?? { ok: true });
		const { notifier, sched } = make({ sendImpl, maxConsecutiveFailures: 3 });
		notifier.start();
		await flush(); // fail 1
		sched.tickAll();
		await flush(); // fail 2
		sched.tickAll();
		await flush(); // success → reset
		expect(sched.activeCount()).toBe(1); // still alive (counter reset)
		sched.tickAll();
		await flush(); // fail 1 (after reset)
		sched.tickAll();
		await flush(); // fail 2
		expect(sched.activeCount()).toBe(1); // not yet 3 in a row
		notifier.close();
	});

	it("close() clears ALL active loops", async () => {
		const { notifier, sched } = make();
		notifier.start("a");
		notifier.start("b");
		expect(sched.activeCount()).toBe(2);
		notifier.close();
		expect(sched.activeCount()).toBe(0);
	});

	it("never throws even if sendImpl rejects", async () => {
		const sendImpl = vi.fn(async () => {
			throw new Error("boom");
		});
		const { notifier, sched } = make({ sendImpl, maxConsecutiveFailures: 2 });
		expect(() => notifier.start()).not.toThrow();
		await flush(); // rejected → counts as a failure, no unhandled throw
		sched.tickAll();
		await flush(); // 2nd failure → breaker stops
		expect(sched.activeCount()).toBe(0);
	});
});
