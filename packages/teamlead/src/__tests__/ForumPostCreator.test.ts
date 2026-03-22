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

	it("skips if thread already exists (idempotent)", async () => {
		store.upsertThread("existing-thread", "forum-ch-1", "issue-1");

		const result = await creator.ensureForumPost({
			forumChannelId: "forum-ch-1",
			issueId: "issue-1",
			executionId: "exec-1",
			status: "running",
			discordBotToken: "bot-token",
		});

		expect(result.created).toBe(false);
		expect(result.threadId).toBe("existing-thread");
		expect(mockFetch).not.toHaveBeenCalled();
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
});
