import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForumPostCreator } from "../bridge/ForumPostCreator.js";
import { StateStore } from "../StateStore.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const STATUS_TAG_MAP: Record<string, string[]> = {
	running: ["tag-running"],
	awaiting_review: ["tag-review"],
};

describe("ForumPostCreator (GEO-195)", () => {
	let store: StateStore;
	let creator: ForumPostCreator;

	beforeEach(async () => {
		vi.clearAllMocks();
		store = await StateStore.create(":memory:");
		creator = new ForumPostCreator(store, STATUS_TAG_MAP);

		// Seed a session so setSessionThreadId works
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});
	});

	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});

	it("creates Forum Post via Discord API and writes back thread mapping", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "thread-new-123" }),
		});

		const result = await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-1",
			issueIdentifier: "GEO-100",
			issueTitle: "Fix bug",
			executionId: "exec-1",
			status: "running",
			discordBotToken: "bot-token",
		});

		expect(result.created).toBe(true);
		expect(result.threadId).toBe("thread-new-123");

		// Verify Discord API was called correctly
		const [url, opts] = mockFetch.mock.calls[0];
		expect(url).toBe("https://discord.com/api/v10/channels/forum-ch-1/threads");
		expect(opts.method).toBe("POST");
		const body = JSON.parse(opts.body);
		expect(body.name).toBe("[GEO-100] Fix bug");
		expect(body.applied_tags).toEqual(["tag-running"]);

		// Verify thread was written to StateStore
		const thread = store.getThreadByIssue("issue-1");
		expect(thread?.thread_id).toBe("thread-new-123");
	});

	it("skips if thread already exists and is valid (idempotent)", async () => {
		store.upsertThread("existing-thread", "forum-ch-1", "issue-1");
		// GEO-200: validation GET returns 200
		mockFetch.mockResolvedValueOnce({ status: 200 });

		const result = await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-1",
			executionId: "exec-1",
			status: "running",
			discordBotToken: "bot-token",
		});

		expect(result.created).toBe(false);
		expect(result.threadId).toBe("existing-thread");
		// Only the validation call, no thread creation POST
		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(mockFetch.mock.calls[0][0]).toContain("/channels/existing-thread");
	});

	it("returns error when no bot token", async () => {
		const result = await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-1",
			executionId: "exec-1",
			status: "running",
		});

		expect(result.created).toBe(false);
		expect(result.error).toBe("no discord bot token");
	});

	it("handles Discord API failure gracefully", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		mockFetch.mockResolvedValue({
			ok: false,
			status: 403,
			text: () => Promise.resolve("Missing Access"),
		});

		const result = await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-1",
			executionId: "exec-1",
			status: "running",
			discordBotToken: "bot-token",
		});

		expect(result.created).toBe(false);
		expect(result.error).toBe("Discord 403");
		warnSpy.mockRestore();
	});

	it("truncates thread name to 100 chars", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "thread-long" }),
		});

		await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-1",
			issueIdentifier: "GEO-100",
			issueTitle: "A".repeat(200),
			executionId: "exec-1",
			status: "running",
			discordBotToken: "bot-token",
		});

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.name.length).toBeLessThanOrEqual(100);
	});

	it("uses per-call statusTagMap over constructor map (GEO-253)", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "thread-override" }),
		});

		await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-1",
			executionId: "exec-1",
			status: "running",
			discordBotToken: "bot-token",
			statusTagMap: { running: ["per-lead-tag"] },
		});

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.applied_tags).toEqual(["per-lead-tag"]);
	});

	it("constructor map empty + per-call map works (GEO-253)", async () => {
		const emptyCreator = new ForumPostCreator(store, {});
		// Need a fresh issue to avoid idempotency skip
		store.upsertSession({
			execution_id: "exec-2",
			issue_id: "issue-2",
			project_name: "geoforge3d",
			status: "running",
		});
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "thread-empty" }),
		});

		await emptyCreator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-2",
			executionId: "exec-2",
			status: "running",
			discordBotToken: "bot-token",
			statusTagMap: { running: ["lead-only-tag"] },
		});

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.applied_tags).toEqual(["lead-only-tag"]);
	});

	it("appliedTags still takes priority over per-call statusTagMap (GEO-253)", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "thread-explicit" }),
		});

		// Need fresh issue
		store.upsertSession({
			execution_id: "exec-3",
			issue_id: "issue-3",
			project_name: "geoforge3d",
			status: "running",
		});

		await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-3",
			executionId: "exec-3",
			status: "running",
			discordBotToken: "bot-token",
			appliedTags: ["explicit-tag"],
			statusTagMap: { running: ["should-not-use"] },
		});

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.applied_tags).toEqual(["explicit-tag"]);
	});
});

describe("ForumPostCreator thread validation (GEO-200)", () => {
	let store: StateStore;
	let creator: ForumPostCreator;

	beforeEach(async () => {
		vi.clearAllMocks();
		store = await StateStore.create(":memory:");
		creator = new ForumPostCreator(store, STATUS_TAG_MAP);

		store.upsertSession({
			execution_id: "exec-v1",
			issue_id: "issue-v1",
			project_name: "geoforge3d",
			status: "running",
		});
		// Seed existing thread
		store.upsertThread("thread-old", "forum-ch-1", "issue-v1");
	});

	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});

	it("validates existing thread (200) → reuse without creating new", async () => {
		// First call: GET /channels/thread-old → 200 (thread exists)
		mockFetch.mockResolvedValueOnce({ status: 200 });

		const result = await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-v1",
			executionId: "exec-v1",
			status: "running",
			discordBotToken: "bot-token",
		});

		expect(result.created).toBe(false);
		expect(result.threadId).toBe("thread-old");
		// Only the validation GET, no POST to create
		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(mockFetch.mock.calls[0][0]).toContain("/channels/thread-old");
	});

	it("creates new thread when existing is deleted (404)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		// First call: GET /channels/thread-old → 404
		mockFetch.mockResolvedValueOnce({ status: 404 });
		// Second call: POST to create new thread
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "thread-new-200" }),
		});

		const result = await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-v1",
			issueIdentifier: "GEO-200",
			issueTitle: "Fix thread",
			executionId: "exec-v1",
			status: "running",
			discordBotToken: "bot-token",
		});

		expect(result.created).toBe(true);
		expect(result.threadId).toBe("thread-new-200");
		// markDiscordMissing should have been called
		expect(store.getThreadByIssue("issue-v1")?.thread_id).toBe(
			"thread-new-200",
		);
		warnSpy.mockRestore();
	});

	it("fail-open on network error → reuse existing", async () => {
		mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

		const result = await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-v1",
			executionId: "exec-v1",
			status: "running",
			discordBotToken: "bot-token",
		});

		expect(result.created).toBe(false);
		expect(result.threadId).toBe("thread-old");
	});

	it("no bot token → skip validation, reuse existing", async () => {
		const result = await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-v1",
			executionId: "exec-v1",
			status: "running",
			// no discordBotToken
		});

		expect(result.created).toBe(false);
		expect(result.threadId).toBe("thread-old");
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
