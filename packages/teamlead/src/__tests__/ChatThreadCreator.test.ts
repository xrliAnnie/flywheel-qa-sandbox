import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatThreadCreator } from "../bridge/ChatThreadCreator.js";
import { resolveChatThreadId } from "../bridge/chat-thread-utils.js";
import { StateStore } from "../StateStore.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("FLY-91: ChatThreadCreator", () => {
	let store: StateStore;
	let creator: ChatThreadCreator;

	beforeEach(async () => {
		vi.clearAllMocks();
		store = await StateStore.create(":memory:");
		creator = new ChatThreadCreator(store);
	});

	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});

	it("creates a chat thread via Discord API and stores mapping", async () => {
		// Step 1: POST message → success, Step 2: POST thread from message → success
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "msg-123" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "thread-abc" }),
			});

		const result = await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "issue-1",
			issueIdentifier: "FLY-91",
			issueTitle: "Discord thread reply",
			botToken: "bot-token",
		});

		expect(result.created).toBe(true);
		expect(result.threadId).toBe("thread-abc");

		// Verify Step 1: POST message to channel
		const [msgUrl, msgOpts] = mockFetch.mock.calls[0]!;
		expect(msgUrl).toBe("https://discord.com/api/v10/channels/ch-123/messages");
		expect(msgOpts.method).toBe("POST");
		const msgBody = JSON.parse(msgOpts.body);
		expect(msgBody.content).toContain("FLY-91");

		// Verify Step 2: POST thread from message
		const [threadUrl, threadOpts] = mockFetch.mock.calls[1]!;
		expect(threadUrl).toBe(
			"https://discord.com/api/v10/channels/ch-123/messages/msg-123/threads",
		);
		expect(threadOpts.method).toBe("POST");
		const threadBody = JSON.parse(threadOpts.body);
		expect(threadBody.name).toBe("[FLY-91] Discord thread reply");
		expect(threadBody.auto_archive_duration).toBe(4320);

		// Verify stored mapping (FLY-369: getChatThreadByIssue also returns lead_id + archived_at)
		const stored = store.getChatThreadByIssue("issue-1", "ch-123");
		expect(stored).toEqual({
			thread_id: "thread-abc",
			channel_id: "ch-123",
			lead_id: null,
			archived_at: null,
		});
	});

	it("includes issue title in first channel message and truncates thread name to Discord 100 chars", async () => {
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "msg-title" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "thread-title" }),
			});

		const longTitle = "Fix Bridge thread names ".repeat(8);
		await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "FLY-509",
			issueIdentifier: "FLY-509",
			issueTitle: longTitle,
			botToken: "bot-token",
		});

		const msgBody = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(msgBody.content).toContain("FLY-509");
		expect(msgBody.content).toContain("Fix Bridge thread names");

		const threadBody = JSON.parse(mockFetch.mock.calls[1]![1].body);
		expect(
			threadBody.name.startsWith("[FLY-509] Fix Bridge thread names"),
		).toBe(true);
		expect(threadBody.name).toHaveLength(100);
	});

	it("uses identifier-shaped issueId as the display key when issueIdentifier is absent", async () => {
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "msg-fallback" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "thread-fallback" }),
			});

		await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "FLY-509",
			issueTitle: "Bridge thread names include issue title",
			botToken: "bot-token",
		});

		const msgBody = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(msgBody.content).toContain("**FLY-509**");
		expect(msgBody.content).toContain(
			"Bridge thread names include issue title",
		);

		const threadBody = JSON.parse(mockFetch.mock.calls[1]![1].body);
		expect(threadBody.name).toBe(
			"[FLY-509] Bridge thread names include issue title",
		);
	});

	it("reuses existing chat thread and posts channel notification", async () => {
		// Pre-seed mapping
		store.upsertChatThread("thread-existing", "ch-123", "issue-1");

		// Call 1: validateThreadExists GET /channels/thread-existing → 200
		// Call 2: backfill GET /channels/thread-existing → custom name
		// Call 3: POST channel notification
		mockFetch
			.mockResolvedValueOnce({ ok: true, status: 200 })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ name: "[GEO-312] Test issue" }),
			})
			.mockResolvedValueOnce({ ok: true });

		const result = await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "issue-1",
			issueIdentifier: "GEO-312",
			issueTitle: "Test issue",
			botToken: "bot-token",
		});

		expect(result.created).toBe(false);
		expect(result.threadId).toBe("thread-existing");
		// Three fetch calls: validate + backfill check + channel notification
		expect(mockFetch).toHaveBeenCalledTimes(3);
		expect(mockFetch.mock.calls[0]![0]).toContain("/channels/thread-existing");

		// Verify channel notification
		const [notifUrl, notifOpts] = mockFetch.mock.calls[2]!;
		expect(notifUrl).toBe(
			"https://discord.com/api/v10/channels/ch-123/messages",
		);
		const notifBody = JSON.parse(notifOpts.body);
		expect(notifBody.content).toContain("GEO-312");
		expect(notifBody.content).toContain("<#thread-existing>");
	});

	it("renames an existing placeholder thread when issue title is available", async () => {
		store.upsertChatThread("thread-existing", "ch-123", "FLY-509");
		mockFetch
			.mockResolvedValueOnce({ ok: true, status: 200 })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ name: "[FLY-509] FLY-509" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ id: "thread-existing" }),
			})
			.mockResolvedValueOnce({ ok: true });

		await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "FLY-509",
			issueIdentifier: "FLY-509",
			issueTitle: "Bridge thread names include issue title",
			botToken: "bot-token",
		});

		expect(mockFetch.mock.calls[2]![0]).toBe(
			"https://discord.com/api/v10/channels/thread-existing",
		);
		expect(mockFetch.mock.calls[2]![1].method).toBe("PATCH");
		expect(JSON.parse(mockFetch.mock.calls[2]![1].body).name).toBe(
			"[FLY-509] Bridge thread names include issue title",
		);
	});

	it("renames an existing identifier-only placeholder when issueIdentifier is absent", async () => {
		store.upsertChatThread("thread-fallback", "ch-123", "FLY-509");
		mockFetch
			.mockResolvedValueOnce({ ok: true, status: 200 })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ name: "FLY-509" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ id: "thread-fallback" }),
			})
			.mockResolvedValueOnce({ ok: true });

		await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "FLY-509",
			issueTitle: "Bridge thread names include issue title",
			botToken: "bot-token",
		});

		expect(mockFetch.mock.calls[2]![1].method).toBe("PATCH");
		expect(JSON.parse(mockFetch.mock.calls[2]![1].body).name).toBe(
			"[FLY-509] Bridge thread names include issue title",
		);
	});

	it("does not rename an existing custom thread name", async () => {
		store.upsertChatThread("thread-custom", "ch-123", "FLY-509");
		mockFetch
			.mockResolvedValueOnce({ ok: true, status: 200 })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () =>
					Promise.resolve({ name: "[FLY-509] already curated title" }),
			})
			.mockResolvedValueOnce({ ok: true });

		await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "FLY-509",
			issueIdentifier: "FLY-509",
			issueTitle: "Bridge thread names include issue title",
			botToken: "bot-token",
		});

		expect(
			mockFetch.mock.calls.some((call) => call[1]?.method === "PATCH"),
		).toBe(false);
	});

	it("recreates thread when existing one returns 404", async () => {
		store.upsertChatThread("thread-dead", "ch-123", "issue-1");

		// Call 1: validate → 404
		// Call 2: POST message → success
		// Call 3: POST thread from message → success
		mockFetch
			.mockResolvedValueOnce({ ok: false, status: 404 })
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "msg-456" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "thread-new" }),
			});

		const result = await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "issue-1",
			issueIdentifier: "FLY-91",
			botToken: "bot-token",
		});

		expect(result.created).toBe(true);
		expect(result.threadId).toBe("thread-new");

		// Old thread should be marked missing
		const old = store.getChatThreadByIssue("issue-1", "ch-123");
		// Should now return the new thread
		expect(old?.thread_id).toBe("thread-new");
	});

	it("returns error when message post fails", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 403,
			text: () => Promise.resolve("Missing Permissions"),
		});

		const result = await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "issue-1",
			botToken: "bot-token",
		});

		expect(result.created).toBe(false);
		expect(result.error).toContain("Discord 403");
		expect(result.error).toContain("Missing Permissions");
	});

	it("returns error when thread creation from message fails", async () => {
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "msg-123" }),
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				text: () => Promise.resolve("Internal Server Error"),
			});

		const result = await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "issue-1",
			botToken: "bot-token",
		});

		expect(result.created).toBe(false);
		expect(result.error).toContain("Discord 500");
	});

	it("returns timeout error when Discord API hangs", async () => {
		// Mock fetch that never resolves until abort
		mockFetch.mockImplementation(
			(_url: string, opts: { signal: AbortSignal }) => {
				return new Promise((_resolve, reject) => {
					opts.signal.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			},
		);

		const result = await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "issue-1",
			botToken: "bot-token",
		});

		expect(result.created).toBe(false);
		expect(result.error).toBe("timeout");
	}, 10_000);

	it("truncates thread name to 100 chars", async () => {
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "msg-long" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "thread-long" }),
			});

		const longTitle = "A".repeat(200);
		await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "issue-1",
			issueTitle: longTitle,
			botToken: "bot-token",
		});

		// Thread name is in the second call (thread creation from message)
		const threadBody = JSON.parse(mockFetch.mock.calls[1]![1].body);
		expect(threadBody.name.length).toBeLessThanOrEqual(100);
	});

	it("stores leadId when provided", async () => {
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "msg-lead" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "thread-lead" }),
			});

		await creator.ensureChatThread({
			chatChannelId: "ch-123",
			issueId: "issue-1",
			botToken: "bot-token",
			leadId: "product-lead",
		});

		const stored = store.getChatThreadByIssue("issue-1", "ch-123");
		expect(stored?.thread_id).toBe("thread-lead");
	});

	// FLY-162 Codex R3 issue #2: Every Discord message POST out of
	// ChatThreadCreator must carry `allowed_mentions: { parse: [] }` so a
	// Linear issue title (or anything else) containing `@everyone`/`@here`/
	// role text cannot trigger a real ping. Covers Step 1 (initial channel
	// message on create) and the reuse-path notification ping.

	it("FLY-162: Step 1 channel POST sets allowed_mentions: { parse: [] }", async () => {
		mockFetch
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "msg-am-1" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "thread-am-1" }),
			});

		await creator.ensureChatThread({
			chatChannelId: "ch-am",
			issueId: "issue-am",
			issueIdentifier: "FLY-162",
			issueTitle: "@everyone test",
			botToken: "bot-token",
		});

		const [, msgOpts] = mockFetch.mock.calls[0]!;
		const msgBody = JSON.parse(msgOpts.body);
		expect(msgBody.allowed_mentions).toEqual({ parse: [] });
	});

	it("FLY-162: reuse-path notification POST sets allowed_mentions: { parse: [] }", async () => {
		// Pre-seed mapping so we hit the reuse path
		store.upsertChatThread("thread-reuse", "ch-am", "issue-am");

		// Call 1: validateThreadExists GET → 200
		// Call 2: backfill GET → already titled, no PATCH
		// Call 3: postChannelNotification POST — this is the one we assert.
		mockFetch
			.mockResolvedValueOnce({ ok: true, status: 200 })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ name: "[FLY-162] Reuse path" }),
			})
			.mockResolvedValueOnce({ ok: true });

		await creator.ensureChatThread({
			chatChannelId: "ch-am",
			issueId: "issue-am",
			issueIdentifier: "FLY-162",
			issueTitle: "Reuse path",
			botToken: "bot-token",
		});

		// The last call is the notification POST.
		const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]!;
		const [, notifyOpts] = lastCall;
		const notifyBody = JSON.parse(notifyOpts.body);
		expect(notifyBody.allowed_mentions).toEqual({ parse: [] });
	});
});

describe("FLY-91: StateStore chat_threads CRUD", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	it("upsertChatThread + getChatThreadByIssue", () => {
		store.upsertChatThread("t-1", "ch-1", "issue-1");
		const result = store.getChatThreadByIssue("issue-1", "ch-1");
		// FLY-369: getChatThreadByIssue now also returns lead_id + archived_at (null when unset).
		expect(result).toEqual({
			thread_id: "t-1",
			channel_id: "ch-1",
			lead_id: null,
			archived_at: null,
		});
	});

	it("returns undefined for non-existent issue", () => {
		const result = store.getChatThreadByIssue("issue-missing", "ch-1");
		expect(result).toBeUndefined();
	});

	it("composite key: same issue, different channels", () => {
		store.upsertChatThread("t-1", "ch-1", "issue-1");
		store.upsertChatThread("t-2", "ch-2", "issue-1");

		expect(store.getChatThreadByIssue("issue-1", "ch-1")?.thread_id).toBe(
			"t-1",
		);
		expect(store.getChatThreadByIssue("issue-1", "ch-2")?.thread_id).toBe(
			"t-2",
		);
	});

	it("upsert replaces old thread for same (issue, channel)", () => {
		store.upsertChatThread("t-old", "ch-1", "issue-1");
		store.upsertChatThread("t-new", "ch-1", "issue-1");

		const result = store.getChatThreadByIssue("issue-1", "ch-1");
		expect(result?.thread_id).toBe("t-new");
	});

	it("markChatThreadMissing hides thread from getChatThreadByIssue", () => {
		store.upsertChatThread("t-1", "ch-1", "issue-1");
		store.markChatThreadMissing("t-1");

		const result = store.getChatThreadByIssue("issue-1", "ch-1");
		expect(result).toBeUndefined();
	});

	it("can create new thread after marking old one missing", () => {
		store.upsertChatThread("t-old", "ch-1", "issue-1");
		store.markChatThreadMissing("t-old");
		store.upsertChatThread("t-new", "ch-1", "issue-1");

		const result = store.getChatThreadByIssue("issue-1", "ch-1");
		expect(result?.thread_id).toBe("t-new");
	});
});

describe("FLY-91: resolveChatThreadId helper", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	it("returns thread_id when mapping exists", () => {
		store.upsertChatThread("t-1", "ch-1", "issue-1");
		expect(resolveChatThreadId(store, "issue-1", "ch-1")).toBe("t-1");
	});

	it("returns undefined when no mapping exists", () => {
		expect(resolveChatThreadId(store, "issue-1", "ch-1")).toBeUndefined();
	});

	it("returns undefined when chatChannelId is undefined", () => {
		store.upsertChatThread("t-1", "ch-1", "issue-1");
		expect(resolveChatThreadId(store, "issue-1", undefined)).toBeUndefined();
	});
});
