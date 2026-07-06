import { describe, expect, it } from "vitest";
import { ConsentCache } from "../cache.js";

describe("ConsentCache (§9.6)", () => {
	it("returns a hit within TTL and evicts after", () => {
		let t = 1000;
		const c = new ConsentCache<string>(60, () => t);
		const key = c.buildKey({ issueId: "i1", action: "close_tmux" });
		c.set(key, "allow", "2026-01-01T00:00:00Z");
		expect(c.get(key)?.value).toBe("allow");
		t += 59_000;
		expect(c.get(key)?.value).toBe("allow");
		t += 2_000; // now 61s elapsed
		expect(c.get(key)).toBeUndefined();
	});

	it("session-bound: different execution_id → different bucket", () => {
		const c = new ConsentCache<string>(60, () => 0);
		const k1 = c.buildKey({
			issueId: "i1",
			executionId: "A",
			action: "close_tmux",
		});
		const k2 = c.buildKey({
			issueId: "i1",
			executionId: "B",
			action: "close_tmux",
		});
		expect(k1).not.toBe(k2);
	});

	it("session-bound: different status → different bucket", () => {
		const c = new ConsentCache<string>(60, () => 0);
		const k1 = c.buildKey({
			issueId: "i1",
			sessionStatusAtCall: "running",
			action: "close_tmux",
		});
		const k2 = c.buildKey({
			issueId: "i1",
			sessionStatusAtCall: "awaiting_review",
			action: "close_tmux",
		});
		expect(k1).not.toBe(k2);
	});

	it("approve WITHOUT prHeadSha is uncacheable (null key)", () => {
		const c = new ConsentCache<string>(60, () => 0);
		expect(c.buildKey({ issueId: "i1", action: "approve" })).toBeNull();
		expect(
			c.buildKey({ issueId: "i1", action: "approve_to_ship_gate" }),
		).toBeNull();
	});

	it("approve WITH prHeadSha is cacheable + SHA salts the key", () => {
		const c = new ConsentCache<string>(60, () => 0);
		const k1 = c.buildKey({
			issueId: "i1",
			action: "approve",
			prHeadSha: "sha-A",
		});
		const k2 = c.buildKey({
			issueId: "i1",
			action: "approve",
			prHeadSha: "sha-B",
		});
		expect(k1).not.toBeNull();
		expect(k1).not.toBe(k2); // force-push (new SHA) → cache miss
	});

	it("null key never stores or hits", () => {
		const c = new ConsentCache<string>(60, () => 0);
		c.set(null, "allow", "ts");
		expect(c.get(null)).toBeUndefined();
		expect(c.size()).toBe(0);
	});

	it("TTL of 0 disables caching", () => {
		const c = new ConsentCache<string>(0, () => 0);
		const key = c.buildKey({ issueId: "i", action: "close_tmux" });
		c.set(key, "allow", "ts");
		expect(c.get(key)).toBeUndefined();
	});
});
