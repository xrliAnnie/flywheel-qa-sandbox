import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForumTagUpdater } from "../bridge/ForumTagUpdater.js";

const TAG_MAP: Record<string, string[]> = {
	running: ["tag-running"],
	awaiting_review: ["tag-review"],
	approved: ["tag-approved"],
	completed: ["tag-completed"],
	failed: ["tag-failed"],
	blocked: ["tag-blocked"],
	rejected: ["tag-rejected"],
	deferred: ["tag-deferred"],
	shelved: ["tag-shelved"],
};

describe("ForumTagUpdater", () => {
	let updater: ForumTagUpdater;
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		updater = new ForumTagUpdater(TAG_MAP);
		fetchSpy = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("successful tag updates", () => {
		it("updates tag for running status", async () => {
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "running",
				eventType: "session_started",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("succeeded");
			expect(fetchSpy).toHaveBeenCalledOnce();
			const [url, opts] = fetchSpy.mock.calls[0];
			expect(url).toBe("https://discord.com/api/v10/channels/thread-1");
			expect(opts.method).toBe("PATCH");
			expect(opts.headers.Authorization).toBe("Bot bot-token");
			expect(JSON.parse(opts.body)).toEqual({
				applied_tags: ["tag-running"],
			});
		});

		it("updates tag for awaiting_review status", async () => {
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "awaiting_review",
				eventType: "session_completed",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("succeeded");
			expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
				applied_tags: ["tag-review"],
			});
		});
	});

	describe("skip rules", () => {
		it("skips for retry action", async () => {
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "running",
				eventType: "action_executed",
				action: "retry",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("skipped");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("skips for reject action", async () => {
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "rejected",
				eventType: "action_executed",
				action: "reject",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("skipped");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("skips for defer action", async () => {
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "deferred",
				eventType: "action_executed",
				action: "defer",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("skipped");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("skips for shelve action", async () => {
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "shelved",
				eventType: "action_executed",
				action: "shelve",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("skipped");
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});

	describe("no_thread result", () => {
		it("returns no_thread when threadId is missing", async () => {
			const result = await updater.updateTag({
				status: "running",
				eventType: "session_started",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("no_thread");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("returns no_thread when threadId is empty string", async () => {
			const result = await updater.updateTag({
				threadId: "",
				status: "running",
				eventType: "session_started",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("no_thread");
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});

	describe("skipped — no bot token", () => {
		it("returns skipped when discordBotToken is missing", async () => {
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "running",
				eventType: "session_started",
			});
			expect(result).toBe("skipped");
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});

	describe("failed — Discord API error", () => {
		it("returns failed when Discord returns non-ok", async () => {
			fetchSpy.mockResolvedValue({
				ok: false,
				status: 404,
				text: async () => "Not Found",
			});
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "running",
				eventType: "session_started",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("failed");
		});

		it("returns failed when fetch throws", async () => {
			fetchSpy.mockRejectedValue(new Error("Network error"));
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "running",
				eventType: "session_started",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("failed");
		});
	});

	describe("unmapped status", () => {
		it("returns skipped for unknown status with no tag mapping", async () => {
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "some_unknown_status",
				eventType: "session_completed",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("skipped");
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});

	describe("per-call statusTagMap override (GEO-253)", () => {
		it("uses ctx.statusTagMap over constructor map", async () => {
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "running",
				eventType: "session_started",
				discordBotToken: "bot-token",
				statusTagMap: { running: ["per-lead-tag"] },
			});
			expect(result).toBe("succeeded");
			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body.applied_tags).toEqual(["per-lead-tag"]);
		});

		it("constructor map empty + per-call map works", async () => {
			const emptyUpdater = new ForumTagUpdater({});
			const result = await emptyUpdater.updateTag({
				threadId: "thread-1",
				status: "completed",
				eventType: "session_completed",
				discordBotToken: "bot-token",
				statusTagMap: { completed: ["lead-completed-tag"] },
			});
			expect(result).toBe("succeeded");
			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body.applied_tags).toEqual(["lead-completed-tag"]);
		});

		it("falls back to constructor map when ctx.statusTagMap not provided", async () => {
			const result = await updater.updateTag({
				threadId: "thread-1",
				status: "running",
				eventType: "session_started",
				discordBotToken: "bot-token",
			});
			expect(result).toBe("succeeded");
			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body.applied_tags).toEqual(["tag-running"]);
		});
	});
});
