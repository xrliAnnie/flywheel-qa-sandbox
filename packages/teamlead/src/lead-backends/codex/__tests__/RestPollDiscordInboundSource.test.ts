import { describe, expect, it, vi } from "vitest";
import type { DiscordInboundMessage } from "../CodexDiscordGateway.js";
import { InMemoryInboundCursorStore } from "../InboundCursorStore.js";
import { RestPollDiscordInboundSource } from "../RestPollDiscordInboundSource.js";

const silent = { warn: vi.fn() };

interface RawMsg {
	id: string;
	channel_id: string;
	content: string;
	author: { id: string; bot: boolean };
}

/** Fake Discord REST: per-channel message log (chronological); serves
 * newest-first windows honoring ?after=. */
function fakeDiscord(channels: Record<string, RawMsg[]>) {
	const calls: Array<{ channelId: string; after?: string }> = [];
	const fetchImpl = (async (url: string) => {
		const u = new URL(url);
		const channelId = u.pathname.split("/")[4]; // /api/v10/channels/{id}/messages
		const after = u.searchParams.get("after") ?? undefined;
		const limit = Number(u.searchParams.get("limit") ?? "50");
		calls.push({ channelId, after });
		const log = channels[channelId] ?? [];
		let slice = log;
		if (after) {
			const idx = log.findIndex((m) => m.id === after);
			slice = idx >= 0 ? log.slice(idx + 1) : log;
		}
		// `after` paginates FORWARD: the OLDEST `limit` messages newer than the cursor,
		// returned NEWEST-first (matches Discord). Without `after`, the latest `limit`.
		const page = after ? slice.slice(0, limit) : slice.slice(-limit);
		const newestFirst = [...page].reverse();
		return {
			ok: true,
			status: 200,
			json: async () => newestFirst,
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

function msg(
	id: string,
	channel_id: string,
	content: string,
	bot = false,
): RawMsg {
	return {
		id,
		channel_id,
		content,
		author: { id: bot ? "botX" : "annie", bot },
	};
}

describe("RestPollDiscordInboundSource — construction", () => {
	it("requires a botToken", () => {
		expect(
			() =>
				new RestPollDiscordInboundSource({ botToken: "", channelIds: ["c"] }),
		).toThrow(/botToken/);
	});
});

describe("RestPollDiscordInboundSource — baseline + poll", () => {
	it("start baselines to the latest message (no history replay)", async () => {
		const { fetchImpl } = fakeDiscord({
			c1: [msg("1", "c1", "old"), msg("2", "c1", "recent")],
		});
		const got: DiscordInboundMessage[] = [];
		const src = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["c1"],
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }), // don't auto-run the loop
			logger: silent,
		});
		src.onMessage((m) => {
			got.push(m);
			return true;
		});
		await src.start();
		// baseline only — nothing delivered yet
		expect(got).toEqual([]);
		// a NEW message arrives after baseline
		got.length = 0;
		await src.pollOnce();
		expect(got).toEqual([]); // still nothing new (baseline was id 2, the latest)
	});

	it("delivers only messages after the baseline, oldest-first, mapped correctly", async () => {
		const log = [msg("1", "c1", "old")];
		const { fetchImpl } = fakeDiscord({ c1: log });
		const got: DiscordInboundMessage[] = [];
		const src = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["c1"],
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }),
			logger: silent,
		});
		src.onMessage((m) => {
			got.push(m);
			return true;
		});
		await src.start(); // baseline = id 1
		// two new messages land
		log.push(msg("2", "c1", "first new"), msg("3", "c1", "second new", true));
		await src.pollOnce();
		expect(got.map((m) => [m.id, m.content, m.authorBot])).toEqual([
			["2", "first new", false],
			["3", "second new", true], // oldest-first; bot flag mapped
		]);
		// advancing lastSeen → a second poll with nothing new delivers nothing
		got.length = 0;
		await src.pollOnce();
		expect(got).toEqual([]);
	});

	it("polls multiple channels independently", async () => {
		const c1 = [msg("a1", "c1", "base1")];
		const c2 = [msg("b1", "c2", "base2")];
		const { fetchImpl } = fakeDiscord({ c1, c2 });
		const got: DiscordInboundMessage[] = [];
		const src = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["c1", "c2"],
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }),
			logger: silent,
		});
		src.onMessage((m) => {
			got.push(m);
			return true;
		});
		await src.start();
		c1.push(msg("a2", "c1", "new1"));
		c2.push(msg("b2", "c2", "new2"));
		await src.pollOnce();
		expect(got.map((m) => m.content).sort()).toEqual(["new1", "new2"]);
	});

	it("a fetch error on one channel is logged and does not crash the poll", async () => {
		const warn = vi.fn();
		const fetchImpl = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		const src = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["c1"],
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }),
			logger: { warn },
		});
		await src.start(); // baseline fetch throws → logged
		await expect(src.pollOnce()).resolves.toBe(0); // nothing delivered, no crash
		expect(warn).toHaveBeenCalled();
	});
});

describe("RestPollDiscordInboundSource — durable cursor (HIGH-4: no restart-gap loss)", () => {
	it("first run baselines to latest AND persists the cursor", async () => {
		const store = new InMemoryInboundCursorStore();
		const { fetchImpl } = fakeDiscord({
			c1: [msg("1", "c1", "old"), msg("2", "c1", "latest")],
		});
		const src = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["c1"],
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }),
			logger: silent,
			cursorStore: store,
		});
		await src.start();
		expect(store.load("c1")).toBe("2"); // baseline persisted
	});

	it("RESTART RESUMES from the saved cursor — delivers messages sent during downtime", async () => {
		const store = new InMemoryInboundCursorStore();
		store.save("c1", "2"); // a prior run got up to msg 2, then the Lead went down
		// while down, Annie sent msgs 3 + 4
		const { fetchImpl, calls } = fakeDiscord({
			c1: [
				msg("1", "c1", "old"),
				msg("2", "c1", "seen"),
				msg("3", "c1", "sent while down"),
				msg("4", "c1", "also while down"),
			],
		});
		const got: DiscordInboundMessage[] = [];
		const src = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["c1"],
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }),
			logger: silent,
			cursorStore: store,
		});
		src.onMessage((m) => {
			got.push(m);
			return true;
		});
		await src.start();
		// start must NOT have re-baselined (no fetch-latest call) — it resumed from cursor "2"
		expect(calls.filter((c) => c.after === undefined)).toHaveLength(0);
		await src.pollOnce();
		// the downtime gap (3,4) is delivered, oldest-first — NOT dropped
		expect(got.map((m) => m.content)).toEqual([
			"sent while down",
			"also while down",
		]);
		expect(store.load("c1")).toBe("4"); // cursor advanced + persisted
	});

	it("drains a >limit downtime backlog FULLY on resume (forward pagination, no loss)", async () => {
		const store = new InMemoryInboundCursorStore();
		store.save("c1", "0"); // resume from before everything
		const log: RawMsg[] = [];
		for (let i = 1; i <= 120; i++) log.push(msg(String(i), "c1", `m${i}`));
		const { fetchImpl } = fakeDiscord({ c1: log });
		const got: DiscordInboundMessage[] = [];
		const src = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["c1"],
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }),
			logger: silent,
			cursorStore: store,
			limit: 50,
		});
		src.onMessage((m) => {
			got.push(m);
			return true;
		});
		await src.start(); // drain loop walks all 3 pages (50+50+20)
		expect(got).toHaveLength(120); // nothing skipped
		expect(got[0].content).toBe("m1"); // oldest-first
		expect(got[119].content).toBe("m120"); // through the newest
		expect(store.load("c1")).toBe("120");
	});

	it("a cursor-persist failure does NOT crash the poll (at-least-once preserved)", async () => {
		const warn = vi.fn();
		const throwingStore = {
			load: () => "1",
			save: () => {
				throw new Error("disk full");
			},
		};
		const { fetchImpl } = fakeDiscord({
			c1: [msg("1", "c1", "seen"), msg("2", "c1", "new")],
		});
		const got: DiscordInboundMessage[] = [];
		const src = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["c1"],
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }),
			logger: { warn },
			cursorStore: throwingStore,
		});
		src.onMessage((m) => {
			got.push(m);
			return true;
		});
		// start drains (resume from "1") — must not throw despite save failing
		await expect(src.start()).resolves.toBeUndefined();
		expect(got.map((m) => m.content)).toEqual(["new"]); // still delivered
		expect(warn).toHaveBeenCalled(); // failure logged
	});

	it("does NOT advance past a DURABLE-ACCEPT failure — retries it once accepted (HIGH-4)", async () => {
		const store = new InMemoryInboundCursorStore();
		store.save("c1", "1"); // resume after msg 1
		const { fetchImpl } = fakeDiscord({
			c1: [
				msg("1", "c1", "seen"),
				msg("2", "c1", "fails to journal"),
				msg("3", "c1", "after the failure"),
			],
		});
		const seen: string[] = [];
		let acceptMsg2 = false; // msg 2's durable-accept fails until the journal recovers
		const src = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["c1"],
			fetchImpl,
			setTimer: () => ({ cancel: () => {} }),
			logger: silent,
			cursorStore: store,
			limit: 50,
		});
		src.onMessage((m) => {
			seen.push(m.id);
			return m.id === "2" ? acceptMsg2 : true; // handler returns safe-to-advance
		});
		await src.start(); // resume from "1"; msg 2 fails → must NOT advance past it
		expect(store.load("c1")).toBe("1"); // cursor did NOT skip the un-accepted msg 2
		acceptMsg2 = true; // journal recovers
		await src.pollOnce(); // re-fetch after "1" → 2 (ok now), 3 (ok)
		expect(store.load("c1")).toBe("3"); // now advances through 2 and 3
		expect(seen.filter((id) => id === "2").length).toBeGreaterThanOrEqual(2); // retried
		expect(seen).toContain("3");
	});
});

describe("RestPollDiscordInboundSource — lifecycle", () => {
	it("the scheduled loop runs pollOnce; stop cancels it", async () => {
		const log = [msg("1", "c1", "base")];
		const { fetchImpl } = fakeDiscord({ c1: log });
		let fire: (() => void) | null = null;
		let cancelled = false;
		const src = new RestPollDiscordInboundSource({
			botToken: "tok",
			channelIds: ["c1"],
			fetchImpl,
			setTimer: (fn) => {
				fire = fn;
				return {
					cancel: () => {
						cancelled = true;
					},
				};
			},
			logger: silent,
		});
		const got: DiscordInboundMessage[] = [];
		src.onMessage((m) => {
			got.push(m);
			return true;
		});
		await src.start();
		log.push(msg("2", "c1", "live"));
		fire?.(); // simulate the timer firing → pollOnce
		await new Promise((r) => setTimeout(r, 0));
		expect(got.map((m) => m.content)).toEqual(["live"]);
		await src.stop();
		expect(cancelled).toBe(true);
	});
});
