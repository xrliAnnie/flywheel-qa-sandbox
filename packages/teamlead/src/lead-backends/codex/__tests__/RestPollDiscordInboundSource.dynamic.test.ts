import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordInboundMessage } from "../CodexDiscordGateway.js";
import { InMemoryInboundCursorStore } from "../InboundCursorStore.js";
import { RestPollDiscordInboundSource } from "../RestPollDiscordInboundSource.js";

interface FetchCall {
	channelId: string;
	after: string | null;
}

/** newest-first message store per channel. */
function makeFetch(channels: Record<string, Array<{ id: string }>>) {
	const calls: FetchCall[] = [];
	const impl = vi.fn(async (url: string) => {
		const m = url.match(/\/channels\/([^/]+)\/messages\?(.*)$/);
		if (!m) throw new Error(`unexpected url ${url}`);
		const channelId = m[1];
		const after = new URLSearchParams(m[2]).get("after");
		calls.push({ channelId, after });
		const all = channels[channelId] ?? [];
		const filtered = after
			? all.filter((x) => Number(x.id) > Number(after))
			: all;
		return {
			ok: true,
			status: 200,
			json: async () => filtered,
		} as unknown as Response;
	});
	return { impl: impl as unknown as typeof fetch, calls };
}

function source(
	channelIds: string[],
	fetchImpl: typeof fetch,
	cursor: InMemoryInboundCursorStore,
) {
	const src = new RestPollDiscordInboundSource({
		botToken: "tok",
		channelIds,
		cursorStore: cursor,
		fetchImpl,
		// no-op timer: tests drive pollOnce / addChannel directly
		setTimer: () => ({ cancel: () => {} }),
	});
	const delivered: DiscordInboundMessage[] = [];
	src.onMessage((msg) => {
		delivered.push(msg);
		return true;
	});
	return { src, delivered };
}

describe("RestPollDiscordInboundSource — dynamic subscription (FLY-314 Phase 2)", () => {
	let cursor: InMemoryInboundCursorStore;
	beforeEach(() => {
		cursor = new InMemoryInboundCursorStore();
	});

	it("byte-compat: no addChannel → pollOnce fetches ONLY base channels, in order", async () => {
		const { impl, calls } = makeFetch({ base1: [{ id: "5" }], base2: [] });
		const { src } = source(["base1", "base2"], impl, cursor);
		await src.start(); // baselines both base channels
		expect(src.dynamicChannelCount).toBe(0);
		calls.length = 0;
		await src.pollOnce();
		expect(calls.map((c) => c.channelId)).toEqual(["base1", "base2"]);
	});

	it("addChannel with NO cursor baselines to latest (no history replay)", async () => {
		const { impl } = makeFetch({
			base1: [],
			"thread-7": [{ id: "30" }, { id: "20" }, { id: "10" }],
		});
		const { src, delivered } = source(["base1"], impl, cursor);
		await src.start();
		await src.addChannel("thread-7");
		expect(src.isSubscribed("thread-7")).toBe(true);
		// baselined to newest (30), delivered NO history
		expect(delivered).toHaveLength(0);
		expect(cursor.load("thread-7")).toBe("30");
	});

	it("addChannel WITH saved cursor resumes + drains downtime (Codex R1#4)", async () => {
		cursor.save("thread-7", "10"); // we were last at 10
		const { impl } = makeFetch({
			base1: [],
			"thread-7": [{ id: "12" }, { id: "11" }, { id: "10" }],
		});
		const { src, delivered } = source(["base1"], impl, cursor);
		await src.start();
		await src.addChannel("thread-7");
		// drained 11 + 12 (the downtime gap), NOT replaying 10 or earlier
		expect(delivered.map((d) => d.id)).toEqual(["11", "12"]);
		expect(cursor.load("thread-7")).toBe("12");
	});

	it("removeChannel stops polling but KEEPS cursor → re-add resumes (Codex R1#10)", async () => {
		cursor.save("thread-7", "10");
		const ch: Record<string, Array<{ id: string }>> = {
			base1: [],
			"thread-7": [{ id: "11" }, { id: "10" }],
		};
		const { impl, calls } = makeFetch(ch);
		const { src, delivered } = source(["base1"], impl, cursor);
		await src.start();
		await src.addChannel("thread-7"); // drains 11
		expect(delivered.map((d) => d.id)).toEqual(["11"]);
		src.removeChannel("thread-7");
		expect(src.isSubscribed("thread-7")).toBe(false);
		// while removed, a new message arrives
		ch["thread-7"].unshift({ id: "12" });
		calls.length = 0;
		await src.pollOnce();
		// not polled while removed
		expect(calls.some((c) => c.channelId === "thread-7")).toBe(false);
		// re-add resumes from kept cursor (12), NOT re-baseline (would skip 12)
		await src.addChannel("thread-7");
		expect(delivered.map((d) => d.id)).toEqual(["11", "12"]);
	});

	it("addChannel is idempotent and ignores base channel ids", async () => {
		const { impl } = makeFetch({ base1: [] });
		const { src } = source(["base1"], impl, cursor);
		await src.start();
		await src.addChannel("base1"); // base → no-op
		expect(src.dynamicChannelCount).toBe(0);
		await src.addChannel("thread-7");
		await src.addChannel("thread-7"); // dup → no-op
		expect(src.dynamicChannelCount).toBe(1);
	});
});
