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
	body?: string;
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
	/** FLY-576: override PUT thread-members/{userId} (default: 204 added). */
	putMemberResponse?: (userId: string) => Response;
	/** FLY-576: override PATCH /channels/{id} thread rename (default: 200 ok). */
	patchResponse?: (id: string) => Response;
}

function makeFetch(scn: FetchScenario) {
	const calls: CallLog[] = [];
	const messages = scn.messages ?? [];
	const impl = vi.fn(async (url: string, init?: RequestInit) => {
		const method = (init?.method ?? "GET").toUpperCase();
		calls.push({
			method,
			url,
			body: typeof init?.body === "string" ? init.body : undefined,
		});
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
			const userId = url.split("/thread-members/")[1] ?? "";
			return scn.putMemberResponse
				? scn.putMemberResponse(userId)
				: res(204, {});
		}
		// PATCH /channels/{id} (FLY-576 rename)
		const patchMatch = url.match(/\/channels\/([^/]+)$/);
		if (method === "PATCH" && patchMatch) {
			const id = patchMatch[1];
			return scn.patchResponse ? scn.patchResponse(id) : res(200, { id });
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

	it("FLY-802: opens the topic thread with auto_archive_duration=60 (1h → collapses out of the sidebar)", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl);
		const advance = await m.processMessage({
			id: "77",
			channelId: CH,
			authorId: "u1",
			authorBot: false,
			content: "deploy plan review — leads weigh in",
			mentions: [],
			mentionEveryone: false,
		});
		expect(advance).toBe(true);
		const createCall = calls.find(
			(c) => c.method === "POST" && /\/messages\/[^/]+\/threads$/.test(c.url),
		);
		expect(createCall).toBeDefined();
		const body = JSON.parse(createCall?.body ?? "{}");
		expect(body.auto_archive_duration).toBe(60);
		// Host bot created it with 60 up-front → no redundant archive PATCH follows.
		expect(patchCalls(calls)).toHaveLength(0);
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
		const seed = calls.find(
			(c) => c.method === "POST" && /\/channels\/42\/messages$/.test(c.url),
		);
		expect(JSON.parse(seed?.body ?? "{}").content).toMatch(/^🤖\[自动\] /);
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
			content: "real topic here",
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
			content: "real topic here",
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
			content: "real topic here",
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
			content: "real topic here",
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
			content: "real topic here",
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
			content: "real topic here",
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
					content: "real topic here",
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
						content: "real topic here",
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
					content: "real topic here",
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

// ─────────────────────────────────────────────────────────────────────────
// FLY-576 — founder membership + descriptive naming + reliable convergence
// ─────────────────────────────────────────────────────────────────────────
const putMemberIds = (calls: CallLog[]) =>
	calls
		.filter((c) => c.method === "PUT" && /\/thread-members\//.test(c.url))
		.map((c) => c.url.split("/thread-members/")[1]);
const patchCalls = (calls: CallLog[]) =>
	calls.filter((c) => c.method === "PATCH" && /\/channels\/[^/]+$/.test(c.url));
const createBody = (calls: CallLog[]) => {
	const c = calls.find(
		(x) =>
			x.method === "POST" &&
			/\/messages\/[^/]+\/threads$/.test(x.url) &&
			x.body,
	);
	return c?.body ? (JSON.parse(c.body) as { name?: string }) : undefined;
};
const msg = (
	over: Partial<Parameters<RoundtableThreadManager["processMessage"]>[0]> = {},
) => ({
	id: "42",
	channelId: CH,
	authorId: "u1",
	authorBot: false,
	content: "hello topic",
	mentions: [] as string[],
	mentionEveryone: false,
	...over,
});

describe("RoundtableThreadManager — FLY-576 founder + naming + convergence", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("created: ALWAYS adds the founder (union with mentions), filtering the bot", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl, {
			founderUserId: "founder-x",
			memberUserIds: [],
		});
		const advance = await m.processMessage(
			msg({ content: "<@lead-a> please look", mentions: ["lead-a", BOT_USER] }),
		);
		expect(advance).toBe(true);
		expect(new Set(putMemberIds(calls))).toEqual(
			new Set(["founder-x", "lead-a"]),
		);
		expect(putMemberIds(calls)).not.toContain(BOT_USER);
		expect(store.getRoundtableTopicThread(CH, "42")?.thread_id).toBe("42");
	});

	it("created: descriptive name strips Discord markup from the topic content", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl);
		await m.processMessage(
			msg({
				content: "<@123> <@!456> <@&7> <#8> <:wave:9> ship the membership fix",
			}),
		);
		expect(createBody(calls)?.name).toBe("ship the membership fix");
	});

	it("FLY-314 fix: mentions-only / empty content is NOISE — opens NO thread (this WAS the row-of-'Roundtable topic' bug)", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl);
		const advance = await m.processMessage(
			msg({ content: "<@123> <@456>", mentions: ["123"] }),
		);
		expect(advance).toBe(true); // handled / no-op
		expect(countCreates(calls)).toBe(0); // no placeholder-named thread
	});

	it("recovery: a placeholder-named plugin thread (default 3-day archive) gets ONE PATCH renaming it AND setting the 1h archive (FLY-802)", async () => {
		const { impl, calls } = makeFetch({
			createResponse: () => res(400, { code: 160004 }),
			getChannelResponse: () =>
				res(200, {
					type: 11,
					parent_id: CH,
					name: "Roundtable topic",
					thread_metadata: { auto_archive_duration: 4320 },
				}),
		});
		const m = mgr(store, impl, { founderUserId: "founder-x" });
		const advance = await m.processMessage(
			msg({ content: "fix the sidebar surfacing", mentions: [] }),
		);
		expect(advance).toBe(true);
		// ONE PATCH converging BOTH the descriptive name and the 1h archive.
		const patches = patchCalls(calls);
		expect(patches).toHaveLength(1);
		const patchBody = JSON.parse(patches[0].body ?? "{}");
		expect(patchBody.name).toBe("fix the sidebar surfacing");
		expect(patchBody.auto_archive_duration).toBe(60);
		// founder + config members still added
		expect(putMemberIds(calls)).toContain("founder-x");
		expect(store.getRoundtableTopicThread(CH, "42")?.thread_id).toBe("42");
	});

	it("FLY-802 recovery: a plugin thread with a fine name but the default 3-day archive gets a PATCH setting ONLY the 1h archive", async () => {
		const { impl, calls } = makeFetch({
			createResponse: () => res(400, { code: 160004 }),
			getChannelResponse: () =>
				res(200, {
					type: 11,
					parent_id: CH,
					name: "already a good topic name",
					thread_metadata: { auto_archive_duration: 4320 },
				}),
		});
		const m = mgr(store, impl);
		const advance = await m.processMessage(
			msg({ content: "already a good topic name" }),
		);
		expect(advance).toBe(true);
		const patches = patchCalls(calls);
		expect(patches).toHaveLength(1);
		const patchBody = JSON.parse(patches[0].body ?? "{}");
		expect(patchBody.auto_archive_duration).toBe(60);
		expect(patchBody.name).toBeUndefined(); // name already fine → not touched
		expect(store.getRoundtableTopicThread(CH, "42")?.thread_id).toBe("42");
	});

	it("recovery: a fully-converged thread (good name AND already 1h archive) is NOT PATCHed", async () => {
		const { impl, calls } = makeFetch({
			createResponse: () => res(400, { code: 160004 }),
			getChannelResponse: () =>
				res(200, {
					type: 11,
					parent_id: CH,
					name: "an existing good name",
					thread_metadata: { auto_archive_duration: 60 },
				}),
		});
		const m = mgr(store, impl);
		await m.processMessage(msg());
		expect(patchCalls(calls)).toHaveLength(0);
		expect(store.getRoundtableTopicThread(CH, "42")?.thread_id).toBe("42");
	});

	it("recovery: a transient GET-confirm failure HOLDS the cursor (no advance, no persist)", async () => {
		const { impl } = makeFetch({
			createResponse: () => res(400, { code: 160004 }),
			getChannelResponse: () => res(503, {}),
		});
		const m = mgr(store, impl);
		const advance = await m.processMessage(msg());
		expect(advance).toBe(false);
		expect(store.getRoundtableTopicThread(CH, "42")).toBeUndefined();
	});

	it("a transient member-add failure HOLDS the cursor (no persist) so the next poll retries", async () => {
		const { impl } = makeFetch({ putMemberResponse: () => res(503, {}) });
		const m = mgr(store, impl, { founderUserId: "founder-x" });
		const advance = await m.processMessage(msg());
		expect(advance).toBe(false);
		expect(store.getRoundtableTopicThread(CH, "42")).toBeUndefined();
	});

	it("a permanent member-add failure (403) warns and still commits (advance, no wedge)", async () => {
		const warn = vi.fn();
		const { impl } = makeFetch({ putMemberResponse: () => res(403, {}) });
		const m = mgr(store, impl, {
			founderUserId: "founder-x",
			logger: { warn },
		});
		const advance = await m.processMessage(msg());
		expect(advance).toBe(true);
		expect(store.getRoundtableTopicThread(CH, "42")?.thread_id).toBe("42");
	});

	it("a transient rename failure HOLDS the cursor (no persist) so the name converges", async () => {
		const { impl } = makeFetch({
			createResponse: () => res(400, { code: 160004 }),
			getChannelResponse: () =>
				res(200, { type: 11, parent_id: CH, name: "Roundtable topic" }),
			patchResponse: () => res(503, {}),
		});
		const m = mgr(store, impl);
		const advance = await m.processMessage(msg({ content: "a real topic" }));
		expect(advance).toBe(false);
		expect(store.getRoundtableTopicThread(CH, "42")).toBeUndefined();
	});

	it("a permanent rename failure (403 — no MANAGE_THREADS) warns but membership still commits", async () => {
		const warn = vi.fn();
		const { impl, calls } = makeFetch({
			createResponse: () => res(400, { code: 160004 }),
			getChannelResponse: () =>
				res(200, { type: 11, parent_id: CH, name: "Roundtable topic" }),
			patchResponse: () => res(403, {}),
		});
		const m = mgr(store, impl, {
			founderUserId: "founder-x",
			logger: { warn },
		});
		const advance = await m.processMessage(msg({ content: "a real topic" }));
		expect(advance).toBe(true); // membership converged even though rename failed
		expect(putMemberIds(calls)).toContain("founder-x");
		expect(store.getRoundtableTopicThread(CH, "42")?.thread_id).toBe("42");
	});

	it("no founder configured → adds only configured members + mentions (byte-compat, no throw)", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl, {
			founderUserId: undefined,
			memberUserIds: ["m1"],
		});
		const advance = await m.processMessage(msg({ mentions: ["lead-a"] }));
		expect(advance).toBe(true);
		expect(new Set(putMemberIds(calls))).toEqual(new Set(["m1", "lead-a"]));
	});

	it("idempotent re-run: a row already committed (dedup) skips re-work without a second create", async () => {
		store.upsertRoundtableTopicThread({
			threadId: "42",
			channelId: CH,
			sourceMessageId: "42",
		});
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl, { founderUserId: "founder-x" });
		const advance = await m.processMessage(msg());
		expect(advance).toBe(true);
		expect(countCreates(calls)).toBe(0);
		expect(putMemberIds(calls)).toHaveLength(0); // already committed — no rework
	});

	it("two-pass convergence: a transient member-add holds (no row), then the 160004 recovery re-adds + commits", async () => {
		// Pass 1: host bot creates the thread (201) but the member PUT fails transiently
		// → hold, NO row. Pass 2: the same message re-processes, create now returns
		// 160004 (the pass-1 thread exists), GET confirms, the member PUT succeeds → commit.
		let pass = 0;
		const { impl, calls } = makeFetch({
			createResponse: () =>
				pass === 0 ? res(201, { id: "42" }) : res(400, { code: 160004 }),
			// pass-1 create named it from the content AND set the 1h archive; the GET
			// reflects both (no rename, no archive PATCH needed in the recovery pass).
			getChannelResponse: () =>
				res(200, {
					type: 11,
					parent_id: CH,
					name: "hello topic",
					thread_metadata: { auto_archive_duration: 60 },
				}),
			putMemberResponse: () => (pass === 0 ? res(503, {}) : res(204, {})),
		});
		const m = mgr(store, impl, {
			founderUserId: "founder-x",
			memberUserIds: [],
		});

		const a1 = await m.processMessage(msg({ content: "hello topic" }));
		expect(a1).toBe(false); // held — transient member add
		expect(store.getRoundtableTopicThread(CH, "42")).toBeUndefined();

		pass = 1;
		const a2 = await m.processMessage(msg({ content: "hello topic" }));
		expect(a2).toBe(true); // recovered + committed
		expect(store.getRoundtableTopicThread(CH, "42")?.thread_id).toBe("42");
		expect(putMemberIds(calls)).toContain("founder-x");
		// the descriptive name already matched → no rename needed in the recovery pass
		expect(patchCalls(calls)).toHaveLength(0);
	});
});

describe("RoundtableThreadManager — FLY-314 fix: follow-up + noise pre-gates (mode-independent)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("follow-up gate: a Discord reply (referencedMessageId set) never opens a thread — even under any_top_level", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl); // any_top_level = trigger always true
		const advance = await m.processMessage(
			msg({ id: "77", content: "yeah agreed", referencedMessageId: "42" }),
		);
		expect(advance).toBe(true); // handled / no-op → cursor advances
		expect(countCreates(calls)).toBe(0);
		expect(store.getRoundtableTopicThread(CH, "77")).toBeUndefined();
	});

	it("noise gate: pure-emoji / short acks never open a thread — even under any_top_level", async () => {
		for (const content of ["👍👍", "🎉", "ok", "<:tada:1>", "   "]) {
			const { impl, calls } = makeFetch({});
			const m = mgr(store, impl);
			const advance = await m.processMessage(msg({ id: "80", content }));
			expect(advance).toBe(true);
			expect(countCreates(calls)).toBe(0);
		}
	});

	it("a genuine non-reply topic still opens exactly one thread with a descriptive name (regression)", async () => {
		const { impl, calls } = makeFetch({});
		const m = mgr(store, impl);
		const advance = await m.processMessage(
			msg({ id: "90", content: "<@1> Flywheel restarted — check runners" }),
		);
		expect(advance).toBe(true);
		expect(countCreates(calls)).toBe(1);
		const createBody = JSON.parse(
			calls.find((c) => /\/messages\/90\/threads$/.test(c.url))?.body ?? "{}",
		);
		expect(createBody.name).toBe("Flywheel restarted — check runners");
	});

	it("pollOnce maps Discord message_reference → follow-up (no thread for a raw reply message)", async () => {
		const cursor = new InMemoryInboundCursorStore();
		cursor.save(CH, "150"); // resume from an older id so 200 is delivered (not baselined away)
		const { impl, calls } = makeFetch({
			messages: [
				{
					id: "200",
					channel_id: CH,
					content: "sounds good",
					author: { id: "u2", bot: false },
					message_reference: { message_id: "150" },
				},
			],
		});
		const m = mgr(store, impl, { cursorStore: cursor });
		await m.start(); // resumes at 150 (ready, no baseline fetch)
		const advanced = await m.pollOnce(); // sees 200, a reply → follow-up gate
		await m.stop();
		expect(advanced).toBe(1); // handled + advanced, but…
		expect(countCreates(calls)).toBe(0); // …no thread created for a follow-up
		expect(store.getRoundtableTopicThread(CH, "200")).toBeUndefined();
	});
});
