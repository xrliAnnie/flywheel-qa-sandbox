import { describe, expect, it } from "vitest";
import { RoundtableThreadRegistry } from "../RoundtableThreadRegistry.js";

describe("durable subscription plans", () => {
	it("plans without mutation, expires lazily, touches and evicts atomically", () => {
		let now = 1000;
		const r = new RoundtableThreadRegistry({
			ttlMs: 100,
			cap: 1,
			now: () => now,
		});
		const first = r.planAdd({
			threadId: "11111111111111111",
			parentChannelId: "99999999999999999",
		});
		expect(r.size).toBe(0);
		r.commit(first.next);
		now = 1050;
		r.commit(r.planTouch("11111111111111111").next);
		now = 1100;
		expect(r.has("11111111111111111")).toBe(true);
		const second = r.planAdd({
			threadId: "22222222222222222",
			parentChannelId: "99999999999999999",
		});
		expect(second.evicted.map((e) => e.threadId)).toEqual([
			"11111111111111111",
		]);
		r.commit(second.next);
		now = 1200;
		expect(r.has("22222222222222222")).toBe(false);
		expect(r.planSweep().expired).toHaveLength(1);
	});
	it("restores only correct-domain current entries, newest duplicate and cap", () => {
		const r = new RoundtableThreadRegistry({
			ttlMs: 100,
			cap: 1,
			now: () => 1000,
		});
		const entry = (
			threadId: string,
			subscribedAt: number,
			parentChannelId = "99999999999999999",
			expiresAt = 2000,
		) => ({
			threadId,
			parentChannelId,
			source: "mention" as const,
			subscribedAt: new Date(subscribedAt).toISOString(),
			lastActivityAt: new Date(subscribedAt).toISOString(),
			expiresAt: new Date(expiresAt).toISOString(),
		});
		const plan = r.planRestore(
			{
				version: 1,
				entries: [
					entry("1", 1),
					entry("1", 2),
					entry("2", 3),
					entry("3", 4, "wrong"),
					entry("4", 5, undefined, 500),
				],
			},
			"99999999999999999",
		);
		expect(plan.next.entries.map((e) => e.threadId)).toEqual(["2"]);
		expect(plan.dropped.map((e) => e.why).sort()).toEqual([
			"duplicate",
			"expired",
			"over_cap",
			"wrong_parent",
		]);
		expect(r.size).toBe(0);
	});
});
