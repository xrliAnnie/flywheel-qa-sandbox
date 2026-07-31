import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateDatabase } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type V2DisplayRecord,
	V2DisplayRefresher,
	type V2DisplayRefresherOptions,
	type V2DisplayStore,
} from "../v2-display-refresher.js";
import { openV2DisplayReader } from "../v2-display-state-reader.js";
import {
	type V2IssueDisplaySnapshot,
	v2RunnerTmuxSessionName,
} from "../v2-issue-display.js";

const ISSUE = "FLY-1549";
const THREAD = "thread-1";

function makeStore(threadId = THREAD): V2DisplayStore & {
	records: Map<string, V2DisplayRecord>;
	threads: Map<string, string>;
} {
	const records = new Map<string, V2DisplayRecord>();
	const threads = new Map<string, string>([[ISSUE, threadId]]);
	return {
		records,
		threads,
		getThreadId: (issueId) => threads.get(issueId),
		getRecord: (issueId) => records.get(issueId),
		setRecord: (issueId, record) => records.set(issueId, record),
		listIssues: () => [...threads.keys()],
	};
}

interface FakeDiscord {
	fetchImpl: typeof fetch;
	calls: { method: string; url: string; body?: unknown }[];
	channelName: string;
	archived: boolean;
	rename429: { remaining: number; retryAfterMs?: number };
	edit404: boolean;
	edit500: boolean;
	pinOutcome: number; // HTTP status for the pin PUT
	postFail?: boolean;
	/** GET /messages/:id — the sweep's remote header verification. */
	messageGet: { status: number; pinned: boolean };
	/** When set, the message GET awaits this before responding (race tests). */
	messageGetGate?: Promise<void>;
}

function makeDiscord(over: Partial<FakeDiscord> = {}): FakeDiscord {
	const state: FakeDiscord = {
		calls: [],
		channelName: `[${ISSUE}]`,
		archived: false,
		rename429: { remaining: 0 },
		edit404: false,
		edit500: false,
		pinOutcome: 204,
		messageGet: { status: 200, pinned: true },
		fetchImpl: undefined as unknown as typeof fetch,
		...over,
	};
	state.fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		state.calls.push({ method, url, body });
		const respond = (
			status: number,
			payload?: unknown,
			headers?: Record<string, string>,
		) =>
			new Response(payload === undefined ? null : JSON.stringify(payload), {
				status,
				headers,
			});
		if (method === "GET" && /\/channels\/[^/]+$/.test(url)) {
			return respond(200, {
				name: state.channelName,
				thread_metadata: { archived: state.archived },
			});
		}
		if (method === "PATCH" && /\/channels\/[^/]+$/.test(url)) {
			if (state.rename429.remaining > 0) {
				state.rename429.remaining -= 1;
				return respond(
					429,
					{ retry_after: (state.rename429.retryAfterMs ?? 1000) / 1000 },
					{
						"retry-after": String(
							(state.rename429.retryAfterMs ?? 1000) / 1000,
						),
					},
				);
			}
			state.channelName = (body as { name: string }).name;
			return respond(200, {});
		}
		if (method === "POST" && /\/messages$/.test(url)) {
			if (state.postFail) return respond(500, {});
			return respond(200, { id: "msg-1" });
		}
		if (method === "GET" && /\/messages\/[^/]+$/.test(url)) {
			if (state.messageGetGate) await state.messageGetGate;
			if (state.messageGet.status !== 200) {
				return respond(state.messageGet.status, {});
			}
			return respond(200, { pinned: state.messageGet.pinned });
		}
		if (method === "PATCH" && /\/messages\/[^/]+$/.test(url)) {
			if (state.edit404) return respond(404, {});
			if (state.edit500) return respond(500, {});
			return respond(200, {});
		}
		if (method === "PUT" && /\/messages\/pins\//.test(url)) {
			return respond(state.pinOutcome);
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	}) as typeof fetch;
	return state;
}

function snapshotOf(
	over: Partial<V2IssueDisplaySnapshot>,
): V2IssueDisplaySnapshot {
	return { issueId: ISSUE, tasks: [], ...over };
}

const designRunning = snapshotOf({
	tasks: [
		{
			taskId: "t:design",
			kind: "design",
			state: "running",
			attemptCount: 1,
			attempt: {
				attemptId: "aaaabbbbcccc",
				desiredState: "started",
				vendor: "claude",
				sessionRef: "v2dag:aaaabbbb:1:act1",
			},
		},
		{ taskId: "t:impl", kind: "implement", state: "draft", attemptCount: 0 },
		{ taskId: "t:qa", kind: "qa", state: "draft", attemptCount: 0 },
	],
});

const SESSION_NAME = v2RunnerTmuxSessionName("v2dag:aaaabbbb:1:act1");
const GOOD_WINDOW = `v2-${ISSUE}-design-abcd1234`;

function makeRefresher(
	over: Partial<V2DisplayRefresherOptions> & {
		snapshots?: Record<string, V2IssueDisplaySnapshot | null>;
	} = {},
) {
	const discord = makeDiscord();
	const store = makeStore();
	const sleeps: number[] = [];
	const snapshots: Record<string, V2IssueDisplaySnapshot | null> =
		over.snapshots ?? {
			[ISSUE]: designRunning,
		};
	const warn = vi.fn();
	const refresher = new V2DisplayRefresher({
		reader: { read: (id) => snapshots[id] ?? null, close: () => {} },
		store,
		botToken: "bot-token",
		fetchImpl: discord.fetchImpl,
		probeWindowName: async () => GOOD_WINDOW,
		logger: { log: vi.fn(), warn, error: vi.fn() },
		sleepImpl: async (ms) => {
			sleeps.push(ms);
		},
		...over,
	});
	return { refresher, discord, store, sleeps, snapshots, warn };
}

describe("V2DisplayRefresher — happy path", () => {
	it("stamps the title, posts+pins the header, persists the fingerprint", async () => {
		const { refresher, discord, store } = makeRefresher();
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(true);
		expect(discord.channelName).toBe(`🎨设计 [${ISSUE}]`);
		const post = discord.calls.find(
			(call) => call.method === "POST" && call.url.endsWith("/messages"),
		);
		expect(post).toBeDefined();
		const content = (post?.body as { content: string }).content;
		expect(content).toContain(
			"**[设计]** ▶ 进行中 · attempt `aaaabbbb` · claude",
		);
		expect(content).toContain(`env -u TMUX tmux attach -t '=${SESSION_NAME}'`);
		expect(content).toContain("**[实现]** ◾ 未开始");
		expect(discord.calls.some((call) => call.method === "PUT")).toBe(true);
		const record = store.records.get(ISSUE);
		expect(record?.fp).toBeDefined();
		expect(record?.headerMessageId).toBe("msg-1");
	});

	it("second refresh with unchanged state is a zero-Discord no-op (fingerprint fast path)", async () => {
		const { refresher, discord } = makeRefresher();
		await refresher.refresh(ISSUE);
		const callsAfterFirst = discord.calls.length;
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(true);
		expect(discord.calls.length).toBe(callsAfterFirst);
	});

	it("a state change edits the pinned header in place (no repost) and re-stamps the title", async () => {
		const { refresher, discord, store, snapshots } = makeRefresher();
		await refresher.refresh(ISSUE);
		snapshots[ISSUE] = snapshotOf({
			tasks: [
				{
					taskId: "t:design",
					kind: "design",
					state: "done",
					attemptCount: 1,
					attempt: {
						attemptId: "aaaabbbbcccc",
						desiredState: "terminal",
						terminalReason: "completed",
						vendor: "claude",
					},
				},
				{
					taskId: "t:impl",
					kind: "implement",
					state: "running",
					attemptCount: 1,
					attempt: {
						attemptId: "ddddeeeeffff",
						desiredState: "started",
						vendor: "codex",
						sessionRef: "v2dag:ddddeeee:1:act2",
					},
				},
				{ taskId: "t:qa", kind: "qa", state: "draft", attemptCount: 0 },
			],
		});
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(true);
		expect(discord.channelName).toBe(`🔨实现 [${ISSUE}]`);
		const edits = discord.calls.filter(
			(call) => call.method === "PATCH" && /\/messages\/msg-1$/.test(call.url),
		);
		expect(edits).toHaveLength(1);
		expect((edits[0]?.body as { content: string }).content).toContain(
			"**[设计]** ✅ 完成",
		);
		const posts = discord.calls.filter(
			(call) => call.method === "POST" && call.url.endsWith("/messages"),
		);
		expect(posts).toHaveLength(1); // still only the original post
		expect(store.records.get(ISSUE)?.headerMessageId).toBe("msg-1");
	});
});

describe("V2DisplayRefresher — 429 policy", () => {
	it("retries a short 429 and lands the rename", async () => {
		const { refresher, discord, sleeps, store } = makeRefresher();
		discord.rename429 = { remaining: 2, retryAfterMs: 1500 };
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(true);
		expect(discord.channelName).toBe(`🎨设计 [${ISSUE}]`);
		expect(sleeps).toEqual([1500, 1500]);
		expect(store.records.get(ISSUE)?.fp).toBeDefined();
	});

	it("a persistent 429 defers — fingerprint withheld for the sweep", async () => {
		const { refresher, discord, store } = makeRefresher();
		discord.rename429 = { remaining: 99, retryAfterMs: 1000 };
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(false);
		expect(store.records.get(ISSUE)?.fp).toBeUndefined();
	});

	it("a long Retry-After defers immediately without sleeping the window away", async () => {
		const { refresher, discord, sleeps, store } = makeRefresher();
		discord.rename429 = { remaining: 99, retryAfterMs: 300_000 };
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(false);
		expect(sleeps).toEqual([]);
		expect(store.records.get(ISSUE)?.fp).toBeUndefined();
	});

	it("a 429 deferral persists the Retry-After horizon and no title request fires before it (Codex design R1 #3)", async () => {
		let now = 1_000_000;
		const { refresher, discord, store } = makeRefresher({ now: () => now });
		discord.rename429 = { remaining: 99, retryAfterMs: 300_000 };
		await refresher.refresh(ISSUE);
		expect(store.records.get(ISSUE)?.titleRetryNotBeforeMs).toBe(
			1_000_000 + 300_000,
		);
		// Before the horizon: a re-refresh makes ZERO title requests.
		const titleCallsBefore = discord.calls.filter((call) =>
			/\/channels\/[^/]+$/.test(call.url),
		).length;
		await refresher.refresh(ISSUE);
		const titleCallsAfter = discord.calls.filter((call) =>
			/\/channels\/[^/]+$/.test(call.url),
		).length;
		expect(titleCallsAfter).toBe(titleCallsBefore);
		// After the horizon the write goes through and the horizon clears.
		now += 300_001;
		discord.rename429 = { remaining: 0 };
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(true);
		expect(store.records.get(ISSUE)?.titleRetryNotBeforeMs).toBeUndefined();
		expect(discord.channelName).toBe(`🎨设计 [${ISSUE}]`);
	});
});

describe("V2DisplayRefresher — header resilience", () => {
	it("repost + pin when the header message vanished (edit 404)", async () => {
		const { refresher, discord, store, snapshots } = makeRefresher();
		await refresher.refresh(ISSUE);
		discord.edit404 = true;
		snapshots[ISSUE] = snapshotOf({
			tasks: [
				{ taskId: "t:design", kind: "design", state: "done", attemptCount: 1 },
			],
		});
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(true);
		const posts = discord.calls.filter(
			(call) => call.method === "POST" && call.url.endsWith("/messages"),
		);
		expect(posts).toHaveLength(2);
		expect(store.records.get(ISSUE)?.headerMessageId).toBe("msg-1");
	});

	it("pin forbidden → header id persisted (no duplicate next round) but fingerprint withheld", async () => {
		const { refresher, discord, store } = makeRefresher();
		discord.pinOutcome = 403;
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(false);
		expect(store.records.get(ISSUE)?.headerMessageId).toBe("msg-1");
		expect(store.records.get(ISSUE)?.headerPinned).toBe(false);
		expect(store.records.get(ISSUE)?.fp).toBeUndefined();
		// Next round must EDIT, not repost.
		discord.pinOutcome = 204;
		await refresher.refresh(ISSUE);
		const posts = discord.calls.filter(
			(call) => call.method === "POST" && call.url.endsWith("/messages"),
		);
		expect(posts).toHaveLength(1);
	});

	it("pin 404 (message deleted) clears the record and the next round REPOSTS — never PUTs a dead id forever (Codex design R3 #1)", async () => {
		const { refresher, discord, store } = makeRefresher();
		discord.pinOutcome = 404;
		expect(await refresher.refresh(ISSUE)).toBe(false);
		expect(store.records.get(ISSUE)?.headerMessageId).toBeUndefined();
		discord.pinOutcome = 204;
		expect(await refresher.refresh(ISSUE)).toBe(true);
		const posts = discord.calls.filter(
			(call) => call.method === "POST" && call.url.endsWith("/messages"),
		);
		expect(posts).toHaveLength(2);
		expect(store.records.get(ISSUE)?.headerPinned).toBe(true);
	});

	it("a stale record with fp but no pin confirmation never takes the fast path (Codex design R3 #2)", async () => {
		const { refresher, discord, store } = makeRefresher();
		// Land once, then simulate an R1-era record: fp present, header posted,
		// but the pin confirmation missing.
		await refresher.refresh(ISSUE);
		const landedRecord = store.records.get(ISSUE);
		store.records.set(ISSUE, {
			...landedRecord,
			headerPinned: undefined,
		} as V2DisplayRecord);
		const putsBefore = discord.calls.filter(
			(call) => call.method === "PUT",
		).length;
		expect(await refresher.refresh(ISSUE)).toBe(true);
		const putsAfter = discord.calls.filter(
			(call) => call.method === "PUT",
		).length;
		expect(putsAfter).toBe(putsBefore + 1);
		expect(store.records.get(ISSUE)?.headerPinned).toBe(true);
	});

	it("an unpinned header keeps retrying the pin — same content is NOT converged until pinned (Codex design R2 #1)", async () => {
		const { refresher, discord, store } = makeRefresher();
		discord.pinOutcome = 403;
		expect(await refresher.refresh(ISSUE)).toBe(false);
		const putsAfterFirst = discord.calls.filter(
			(call) => call.method === "PUT",
		).length;
		expect(putsAfterFirst).toBe(1);
		// Content unchanged; permission restored → the pin MUST be retried and
		// only then may the fingerprint land.
		discord.pinOutcome = 204;
		expect(await refresher.refresh(ISSUE)).toBe(true);
		const puts = discord.calls.filter((call) => call.method === "PUT").length;
		expect(puts).toBe(2);
		expect(store.records.get(ISSUE)?.headerPinned).toBe(true);
		expect(store.records.get(ISSUE)?.fp).toBeDefined();
	});
});

describe("V2DisplayRefresher — stale fingerprint on failed pass (Codex code R1 #1)", () => {
	it("a half-written pass drops the old fingerprint — a state flip back cannot fast-path over mixed surfaces", async () => {
		const { refresher, discord, store, snapshots } = makeRefresher();
		// Converge at state A (design running → 🎨设计).
		expect(await refresher.refresh(ISSUE)).toBe(true);
		const fpA = store.records.get(ISSUE)?.fp;
		expect(fpA).toBeDefined();
		// State B: title write succeeds (🔨实现) but the header edit fails.
		snapshots[ISSUE] = snapshotOf({
			tasks: [
				{
					taskId: "t:design",
					kind: "design",
					state: "done",
					attemptCount: 1,
				},
				{
					taskId: "t:impl",
					kind: "implement",
					state: "running",
					attemptCount: 1,
					attempt: { attemptId: "ddddeeeeffff", desiredState: "started" },
				},
			],
		});
		discord.edit500 = true;
		expect(await refresher.refresh(ISSUE)).toBe(false);
		expect(discord.channelName).toBe(`🔨实现 [${ISSUE}]`); // half-written
		expect(store.records.get(ISSUE)?.fp).toBeUndefined(); // old fp dropped
		// State flips BACK to A; Discord recovers. The refresh must do a full
		// pass and restore the title — not fast-path over the mixed state.
		snapshots[ISSUE] = designRunning;
		discord.edit500 = false;
		expect(await refresher.refresh(ISSUE)).toBe(true);
		expect(discord.channelName).toBe(`🎨设计 [${ISSUE}]`);
		expect(store.records.get(ISSUE)?.fp).toBe(fpA);
	});
});

describe("V2DisplayRefresher — attach cross-wire guard (PRD Step 3)", () => {
	it("a foreign window name withholds the attach command, degrades, warns — and still lands", async () => {
		const { refresher, discord, store, warn } = makeRefresher({
			probeWindowName: async () => "v2-FLY-9999-design-deadbeef",
		});
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(true);
		const post = discord.calls.find(
			(call) => call.method === "POST" && call.url.endsWith("/messages"),
		);
		const content = (post?.body as { content: string }).content;
		expect(content).toContain("_(终端待解析)_");
		expect(content).not.toContain("tmux attach");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("attach cross-wire"),
		);
		expect(store.records.get(ISSUE)?.fp).toBeDefined();
	});

	it("an active runner with no tmux session defers (sweep retries until it appears)", async () => {
		const { refresher, discord, store } = makeRefresher({
			probeWindowName: async () => null,
		});
		const landed = await refresher.refresh(ISSUE);
		expect(landed).toBe(false);
		const post = discord.calls.find(
			(call) => call.method === "POST" && call.url.endsWith("/messages"),
		);
		expect((post?.body as { content: string }).content).toContain(
			"_(终端待解析)_",
		);
		expect(store.records.get(ISSUE)?.fp).toBeUndefined();
	});
});

describe("V2DisplayRefresher — coalesce", () => {
	it("concurrent refreshes collapse to at most one extra pass", async () => {
		let reads = 0;
		const { refresher } = makeRefresher({
			reader: {
				read: () => {
					reads += 1;
					return designRunning;
				},
				close: () => {},
			},
		});
		await Promise.all([
			refresher.refresh(ISSUE),
			refresher.refresh(ISSUE),
			refresher.refresh(ISSUE),
			refresher.refresh(ISSUE),
		]);
		expect(reads).toBeLessThanOrEqual(2);
	});
});

describe("V2DisplayRefresher — sweep", () => {
	it("re-enqueues on fingerprint drift the events never delivered", async () => {
		let now = 1_000_000;
		const { refresher, discord, snapshots } = makeRefresher({
			now: () => now,
			sweepIntervalMs: 60_000,
		});
		await refresher.refresh(ISSUE);
		const callsAfterFirst = discord.calls.length;
		// Drift invisible to the messenger: state changed with no event.
		snapshots[ISSUE] = snapshotOf({
			tasks: [
				{ taskId: "t:design", kind: "design", state: "done", attemptCount: 1 },
			],
		});
		now += 61_000;
		await refresher.maybeSweep();
		await refresher.refresh(ISSUE); // join the enqueued pass
		expect(discord.calls.length).toBeGreaterThan(callsAfterFirst);
		expect(discord.channelName).toBe(`🎨设计 [${ISSUE}]`);
	});

	it("terminal + archived + current issues are skipped without a kernel read", async () => {
		let reads = 0;
		let now = 1_000_000;
		const store = makeStore();
		store.records.set(ISSUE, {
			fp: "fp",
			terminal: true,
			archivedAt: "2026-07-30T00:00:00.000Z",
		});
		const { refresher } = makeRefresher({
			store,
			now: () => now,
			sweepIntervalMs: 60_000,
			reader: {
				read: () => {
					reads += 1;
					return designRunning;
				},
				close: () => {},
			},
		});
		now += 61_000;
		await refresher.maybeSweep();
		expect(reads).toBe(0);
	});

	it("frozen (terminal+archived+current) entries do not consume batch slots (Codex design R1 #4)", async () => {
		let now = 1_000_000;
		const reads: string[] = [];
		const records = new Map<string, V2DisplayRecord>();
		const threads = new Map<string, string>();
		// 60 frozen issues ahead of 1 live one, batch limit 5: the live issue
		// must still be examined in ROUND ONE.
		for (let index = 0; index < 60; index += 1) {
			const id = `FLY-${1000 + index}`;
			threads.set(id, `thread-${index}`);
			records.set(id, { fp: "fp", terminal: true, archivedAt: "x" });
		}
		threads.set(ISSUE, THREAD);
		const store: V2DisplayStore = {
			getThreadId: (issueId) => threads.get(issueId),
			getRecord: (issueId) => records.get(issueId),
			setRecord: (issueId, record) => records.set(issueId, record),
			listIssues: () => [...threads.keys()],
		};
		const { refresher } = makeRefresher({
			store,
			now: () => now,
			sweepIntervalMs: 60_000,
			sweepBatchLimit: 5,
			reader: {
				read: (id) => {
					reads.push(id);
					return id === ISSUE ? designRunning : null;
				},
				close: () => {},
			},
		});
		now += 61_000;
		await refresher.maybeSweep();
		expect(reads).toContain(ISSUE);
	});

	it("a never-resolving tmux probe cannot wedge a refresh (Codex design R1 #7)", async () => {
		const { refresher, store } = makeRefresher({
			probeWindowName: () => new Promise<string | null>(() => {}),
			probeTimeoutMs: 20,
		});
		const landed = await refresher.refresh(ISSUE);
		// Timeout reads as "session absent" → degraded row, deferred, no fp.
		expect(landed).toBe(false);
		expect(store.records.get(ISSUE)?.fp).toBeUndefined();
	});

	it("many wedged probes cost ONE whole-snapshot budget, not probes × timeout (Codex design R3 #3)", async () => {
		const manyActive = snapshotOf({
			tasks: Array.from({ length: 40 }, (_, index) => ({
				taskId: `t:${index}`,
				kind: "generic",
				state: "running",
				attemptCount: 1,
				attempt: {
					attemptId: `attempt-${index}`,
					desiredState: "started",
					sessionRef: `v2dag:ref-${index}:1:act`,
				},
			})),
		});
		const { refresher } = makeRefresher({
			snapshots: { [ISSUE]: manyActive },
			probeWindowName: () => new Promise<string | null>(() => {}),
			probeTimeoutMs: 5_000,
			probeSnapshotBudgetMs: 100,
		});
		const startedAt = Date.now();
		const landed = await refresher.refresh(ISSUE);
		const elapsed = Date.now() - startedAt;
		expect(landed).toBe(false);
		// 40 wedged probes × 5s per-probe timeout would be 200s serial; the
		// global budget keeps the whole pass near 100ms (generous CI margin).
		expect(elapsed).toBeLessThan(3_000);
	});

	it("a header DELETED after convergence is detected by the sweep and reposted (Codex design R4 #1)", async () => {
		let now = 1_000_000;
		const { refresher, discord, store } = makeRefresher({
			now: () => now,
			sweepIntervalMs: 60_000,
		});
		expect(await refresher.refresh(ISSUE)).toBe(true);
		expect(store.records.get(ISSUE)?.headerPinned).toBe(true);
		// External deletion: fast path alone would never notice (fp current).
		discord.messageGet = { status: 404, pinned: false };
		now += 61_000;
		await refresher.maybeSweep();
		expect(store.records.get(ISSUE)?.headerMessageId).toBeUndefined();
		expect(store.records.get(ISSUE)?.fp).toBeUndefined();
		// The enqueued refresh reposts and re-pins.
		discord.messageGet = { status: 200, pinned: true };
		expect(await refresher.refresh(ISSUE)).toBe(true);
		const posts = discord.calls.filter(
			(call) => call.method === "POST" && call.url.endsWith("/messages"),
		);
		expect(posts).toHaveLength(2);
		expect(store.records.get(ISSUE)?.headerPinned).toBe(true);
	});

	it("a header UNPINNED after convergence is re-pinned by the sweep (Codex design R4 #1)", async () => {
		let now = 1_000_000;
		const { refresher, discord, store } = makeRefresher({
			now: () => now,
			sweepIntervalMs: 60_000,
		});
		expect(await refresher.refresh(ISSUE)).toBe(true);
		const putsAfterConverge = discord.calls.filter(
			(call) => call.method === "PUT",
		).length;
		discord.messageGet = { status: 200, pinned: false };
		now += 61_000;
		await refresher.maybeSweep();
		expect(store.records.get(ISSUE)?.headerPinned).toBe(false);
		discord.messageGet = { status: 200, pinned: true };
		expect(await refresher.refresh(ISSUE)).toBe(true);
		const puts = discord.calls.filter((call) => call.method === "PUT").length;
		expect(puts).toBe(putsAfterConverge + 1);
		expect(store.records.get(ISSUE)?.headerPinned).toBe(true);
		// No duplicate post — the original message was only re-pinned.
		const posts = discord.calls.filter(
			(call) => call.method === "POST" && call.url.endsWith("/messages"),
		);
		expect(posts).toHaveLength(1);
	});

	it("unpin + failed re-pin cannot wedge: fp cleared on unpin keeps the issue a sweep candidate (Codex design R5 #1)", async () => {
		let now = 1_000_000;
		const { refresher, discord, store } = makeRefresher({
			now: () => now,
			sweepIntervalMs: 60_000,
		});
		expect(await refresher.refresh(ISSUE)).toBe(true);
		discord.messageGet = { status: 200, pinned: false };
		now += 61_000;
		await refresher.maybeSweep();
		expect(store.records.get(ISSUE)?.fp).toBeUndefined();
		// The enqueued re-pin FAILS (403) — the fp must stay absent…
		discord.pinOutcome = 403;
		expect(await refresher.refresh(ISSUE)).toBe(false);
		expect(store.records.get(ISSUE)?.fp).toBeUndefined();
		// …so the NEXT sweep round still re-enqueues (fp mismatch), and once
		// the permission returns the pin lands.
		discord.pinOutcome = 204;
		discord.messageGet = { status: 200, pinned: true };
		now += 61_000;
		await refresher.maybeSweep();
		expect(await refresher.refresh(ISSUE)).toBe(true);
		expect(store.records.get(ISSUE)?.headerPinned).toBe(true);
		expect(store.records.get(ISSUE)?.fp).toBeDefined();
	});

	it("re-pin PUT 404 clears the fingerprint too — the repost actually happens (Codex design R5 #1)", async () => {
		let now = 1_000_000;
		const { refresher, discord, store } = makeRefresher({
			now: () => now,
			sweepIntervalMs: 60_000,
		});
		expect(await refresher.refresh(ISSUE)).toBe(true);
		discord.messageGet = { status: 200, pinned: false };
		now += 61_000;
		await refresher.maybeSweep();
		// The re-pin PUT hits 404 (message deleted between GET and PUT).
		discord.pinOutcome = 404;
		expect(await refresher.refresh(ISSUE)).toBe(false);
		expect(store.records.get(ISSUE)?.headerMessageId).toBeUndefined();
		expect(store.records.get(ISSUE)?.fp).toBeUndefined();
		// Next pass reposts and lands.
		discord.pinOutcome = 204;
		discord.messageGet = { status: 200, pinned: true };
		expect(await refresher.refresh(ISSUE)).toBe(true);
		const posts = discord.calls.filter(
			(call) => call.method === "POST" && call.url.endsWith("/messages"),
		);
		// 3 posts is deterministic here: the original converge, one repost by
		// the coalesce rerun inside the 404 window (its pin 404'd and cleared
		// again), and the final landing repost.
		expect(posts).toHaveLength(3);
		expect(store.records.get(ISSUE)?.headerPinned).toBe(true);
	});

	it("a transient verification failure (429) blocks the archive catch-up this round (Codex design R5 #2)", async () => {
		let now = 1_000_000;
		const archive = vi.fn(async () => true);
		const terminal = snapshotOf({
			tasks: [
				{
					taskId: "t:design",
					kind: "design",
					state: "done",
					attemptCount: 1,
				},
			],
			closure: "done",
		});
		const { refresher, discord, store } = makeRefresher({
			snapshots: { [ISSUE]: terminal },
			now: () => now,
			sweepIntervalMs: 60_000,
			archiveThread: archive,
		});
		expect(await refresher.refresh(ISSUE)).toBe(true);
		discord.messageGet = { status: 429, pinned: true };
		now += 61_000;
		await refresher.maybeSweep();
		expect(archive).not.toHaveBeenCalled();
		expect(store.records.get(ISSUE)?.archivedAt).toBeUndefined();
		// Verification recovers → the archive catches up next round.
		discord.messageGet = { status: 200, pinned: true };
		now += 61_000;
		await refresher.maybeSweep();
		expect(archive).toHaveBeenCalledWith(THREAD);
		expect(store.records.get(ISSUE)?.archivedAt).toBeDefined();
	});

	it("a late sweep 404 verdict never clobbers a header a concurrent refresh just replaced (Codex design R5 #3)", async () => {
		let now = 1_000_000;
		const { refresher, discord, store } = makeRefresher({
			now: () => now,
			sweepIntervalMs: 60_000,
		});
		expect(await refresher.refresh(ISSUE)).toBe(true);
		// The sweep's GET stalls; meanwhile a concurrent refresh replaced the
		// header (msg-1 → msg-2, new fp).
		let releaseGet = () => {};
		discord.messageGet = { status: 404, pinned: false };
		discord.messageGetGate = new Promise<void>((resolve) => {
			releaseGet = resolve;
		});
		now += 61_000;
		const sweeping = refresher.maybeSweep();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const replaced: V2DisplayRecord = {
			fp: "fp-of-msg-2",
			headerMessageId: "msg-2",
			headerContent: "new content",
			headerPinned: true,
		};
		store.records.set(ISSUE, replaced);
		releaseGet();
		await sweeping;
		// The stale 404 verdict (about msg-1) must NOT clear msg-2's record.
		expect(store.records.get(ISSUE)).toEqual(replaced);
	});

	it("a late verdict about a record archived mid-GET is dropped (Codex design R6 #1)", async () => {
		let now = 1_000_000;
		const { refresher, discord, store } = makeRefresher({
			now: () => now,
			sweepIntervalMs: 60_000,
		});
		expect(await refresher.refresh(ISSUE)).toBe(true);
		const converged = store.records.get(ISSUE) as V2DisplayRecord;
		let releaseGet = () => {};
		discord.messageGet = { status: 404, pinned: false };
		discord.messageGetGate = new Promise<void>((resolve) => {
			releaseGet = resolve;
		});
		now += 61_000;
		const sweeping = refresher.maybeSweep();
		await new Promise((resolve) => setTimeout(resolve, 10));
		// issue_closed archived the thread while the GET was in flight.
		const archivedRecord: V2DisplayRecord = {
			...converged,
			terminal: true,
			archivedAt: "2026-07-30T00:00:00.000Z",
		};
		store.records.set(ISSUE, archivedRecord);
		releaseGet();
		await sweeping;
		// The stale 404 verdict must NOT clear the archived record's fp —
		// that would create a permanently recurring, unrepairable candidate.
		expect(store.records.get(ISSUE)).toEqual(archivedRecord);
	});

	it("the archive catch-up CASes after its await — a replaced record is never overwritten (Codex design R6 #2)", async () => {
		let now = 1_000_000;
		let releaseArchive = (_value: boolean) => {};
		const archive = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					releaseArchive = resolve;
				}),
		);
		const terminal = snapshotOf({
			tasks: [
				{
					taskId: "t:design",
					kind: "design",
					state: "done",
					attemptCount: 1,
				},
			],
			closure: "done",
		});
		const { refresher, store } = makeRefresher({
			snapshots: { [ISSUE]: terminal },
			now: () => now,
			sweepIntervalMs: 60_000,
			archiveThread: archive,
		});
		expect(await refresher.refresh(ISSUE)).toBe(true);
		now += 61_000;
		const sweeping = refresher.maybeSweep();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(archive).toHaveBeenCalled();
		// While the archive await is pending, the header was replaced.
		const replaced: V2DisplayRecord = {
			fp: "fp-of-msg-2",
			headerMessageId: "msg-2",
			headerContent: "new content",
			headerPinned: true,
			terminal: true,
		};
		store.records.set(ISSUE, replaced);
		releaseArchive(true);
		await sweeping;
		// The sweep must NOT restore the stale pre-archive record nor stamp
		// archivedAt onto the replaced one; a later quiet round reconciles.
		expect(store.records.get(ISSUE)).toEqual(replaced);
	});

	it("a verdict resolving inside an inline issue_closed hold is dropped (Codex design R7 #1)", async () => {
		let now = 1_000_000;
		const { refresher, discord, store } = makeRefresher({
			now: () => now,
			sweepIntervalMs: 60_000,
		});
		expect(await refresher.refresh(ISSUE)).toBe(true);
		const converged = store.records.get(ISSUE) as V2DisplayRecord;
		// The sweep's GET stalls; meanwhile the messenger enters the inline
		// issue_closed sequence — its archive HTTP call is in flight (queue
		// empty, archivedAt not yet stamped: exactly the R7 window).
		let releaseGet = () => {};
		discord.messageGet = { status: 404, pinned: false };
		discord.messageGetGate = new Promise<void>((resolve) => {
			releaseGet = resolve;
		});
		now += 61_000;
		const sweeping = refresher.maybeSweep();
		await new Promise((resolve) => setTimeout(resolve, 10));
		let releaseArchive = () => {};
		const holding = refresher.holdIssue(ISSUE, async () => {
			await new Promise<void>((resolve) => {
				releaseArchive = resolve;
			});
			store.records.set(ISSUE, {
				...converged,
				terminal: true,
				archivedAt: "2026-07-30T00:00:00.000Z",
			});
		});
		// The verdict lands while the hold is active — it must be dropped.
		releaseGet();
		await sweeping;
		expect(store.records.get(ISSUE)?.fp).toBe(converged.fp);
		expect(store.records.get(ISSUE)?.headerMessageId).toBe(
			converged.headerMessageId,
		);
		releaseArchive();
		await holding;
		// The inline sequence completed cleanly: converged + archived.
		expect(store.records.get(ISSUE)?.archivedAt).toBeDefined();
		expect(store.records.get(ISSUE)?.fp).toBe(converged.fp);
	});

	it("catches up a deferred issue_closed archive once the fingerprint is current", async () => {
		let now = 1_000_000;
		const archive = vi.fn(async () => true);
		const terminal = snapshotOf({
			tasks: [
				{ taskId: "t:design", kind: "design", state: "done", attemptCount: 1 },
			],
			closure: "done",
		});
		const { refresher, store } = makeRefresher({
			snapshots: { [ISSUE]: terminal },
			now: () => now,
			sweepIntervalMs: 60_000,
			archiveThread: archive,
		});
		await refresher.refresh(ISSUE); // lands, records terminal fp
		expect(store.records.get(ISSUE)?.terminal).toBe(true);
		expect(store.records.get(ISSUE)?.archivedAt).toBeUndefined();
		now += 61_000;
		await refresher.maybeSweep();
		expect(archive).toHaveBeenCalledWith(THREAD);
		expect(store.records.get(ISSUE)?.archivedAt).toBeDefined();
	});
});

describe("openV2DisplayReader — real migrated kernel schema", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("reads a topo-ordered snapshot with attempts, activations, gate and closure", () => {
		dir = mkdtempSync(join(tmpdir(), "fly1549-reader-"));
		const path = join(dir, "flywheel-v2.db");
		migrateDatabase({ path });
		const db = new Database(path);
		const now = "2026-07-30T00:00:00.000Z";
		db.exec("PRAGMA foreign_keys=ON");
		const insertTask = db.prepare(
			`INSERT INTO tasks(id, project_id, kind, state, lineage_root_id, created_at)
			 VALUES (?, 'flywheel', ?, ?, ?, ?)`,
		);
		insertTask.run("t:design", "design", "done", "t:design", now);
		insertTask.run("t:impl", "implement", "running", "t:design", now);
		insertTask.run("t:qa", "qa", "draft", "t:design", now);
		const insertDep = db.prepare(
			`INSERT INTO task_dependencies(task_id, blocked_by_task_id, created_at)
			 VALUES (?, ?, ?)`,
		);
		insertDep.run("t:impl", "t:design", now);
		insertDep.run("t:qa", "t:impl", now);
		const insertAttempt = db.prepare(
			`INSERT INTO attempts(id, task_id, generation, vendor, desired_state, terminal_reason)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		insertAttempt.run(
			"a:design:1",
			"t:design",
			1,
			"claude",
			"terminal",
			"completed",
		);
		insertAttempt.run("a:impl:1", "t:impl", 1, "codex", "terminal", "failed");
		insertAttempt.run("a:impl:2", "t:impl", 2, "claude", "started", null);
		db.prepare(
			"UPDATE attempts SET model='claude-fable-5' WHERE id='a:impl:2'",
		).run();
		db.prepare(
			`INSERT INTO activations(id, attempt_id, session_ref, generation, state)
			 VALUES (?, ?, ?, ?, ?)`,
		).run("act:1", "a:impl:2", "v2dag:a-impl-2:1:act1", 1, "active");
		const meta = db.prepare(
			`INSERT INTO meta(key, value, updated_at) VALUES (?, ?, '${now}')`,
		);
		meta.run("cutover_epoch", "1");
		meta.run(
			"dag_issue:FLY-1549",
			JSON.stringify({
				v: 1,
				revision: 1,
				cutover_epoch: 1,
				data: {
					task_ids: ["t:qa", "t:design", "t:impl"],
					notify_agent_id: "lead",
				},
			}),
		);
		meta.run(
			"ship_gate:FLY-1549",
			JSON.stringify({
				v: 1,
				revision: 1,
				cutover_epoch: 1,
				data: {
					state: "open",
					target: { repo: "x/y", pr: 12, head: "abc123" },
					settled: null,
				},
			}),
		);
		db.close();

		const reader = openV2DisplayReader(path, { warn: () => {} });
		const snapshot = reader.read("FLY-1549");
		reader.close();
		expect(snapshot).not.toBeNull();
		expect(snapshot?.tasks.map((task) => task.taskId)).toEqual([
			"t:design",
			"t:impl",
			"t:qa",
		]);
		expect(snapshot?.tasks[0]).toMatchObject({
			kind: "design",
			state: "done",
			attemptCount: 1,
			attempt: { attemptId: "a:design:1", terminalReason: "completed" },
		});
		expect(snapshot?.tasks[1]).toMatchObject({
			kind: "implement",
			state: "running",
			attemptCount: 2,
			attempt: {
				attemptId: "a:impl:2",
				desiredState: "started",
				vendor: "claude",
				model: "claude-fable-5",
				sessionRef: "v2dag:a-impl-2:1:act1",
			},
		});
		expect(snapshot?.tasks[2]).toMatchObject({ kind: "qa", attemptCount: 0 });
		expect(snapshot?.gate).toMatchObject({
			state: "open",
			pr: 12,
			head: "abc123",
			settled: false,
		});
		expect(snapshot?.closure).toBeUndefined();
	});

	it("returns null for an unknown issue or missing db", () => {
		dir = mkdtempSync(join(tmpdir(), "fly1549-reader-"));
		const path = join(dir, "flywheel-v2.db");
		migrateDatabase({ path });
		const db = new Database(path);
		db.prepare(
			"INSERT INTO meta(key, value, updated_at) VALUES ('cutover_epoch', '1', '2026-07-30T00:00:00.000Z')",
		).run();
		db.close();
		const reader = openV2DisplayReader(path, { warn: () => {} });
		expect(reader.read("FLY-0000")).toBeNull();
		reader.close();
		const missing = openV2DisplayReader(join(dir, "nope.db"), {
			warn: () => {},
		});
		expect(missing.read("FLY-1549")).toBeNull();
		missing.close();
	});

	it("refuses an envelope from another generation (epoch mismatch) — Codex code R1 #2", () => {
		dir = mkdtempSync(join(tmpdir(), "fly1549-reader-"));
		const path = join(dir, "flywheel-v2.db");
		migrateDatabase({ path });
		const db = new Database(path);
		const now = "2026-07-30T00:00:00.000Z";
		const meta = db.prepare(
			`INSERT INTO meta(key, value, updated_at) VALUES (?, ?, '${now}')`,
		);
		meta.run("cutover_epoch", "2");
		meta.run(
			"dag_issue:FLY-1549",
			JSON.stringify({
				v: 1,
				revision: 1,
				cutover_epoch: 1, // fenced-off generation
				data: { task_ids: [] },
			}),
		);
		db.close();
		const warns: string[] = [];
		const reader = openV2DisplayReader(path, {
			warn: (message: string) => warns.push(message),
		});
		expect(reader.read("FLY-1549")).toBeNull();
		expect(warns.some((line) => line.includes("another generation"))).toBe(
			true,
		);
		reader.close();
	});

	it("refuses a valid-but-uninitialized db (no cutover_epoch) — Codex design R1 #1", () => {
		dir = mkdtempSync(join(tmpdir(), "fly1549-reader-"));
		const path = join(dir, "flywheel-v2.db");
		migrateDatabase({ path });
		// Migrated schema but never engine-initialized: refuse to derive.
		const warns: string[] = [];
		const reader = openV2DisplayReader(path, {
			warn: (message: string) => warns.push(message),
		});
		expect(reader.read("FLY-1549")).toBeNull();
		expect(warns.some((line) => line.includes("cutover_epoch"))).toBe(true);
		reader.close();
	});
});
