/**
 * FLY-560 Feature C: pin state-machine tests for ChatThreadCreator.ensureRunnerAttachPin.
 * Covers the self-heal path (pin 403 → retry next stage), idempotent skip,
 * edit-on-change, 404 repost, concurrency serialization, and mention-safety.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatThreadCreator } from "../bridge/ChatThreadCreator.js";
import type { PinResult } from "../bridge/chat-thread-utils.js";
import { StateStore } from "../StateStore.js";

const mockFetch = vi.fn();
beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

const CH = "ch-1";
const ISSUE = "issue-uuid";
const THREAD = "thread-1";
const ctx = {
	chatChannelId: CH,
	issueId: ISSUE,
	issueIdentifier: "FLY-560",
	issueTitle: "Some title",
	botToken: "bot-token",
	routeSummary: "🧭 **Route**: `generic` · source `default_fallback`",
};
const NOW = () => "2026-06-27T12:00:00Z";
const CMD = "env -u TMUX tmux attach -t '=cmux-FLY-560-x'";

/** Mock fetch router for POST message / PATCH message. */
function routeFetch(opts: {
	postMessageId?: string | null;
	postOk?: boolean;
	patchStatus?: number; // 0 = ok
}) {
	mockFetch.mockImplementation(
		async (url: string, init: { method: string }) => {
			if (
				init.method === "POST" &&
				url.endsWith(`/channels/${THREAD}/messages`)
			) {
				if (opts.postOk === false)
					return { ok: false, status: 500, text: async () => "" };
				return {
					ok: true,
					json: async () => ({ id: opts.postMessageId ?? "msg-1" }),
				};
			}
			if (init.method === "PATCH") {
				const status = opts.patchStatus ?? 0;
				if (status === 0) return { ok: true };
				return { ok: false, status, text: async () => "" };
			}
			throw new Error(`unexpected fetch ${init.method} ${url}`);
		},
	);
}

describe("ChatThreadCreator.ensureRunnerAttachPin (FLY-560)", () => {
	let store: StateStore;
	let creator: ChatThreadCreator;

	beforeEach(async () => {
		vi.clearAllMocks();
		store = await StateStore.create(":memory:");
		store.upsertChatThread(THREAD, CH, ISSUE, "lead-a");
		creator = new ChatThreadCreator(store);
	});
	afterEach(() => {
		store.close();
	});

	const pinned: PinResult = { outcome: "pinned", status: 204 };
	const forbidden: PinResult = { outcome: "forbidden", status: 403 };
	const missing: PinResult = { outcome: "missing", status: 404 };

	it("first call: POSTs the command (mention-safe) + pins + records pinnedAt", async () => {
		routeFetch({ postMessageId: "msg-1" });
		const pinImpl = vi.fn(async () => pinned);
		await creator.ensureRunnerAttachPin(ctx, THREAD, CMD, {
			pinImpl,
			now: NOW,
		});

		// POST body carries the command in a code block + allowed_mentions parse:[]
		const post = mockFetch.mock.calls.find((c) => c[1].method === "POST")!;
		const body = JSON.parse(post[1].body);
		expect(body.content).toMatch(/^🤖\[自动\] /);
		expect(body.content.indexOf("🧭 **Route**")).toBeLessThan(
			body.content.indexOf("📌"),
		);
		expect(body.content).toContain(CMD);
		expect(body.content).toContain("FLY-560");
		expect(body.allowed_mentions).toEqual({ parse: [] });
		// pinned via the injected pin impl
		expect(pinImpl).toHaveBeenCalledWith(THREAD, "msg-1", "bot-token");
		// recorded with pinnedAt set
		expect(store.getChatThreadAttachPin(ISSUE, CH)).toEqual({
			messageId: "msg-1",
			command: CMD,
			pinnedAt: "2026-06-27T12:00:00Z",
		});
	});

	it("pin 403 → message recorded unpinned; NEXT same-command call self-heals (no second POST)", async () => {
		routeFetch({ postMessageId: "msg-1" });
		const pinImpl = vi
			.fn<typeof import("../bridge/chat-thread-utils.js").pinThreadMessage>()
			.mockResolvedValueOnce(forbidden) // first attempt: no perms
			.mockResolvedValueOnce(pinned); // after perms fixed
		// round 1: post + pin forbidden
		await creator.ensureRunnerAttachPin(ctx, THREAD, CMD, {
			pinImpl,
			now: NOW,
		});
		expect(store.getChatThreadAttachPin(ISSUE, CH)).toEqual({
			messageId: "msg-1",
			command: CMD,
			pinnedAt: null,
		});
		const postsAfterRound1 = mockFetch.mock.calls.filter(
			(c) => c[1].method === "POST",
		).length;
		expect(postsAfterRound1).toBe(1);

		// round 2 (same command): retries pin only — no new POST
		await creator.ensureRunnerAttachPin(ctx, THREAD, CMD, {
			pinImpl,
			now: NOW,
		});
		expect(store.getChatThreadAttachPin(ISSUE, CH)?.pinnedAt).toBe(
			"2026-06-27T12:00:00Z",
		);
		const postsAfterRound2 = mockFetch.mock.calls.filter(
			(c) => c[1].method === "POST",
		).length;
		expect(postsAfterRound2).toBe(1); // still only the original POST
		expect(pinImpl).toHaveBeenCalledTimes(2);
	});

	it("command unchanged + already pinned → zero Discord calls (idempotent skip)", async () => {
		store.setChatThreadAttachPin(ISSUE, CH, {
			messageId: "msg-1",
			command: CMD,
			pinnedAt: "2026-06-27T11:00:00Z",
		});
		const pinImpl = vi.fn(async () => pinned);
		await creator.ensureRunnerAttachPin(ctx, THREAD, CMD, {
			pinImpl,
			now: NOW,
		});
		expect(mockFetch).not.toHaveBeenCalled();
		expect(pinImpl).not.toHaveBeenCalled();
	});

	it("command changed → EDITs the message in place (no new POST), keeps pinnedAt", async () => {
		store.setChatThreadAttachPin(ISSUE, CH, {
			messageId: "msg-1",
			command: "old-cmd",
			pinnedAt: "2026-06-27T11:00:00Z",
		});
		routeFetch({ patchStatus: 0 });
		const pinImpl = vi.fn(async () => pinned);
		await creator.ensureRunnerAttachPin(ctx, THREAD, CMD, {
			pinImpl,
			now: NOW,
		});

		const patch = mockFetch.mock.calls.find((c) => c[1].method === "PATCH");
		expect(patch).toBeTruthy();
		expect(mockFetch.mock.calls.some((c) => c[1].method === "POST")).toBe(
			false,
		);
		const body = JSON.parse(patch![1].body);
		expect(body.content).toContain(CMD);
		expect(body.allowed_mentions).toEqual({ parse: [] });
		const rec = store.getChatThreadAttachPin(ISSUE, CH);
		expect(rec?.command).toBe(CMD);
		expect(rec?.pinnedAt).toBe("2026-06-27T11:00:00Z"); // preserved (edit doesn't unpin)
		expect(pinImpl).not.toHaveBeenCalled(); // already pinned
	});

	it("edit returns 404 (message deleted) → clears + reposts + repins in same call", async () => {
		store.setChatThreadAttachPin(ISSUE, CH, {
			messageId: "old-msg",
			command: "old-cmd",
			pinnedAt: "2026-06-27T11:00:00Z",
		});
		routeFetch({ patchStatus: 404, postMessageId: "msg-2" });
		const pinImpl = vi.fn(async () => pinned);
		await creator.ensureRunnerAttachPin(ctx, THREAD, CMD, {
			pinImpl,
			now: NOW,
		});
		// new message posted + pinned
		expect(mockFetch.mock.calls.some((c) => c[1].method === "POST")).toBe(true);
		expect(store.getChatThreadAttachPin(ISSUE, CH)).toEqual({
			messageId: "msg-2",
			command: CMD,
			pinnedAt: "2026-06-27T12:00:00Z",
		});
		expect(pinImpl).toHaveBeenCalledWith(THREAD, "msg-2", "bot-token");
	});

	it("concurrent calls are serialized → only one POST (no duplicate pin message)", async () => {
		routeFetch({ postMessageId: "msg-1" });
		const pinImpl = vi.fn(async () => pinned);
		// fire two without awaiting the first
		const p1 = creator.ensureRunnerAttachPin(ctx, THREAD, CMD, {
			pinImpl,
			now: NOW,
		});
		const p2 = creator.ensureRunnerAttachPin(ctx, THREAD, CMD, {
			pinImpl,
			now: NOW,
		});
		await Promise.all([p1, p2]);
		const posts = mockFetch.mock.calls.filter((c) => c[1].method === "POST");
		expect(posts).toHaveLength(1);
	});

	it("fresh POST then pin 404 (message already gone) → record cleared, not retained", async () => {
		routeFetch({ postMessageId: "msg-1" });
		const pinImpl = vi.fn(async () => missing);
		await creator.ensureRunnerAttachPin(ctx, THREAD, CMD, {
			pinImpl,
			now: NOW,
		});
		// Posted, but pin reported the message missing → do not keep a known-missing
		// record; cleared so the next stage reposts fresh.
		expect(store.getChatThreadAttachPin(ISSUE, CH)).toBeUndefined();
		expect(pinImpl).toHaveBeenCalledTimes(1);
	});

	it("POST failure leaves no record (retries next stage)", async () => {
		routeFetch({ postOk: false });
		const pinImpl = vi.fn(async () => pinned);
		await creator.ensureRunnerAttachPin(ctx, THREAD, CMD, {
			pinImpl,
			now: NOW,
		});
		expect(store.getChatThreadAttachPin(ISSUE, CH)).toBeUndefined();
		expect(pinImpl).not.toHaveBeenCalled();
	});

	it("title with @everyone is never mention-parsed (allowed_mentions parse:[])", async () => {
		routeFetch({ postMessageId: "msg-1" });
		const pinImpl = vi.fn(async () => pinned);
		await creator.ensureRunnerAttachPin(
			{ ...ctx, issueTitle: "@everyone ship it" },
			THREAD,
			CMD,
			{ pinImpl, now: NOW },
		);
		const post = mockFetch.mock.calls.find((c) => c[1].method === "POST")!;
		expect(JSON.parse(post[1].body).allowed_mentions).toEqual({ parse: [] });
	});

	void missing; // referenced for completeness; covered via routeFetch 404 path
});
