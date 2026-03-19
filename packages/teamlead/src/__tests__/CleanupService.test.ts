import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CleanupService,
	type DiscordClient,
	RateLimitError,
} from "../CleanupService.js";
import { StateStore } from "../StateStore.js";

const toSqlite = (d: Date) =>
	d
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
function mockDiscord(): DiscordClient & {
	sendMessage: ReturnType<typeof vi.fn>;
	archiveThread: ReturnType<typeof vi.fn>;
} {
	return {
		sendMessage: vi.fn().mockResolvedValue(undefined),
		archiveThread: vi.fn().mockResolvedValue(undefined),
	};
}
describe("CleanupService", () => {
	let store: StateStore;
	let discord: ReturnType<typeof mockDiscord>;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		discord = mockDiscord();
	});
	it("archives eligible candidates", async () => {
		const p = toSqlite(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession({
			execution_id: "e1",
			issue_id: "GEO-100",
			project_name: "t",
			status: "completed",
			started_at: p,
			last_activity_at: p,
		});
		store.upsertThread("t1", "C", "GEO-100");
		await new CleanupService(store, discord, 1440, 60000).check();
		expect(discord.archiveThread).toHaveBeenCalledWith("t1");
	});
	it("sends notification before archive", async () => {
		const p = toSqlite(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession({
			execution_id: "e1",
			issue_id: "GEO-100",
			project_name: "t",
			status: "completed",
			started_at: p,
			last_activity_at: p,
		});
		store.upsertThread("t1", "C", "GEO-100");
		const c: string[] = [];
		discord.sendMessage.mockImplementation(async () => {
			c.push("s");
		});
		discord.archiveThread.mockImplementation(async () => {
			c.push("a");
		});
		await new CleanupService(store, discord, 1440, 60000).check();
		expect(c).toEqual(["s", "a"]);
	});
	it("markArchived on success", async () => {
		const p = toSqlite(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession({
			execution_id: "e1",
			issue_id: "GEO-100",
			project_name: "t",
			status: "completed",
			started_at: p,
			last_activity_at: p,
		});
		store.upsertThread("t1", "C", "GEO-100");
		await new CleanupService(store, discord, 1440, 60000).check();
		expect(store.getEligibleForCleanup(1440)).toHaveLength(0);
	});
	it("archive failure prevents markArchived", async () => {
		const p = toSqlite(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession({
			execution_id: "e1",
			issue_id: "GEO-100",
			project_name: "t",
			status: "completed",
			started_at: p,
			last_activity_at: p,
		});
		store.upsertThread("t1", "C", "GEO-100");
		discord.archiveThread.mockRejectedValue(new Error("fail"));
		await new CleanupService(store, discord, 1440, 60000).check();
		expect(store.getEligibleForCleanup(1440)).toHaveLength(1);
	});
	it("already-archived send still archives", async () => {
		const p = toSqlite(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession({
			execution_id: "e1",
			issue_id: "GEO-100",
			project_name: "t",
			status: "completed",
			started_at: p,
			last_activity_at: p,
		});
		store.upsertThread("t1", "C", "GEO-100");
		discord.sendMessage.mockRejectedValue(new Error("already archived"));
		await new CleanupService(store, discord, 1440, 60000).check();
		expect(discord.archiveThread).toHaveBeenCalledOnce();
	});
	it("skips send when already notified", async () => {
		const p = toSqlite(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession({
			execution_id: "e1",
			issue_id: "GEO-100",
			project_name: "t",
			status: "completed",
			started_at: p,
			last_activity_at: p,
		});
		store.upsertThread("t1", "C", "GEO-100");
		store.markCleanupNotified("t1");
		await new CleanupService(store, discord, 1440, 60000).check();
		expect(discord.sendMessage).not.toHaveBeenCalled();
	});
	it("empty candidates no-op", async () => {
		await new CleanupService(store, discord, 1440, 60000).check();
		expect(discord.sendMessage).not.toHaveBeenCalled();
	});
	it("rate limit stops cycle", async () => {
		const p = toSqlite(new Date(Date.now() - 25 * 60 * 60 * 1000));
		store.upsertSession({
			execution_id: "e1",
			issue_id: "GEO-100",
			project_name: "t",
			status: "completed",
			started_at: p,
			last_activity_at: p,
		});
		store.upsertThread("t1", "C", "GEO-100");
		store.upsertSession({
			execution_id: "e2",
			issue_id: "GEO-101",
			project_name: "t",
			status: "completed",
			started_at: p,
			last_activity_at: p,
		});
		store.upsertThread("t2", "C", "GEO-101");
		discord.sendMessage.mockRejectedValueOnce(new RateLimitError("429"));
		await new CleanupService(store, discord, 1440, 60000).check();
		expect(discord.archiveThread).not.toHaveBeenCalled();
	});
	it("start/stop", () => {
		const s = new CleanupService(store, discord, 1440, 60000);
		s.start();
		s.start();
		s.stop();
		s.stop();
	});
});
