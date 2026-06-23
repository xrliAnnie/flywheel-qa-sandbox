import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryInboundCursorStore } from "../../../lead-backends/codex/InboundCursorStore.js";
import { StateStore } from "../../../StateStore.js";
import { RoundtableThreadManager } from "../RoundtableThreadManager.js";
import { buildTopicTrigger } from "../topic-trigger.js";

const CH = "rt-channel";
const BOT_USER = "bot-self";

interface CallLog {
	method: string;
	url: string;
}

/** Discord-shaped JSON Response stub. */
function res(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

interface FetchScenario {
	/** newest-first messages in the roundtable channel (id = numeric string). */
	messages?: Array<Record<string, unknown>>;
	/** override create-thread response per call (default: 2xx with id == msgId). */
	createResponse?: (msgId: string) => Response;
	/** override GET /channels/{id} (recovery confirm). */
	getChannelResponse?: (id: string) => Response;
}

function makeFetch(scn: FetchScenario) {
	const calls: CallLog[] = [];
	const messages = scn.messages ?? [];
	const impl = vi.fn(async (url: string, init?: RequestInit) => {
		const method = (init?.method ?? "GET").toUpperCase();
		calls.push({ method, url });
		// GET list messages
		const listMatch = url.match(/\/channels\/([^/]+)\/messages\?(.*)$/);
		if (method === "GET" && listMatch) {
			const params = new URLSearchParams(listMatch[2]);
			const after = params.get("after");
			const filtered = after
				? messages.filter((m) => Number(m.id) > Number(after))
				: messages;
			return res(200, filtered);
		}
		// POST create thread from message
		const createMatch = url.match(
			/\/channels\/[^/]+\/messages\/([^/]+)\/threads$/,
		);
		if (method === "POST" && createMatch) {
			const msgId = createMatch[1];
			return scn.createResponse
				? scn.createResponse(msgId)
				: res(201, { id: msgId });
		}
		// POST seed message into thread
		if (method === "POST" && /\/channels\/[^/]+\/messages$/.test(url)) {
			return res(200, { id: "seed-msg" });
		}
		// PUT thread member
		if (method === "PUT" && /\/thread-members\//.test(url)) {
			return res(204, {});
		}
		// GET /channels/{id} (recovery confirm)
		const getChanMatch = url.match(/\/channels\/([^/]+)$/);
		if (method === "GET" && getChanMatch) {
			const id = getChanMatch[1];
			return scn.getChannelResponse
				? scn.getChannelResponse(id)
				: res(200, { type: 11, parent_id: CH });
		}
		throw new Error(`unexpected fetch ${method} ${url}`);
	});
	return { impl, calls };
}

function mgr(
	store: StateStore,
	fetchImpl: typeof fetch,
	over: Partial<ConstructorParameters<typeof RoundtableThreadManager>[0]> = {},
) {
	return new RoundtableThreadManager({
		store,
		channelId: CH,
		botToken: "tok",
		botUserId: BOT_USER,
		trigger: buildTopicTrigger({ mode: "any_top_level" }),
		memberUserIds: ["lead-1", "lead-2"],
		triggerMode: "any_top_level",
		cursorStore: new InMemoryInboundCursorStore(),
		fetchImpl,
		// never auto-fire the loop — tests drive pollOnce() directly.
		setTimer: () => ({ cancel: () => {} }),
		logger: { warn: () => {} },
		...over,
	});
}

const countCreates = (calls: CallLog[]) =>
	calls.filter(
		(c) => c.method === "POST" && /\/messages\/[^/]+\/threads$/.test(c.url),
	).length;

describe("RoundtableThreadManager.processMessage", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("skips the poller's own bot messages (echo immunity)", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl);
		const advance = await m.processMessage({
			id: "10",
			channelId: CH,
			authorId: BOT_USER,
			authorBot: true,
			content: "TOPIC: x",
			mentions: [],
			mentionEveryone: false,
		});
		expect(advance).toBe(true);
		expect(countCreates(calls)).toBe(0);
	});

	it("threads the poller bot's OWN top-level message when threadOwnBotMessages is set (echo relax)", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl, { threadOwnBotMessages: true });
		const advance = await m.processMessage({
			id: "10",
			channelId: CH,
			authorId: BOT_USER, // the poller's own bot (a CoS broadcast)
			authorBot: true,
			content: "Flywheel restarted — everyone check runners",
			mentions: [],
			mentionEveryone: false,
		});
		expect(advance).toBe(true);
		expect(countCreates(calls)).toBe(1);
		expect(store.getRoundtableTopicThread(CH, "10")?.thread_id).toBe("10");
	});

	it("no-ops when the trigger does not fire", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl, {
			trigger: buildTopicTrigger({ mode: "disabled" }),
			triggerMode: "disabled",
		});
		const advance = await m.processMessage({
			id: "10",
			channelId: CH,
			authorId: "u1",
			authorBot: false,
			content: "hi",
			mentions: [],
			mentionEveryone: false,
		});
		expect(advance).toBe(true);
		expect(countCreates(calls)).toBe(0);
	});

	it("creates a thread, persists mapping, seeds + pulls members", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl);
		const advance = await m.processMessage({
			id: "42",
			channelId: CH,
			authorId: "u1",
			authorBot: false,
			content: "everyone check runners",
			mentions: [],
			mentionEveryone: true,
		});
		expect(advance).toBe(true);
		expect(countCreates(calls)).toBe(1);
		// mapping persisted under the dedicated table, thread_id == message id
		const row = store.getRoundtableTopicThread(CH, "42");
		expect(row?.thread_id).toBe("42");
		// seed + 2 member PUTs (fire-and-forget; allow microtask drain)
		await new Promise((r) => setTimeout(r, 0));
		expect(calls.some((c) => c.method === "PUT")).toBe(true);
	});

	it("pulls the @-mentioned leads into the thread (Annie's T2 model), unioned with config members, minus the poller bot", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl, { memberUserIds: ["base-founder"] });
		await m.processMessage({
			id: "42",
			channelId: CH,
			authorId: "u1",
			authorBot: false,
			content: "@lead-a @lead-b please look",
			// the bot id must be filtered out even if (defensively) mentioned
			mentions: ["lead-a", "lead-b", BOT_USER],
			mentionEveryone: false,
		});
		await new Promise((r) => setTimeout(r, 0));
		const putIds = calls
			.filter((c) => c.method === "PUT")
			.map((c) => c.url.split("/thread-members/")[1]);
		expect(new Set(putIds)).toEqual(
			new Set(["base-founder", "lead-a", "lead-b"]),
		);
		expect(putIds).not.toContain(BOT_USER);
	});

	it("dedups — already-mapped message does not create a second thread", async () => {
		store.upsertRoundtableTopicThread({
			threadId: "42",
			channelId: CH,
			sourceMessageId: "42",
		});
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl);
		const advance = await m.processMessage({
			id: "42",
			channelId: CH,
			authorId: "u1",
			authorBot: false,
			content: "x",
			mentions: [],
			mentionEveryone: true,
		});
		expect(advance).toBe(true);
		expect(countCreates(calls)).toBe(0);
	});

	it("HOLDS the cursor (no advance) on a transient 5xx create failure", async () => {
		const { impl } = makeFetch({ createResponse: () => res(503, {}) });
		const m = mgr(store, impl);
		const advance = await m.processMessage({
			id: "42",
			channelId: CH,
			authorId: "u1",
			authorBot: false,
			content: "x",
			mentions: [],
			mentionEveryone: true,
		});
		expect(advance).toBe(false);
		expect(store.getRoundtableTopicThread(CH, "42")).toBeUndefined();
	});

	it("advances (does not wedge) on a permanent 403 auth error, without persisting", async () => {
		const warn = vi.fn();
		const { impl } = makeFetch({ createResponse: () => res(403, {}) });
		const m = mgr(store, impl, { logger: { warn } });
		const advance = await m.processMessage({
			id: "42",
			channelId: CH,
			authorId: "u1",
			authorBot: false,
			content: "x",
			mentions: [],
			mentionEveryone: true,
		});
		expect(advance).toBe(true);
		expect(store.getRoundtableTopicThread(CH, "42")).toBeUndefined();
		expect(warn).toHaveBeenCalled();
	});

	it("no-ops a deleted source message (404)", async () => {
		const { impl } = makeFetch({ createResponse: () => res(404, {}) });
		const m = mgr(store, impl);
		const advance = await m.processMessage({
			id: "42",
			channelId: CH,
			authorId: "u1",
			authorBot: false,
			content: "x",
			mentions: [],
			mentionEveryone: true,
		});
		expect(advance).toBe(true);
		expect(store.getRoundtableTopicThread(CH, "42")).toBeUndefined();
	});

	it("recovery: create says thread-exists → GET confirms → persists, NO second create", async () => {
		const { impl, calls } = makeFetch({
			createResponse: () => res(400, { code: 160004 }),
			getChannelResponse: () => res(200, { type: 11, parent_id: CH }),
		});
		const m = mgr(store, impl);
		const advance = await m.processMessage({
			id: "42",
			channelId: CH,
			authorId: "u1",
			authorBot: false,
			content: "x",
			mentions: [],
			mentionEveryone: true,
		});
		expect(advance).toBe(true);
		// mapping recovered with thread_id == message id
		expect(store.getRoundtableTopicThread(CH, "42")?.thread_id).toBe("42");
		// exactly ONE create attempt (the duplicate), then a GET probe — no retry
		expect(countCreates(calls)).toBe(1);
		expect(
			calls.some((c) => c.method === "GET" && c.url.endsWith("/channels/42")),
		).toBe(true);
	});

	it("recovery: thread-exists but GET does not confirm → does not persist", async () => {
		const warn = vi.fn();
		const { impl } = makeFetch({
			createResponse: () => res(400, { code: 160004 }),
			getChannelResponse: () => res(404, {}),
		});
		const m = mgr(store, impl, { logger: { warn } });
		const advance = await m.processMessage({
			id: "42",
			channelId: CH,
			authorId: "u1",
			authorBot: false,
			content: "x",
			mentions: [],
			mentionEveryone: true,
		});
		expect(advance).toBe(true);
		expect(store.getRoundtableTopicThread(CH, "42")).toBeUndefined();
	});
});

describe("RoundtableThreadManager poll loop + cursor", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("baselines to latest on first start (no history replay)", async () => {
		const cursor = new InMemoryInboundCursorStore();
		const { impl, calls } = makeFetch({
			messages: [{ id: "30" }, { id: "20" }, { id: "10" }],
		});
		const m = mgr(store, impl, { cursorStore: cursor });
		await m.start();
		// baseline set cursor to newest, opened NO threads for history
		expect(cursor.load(CH)).toBe("30");
		expect(countCreates(calls)).toBe(0);
	});

	it("after baseline, pollOnce processes only NEW messages and advances the cursor", async () => {
		const cursor = new InMemoryInboundCursorStore();
		const scn: FetchScenario = { messages: [{ id: "10" }] };
		const { impl } = makeFetch(scn);
		const m = mgr(store, impl, { cursorStore: cursor });
		await m.start();
		expect(cursor.load(CH)).toBe("10");
		// a new message arrives
		scn.messages?.unshift({
			id: "11",
			channel_id: CH,
			author: { id: "u1", bot: false },
			content: "new topic",
			mention_everyone: true,
		});
		const n = await m.pollOnce();
		expect(n).toBe(1);
		expect(cursor.load(CH)).toBe("11");
		expect(store.getRoundtableTopicThread(CH, "11")?.thread_id).toBe("11");
	});

	it("transient failure mid-batch holds the cursor at the failing message", async () => {
		const cursor = new InMemoryInboundCursorStore();
		cursor.save(CH, "10"); // resume — skip baseline
		const scn: FetchScenario = {
			messages: [
				{
					id: "12",
					channel_id: CH,
					author: { id: "u1", bot: false },
					content: "second",
					mention_everyone: true,
				},
				{
					id: "11",
					channel_id: CH,
					author: { id: "u1", bot: false },
					content: "first",
					mention_everyone: true,
				},
			],
			// every create fails transiently
			createResponse: () => res(500, {}),
		};
		const { impl } = makeFetch(scn);
		const m = mgr(store, impl, { cursorStore: cursor });
		await m.start();
		const n = await m.pollOnce();
		// first (oldest=11) held → cursor not advanced past it
		expect(n).toBe(0);
		expect(cursor.load(CH)).toBe("10");
	});

	it("429 with Retry-After delays the next scheduled poll (no 3s hammering)", async () => {
		const cursor = new InMemoryInboundCursorStore();
		cursor.save(CH, "10");
		const scn: FetchScenario = {
			messages: [
				{
					id: "11",
					channel_id: CH,
					author: { id: "u1", bot: false },
					content: "x",
					mention_everyone: true,
				},
			],
			createResponse: () =>
				({
					ok: false,
					status: 429,
					headers: { get: () => "5" }, // Retry-After: 5s
					json: async () => ({}),
					text: async () => "",
				}) as unknown as Response,
		};
		const { impl } = makeFetch(scn);
		const timers: Array<{ fn: () => void; ms: number }> = [];
		const m = mgr(store, impl, {
			cursorStore: cursor,
			setTimer: (fn, ms) => {
				timers.push({ fn, ms });
				return { cancel: () => {} };
			},
		});
		await m.start(); // resume → first schedule at base interval
		expect(timers[0].ms).toBe(3000);
		timers[0].fn(); // run the poll → 429 holds + records a 5s next delay
		await new Promise((r) => setTimeout(r, 0));
		expect(timers[1].ms).toBe(5000);
		expect(cursor.load(CH)).toBe("10"); // cursor held
	});

	it("stop() waits for an in-flight poll to drain before returning", async () => {
		const cursor = new InMemoryInboundCursorStore();
		cursor.save(CH, "10");
		let releaseCreate!: () => void;
		const gate = new Promise<void>((r) => {
			releaseCreate = r;
		});
		let createCalled = false;
		const impl = vi.fn(async (url: string, init?: RequestInit) => {
			const method = (init?.method ?? "GET").toUpperCase();
			if (method === "GET" && /\/messages\?/.test(url)) {
				return res(200, [
					{
						id: "11",
						channel_id: CH,
						author: { id: "u1", bot: false },
						content: "x",
						mention_everyone: true,
					},
				]);
			}
			if (method === "POST" && /\/threads$/.test(url)) {
				createCalled = true;
				await gate; // block the create until released
				return res(201, { id: "11" });
			}
			if (method === "POST") return res(200, { id: "seed" });
			if (method === "PUT") return res(204, {});
			return res(200, {});
		}) as unknown as typeof fetch;
		const timers: Array<{ fn: () => void }> = [];
		const m = mgr(store, impl, {
			cursorStore: cursor,
			setTimer: (fn) => {
				timers.push({ fn });
				return { cancel: () => {} };
			},
		});
		await m.start();
		timers[0].fn(); // launch poll → blocks inside create on the gate
		await new Promise((r) => setTimeout(r, 0));
		expect(createCalled).toBe(true);
		let stopped = false;
		const stopP = m.stop().then(() => {
			stopped = true;
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(stopped).toBe(false); // stop() is draining the in-flight poll
		releaseCreate(); // let the create + store finish
		await stopP;
		expect(stopped).toBe(true);
		expect(store.getRoundtableTopicThread(CH, "11")?.thread_id).toBe("11");
	});

	it("keeps the in-memory cursor + warns (no throw) when cursor persistence fails", async () => {
		const throwingCursor = {
			load: () => "10",
			save: () => {
				throw new Error("disk full");
			},
		};
		const warn = vi.fn();
		const scn: FetchScenario = {
			messages: [
				{
					id: "11",
					channel_id: CH,
					author: { id: "u1", bot: false },
					content: "x",
					mention_everyone: true,
				},
			],
		};
		const { impl } = makeFetch(scn);
		const m = mgr(store, impl, {
			cursorStore: throwingCursor,
			logger: { warn },
		});
		await m.start();
		const n = await m.pollOnce(); // save throws but is caught
		expect(n).toBe(1); // advanced despite the persist failure
		expect(warn).toHaveBeenCalled();
		expect(store.getRoundtableTopicThread(CH, "11")?.thread_id).toBe("11");
	});
});
