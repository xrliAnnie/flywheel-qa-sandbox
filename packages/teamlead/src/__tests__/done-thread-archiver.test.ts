/**
 * FLY-369: archive-on-close — done-thread-archiver unit tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveChatThreadResult } from "../bridge/chat-thread-utils.js";
import {
	archiveEpochInterval,
	archiveThreadAndRecord,
	maybeArchiveThreadOnClose,
	reactivateChatThreadForStartedSession,
	resolveBotTokenForThread,
	resolveReopenVeto,
	runUnderThreadArchiveLock,
} from "../bridge/done-thread-archiver.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const PROJECT: ProjectEntry = {
	projectName: "Flywheel",
	projectRoot: "/tmp/fw",
	leads: [
		{
			agentId: "tadashi",
			chatChannel: "ch-eng",
			match: { labels: ["Flywheel"] },
			botToken: "tok-tadashi",
		},
		{
			agentId: "other",
			chatChannel: "ch-other",
			match: { labels: ["Other"] },
			botToken: "tok-other",
		},
	],
} as ProjectEntry;

const OK_ARCHIVE: ArchiveChatThreadResult = {
	archived: true,
	attempts: 1,
	status: 200,
	reason: "ok",
};
const FAIL_ARCHIVE: ArchiveChatThreadResult = {
	archived: false,
	attempts: 3,
	status: 500,
	reason: "exhausted",
};

const DISCORD_EPOCH_MS = 1_420_070_400_000;
const NOW = Date.UTC(2026, 8, 3, 4, 0, 0);

function snowflakeAt(ms: number): string {
	return (BigInt(ms - DISCORD_EPOCH_MS) << 22n).toString();
}

describe("resolveBotTokenForThread", () => {
	it("prefers the thread's recorded lead_id", () => {
		expect(
			resolveBotTokenForThread([PROJECT], {
				projectName: "Flywheel",
				leadId: "other",
				labels: ["Flywheel"],
			}),
		).toBe("tok-other");
	});

	it("falls back to label-based resolution when lead_id missing", () => {
		expect(
			resolveBotTokenForThread([PROJECT], {
				projectName: "Flywheel",
				leadId: null,
				labels: ["Other"],
			}),
		).toBe("tok-other");
	});

	it("falls back to the global token when nothing resolves", () => {
		expect(
			resolveBotTokenForThread([PROJECT], {
				projectName: "Nope",
				leadId: null,
				labels: [],
				fallbackBotToken: "tok-global",
			}),
		).toBe("tok-global");
	});
});

describe("archiveThreadAndRecord", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertChatThread("t-1", "ch-eng", "FLY-100", "tadashi");
	});

	const archivedAt = () =>
		store.getChatThreadByIssue("FLY-100", "ch-eng")?.archived_at;

	it("on success: archives, marks archived_at, writes chat_thread_archived event", async () => {
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const res = await archiveThreadAndRecord(
			store,
			{
				threadId: "t-1",
				issueId: "FLY-100",
				projectName: "Flywheel",
				executionId: "exec-1",
			},
			"tok-tadashi",
			{ archiveFn, quietWindowMs: 0 },
		);
		expect(res.archived).toBe(true);
		expect(archiveFn).toHaveBeenCalledWith(
			"t-1",
			"tok-tadashi",
			expect.any(Object),
		);
		// archived → archived_at set (archive-once record)
		expect(archivedAt()).toBeTruthy();
		const events = store.getEventsByExecution("exec-1");
		expect(events.some((e) => e.event_type === "chat_thread_archived")).toBe(
			true,
		);
	});

	it("on failure: does NOT mark archived, writes chat_thread_archive_failed event", async () => {
		const archiveFn = vi.fn().mockResolvedValue(FAIL_ARCHIVE);
		const res = await archiveThreadAndRecord(
			store,
			{
				threadId: "t-1",
				issueId: "FLY-100",
				projectName: "Flywheel",
				executionId: "exec-1",
			},
			"tok-tadashi",
			{ archiveFn, quietWindowMs: 0 },
		);
		expect(res.archived).toBe(false);
		// not archived → archived_at stays null
		expect(archivedAt()).toBeNull();
		const events = store.getEventsByExecution("exec-1");
		expect(
			events.some((e) => e.event_type === "chat_thread_archive_failed"),
		).toBe(true);
	});

	it("removes the owner before archive when discordOwnerUserId is given", async () => {
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const removeUserFn = vi.fn().mockResolvedValue(undefined);
		await archiveThreadAndRecord(
			store,
			{
				threadId: "t-1",
				issueId: "FLY-100",
				projectName: "Flywheel",
				executionId: "exec-1",
			},
			"tok-tadashi",
			{
				archiveFn,
				removeUserFn,
				discordOwnerUserId: "owner-9",
				quietWindowMs: 0,
			},
		);
		expect(removeUserFn).toHaveBeenCalledWith(
			"t-1",
			"owner-9",
			"tok-tadashi",
			expect.objectContaining({}),
		);
	});

	// ── FLY-1165: sink-level archive-once + per-thread serialization ──────────

	const INPUT = {
		threadId: "t-1",
		issueId: "FLY-100",
		projectName: "Flywheel",
		executionId: "exec-1",
	};

	it("FLY-1165: no-ops when archived_at is set — archiveFn/removeUserFn not called, reason already_archived, attempts 0", async () => {
		store.markChatThreadArchived("t-1");
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const removeUserFn = vi.fn().mockResolvedValue(undefined);
		const probeFn = vi
			.fn()
			.mockResolvedValue({ ok: true, name: "thread", archived: true });
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			removeUserFn,
			probeFn,
			discordOwnerUserId: "owner-9",
		});
		expect(res.archived).toBe(true);
		expect(res.reason).toBe("already_archived");
		expect(res.attempts).toBe(0);
		expect(probeFn).toHaveBeenCalledOnce();
		expect(archiveFn).not.toHaveBeenCalled();
		expect(removeUserFn).not.toHaveBeenCalled();
	});

	it("FLY-1709: protects a founder-reopened thread and reports the no-op honestly", async () => {
		store.markChatThreadArchived("t-1");
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const classifyFn = vi.fn().mockResolvedValue({ kind: "human" });
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			probeFn: vi
				.fn()
				.mockResolvedValue({ ok: true, name: "thread", archived: false }),
			classifyFn,
		});
		expect(res).toMatchObject({
			archived: false,
			attempts: 0,
			reason: "founder_reopened",
		});
		expect(classifyFn).toHaveBeenCalledOnce();
		expect(archiveFn).not.toHaveBeenCalled();
	});

	it("FLY-2028: terminal authority re-archives a quiet human-reopened thread", async () => {
		store.markChatThreadArchived("t-1");
		const frontier = snowflakeAt(NOW - 2 * 60 * 60_000);
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const classifyFn = vi.fn().mockResolvedValue({ kind: "human" });
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			quietWindowMs: 60 * 60_000,
			nowMs: () => NOW,
			archiveFn,
			probeFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: true }),
			frontierFn: vi.fn().mockResolvedValue({ ok: true, messageId: frontier }),
			classifyFn,
		});

		expect(result).toMatchObject({ archived: true, reason: "ok" });
		expect(classifyFn).not.toHaveBeenCalled();
		expect(archiveFn).toHaveBeenCalledOnce();
	});

	it("FLY-2028: terminal authority defers a recently active reopened thread without audit noise", async () => {
		store.markChatThreadArchived("t-1");
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			quietWindowMs: 60 * 60_000,
			nowMs: () => NOW,
			archiveFn,
			probeFn: vi.fn().mockResolvedValue({
				ok: true,
				name: "thread",
				archived: false,
				archiveTimestamp: new Date(NOW - 5 * 60_000).toISOString(),
			}),
			frontierFn: vi.fn().mockResolvedValue({
				ok: true,
				messageId: snowflakeAt(NOW - 2 * 60 * 60_000),
			}),
		});

		expect(result).toMatchObject({
			archived: false,
			reason: "deferred_quiet_window",
		});
		expect(archiveFn).not.toHaveBeenCalled();
		expect(store.getEventsByExecution("exec-1")).toEqual([]);
	});

	it("FLY-2028: first automatic archive defers inside the quiet window", async () => {
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const removeUserFn = vi.fn();
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			quietWindowMs: 60 * 60_000,
			nowMs: () => NOW,
			archiveFn,
			removeUserFn,
			discordOwnerUserId: "owner-9",
			probeFn: vi
				.fn()
				.mockResolvedValue({ ok: true, name: "thread", archived: false }),
			frontierFn: vi.fn().mockResolvedValue({
				ok: true,
				messageId: snowflakeAt(NOW - 5 * 60_000),
			}),
		});

		expect(result.reason).toBe("deferred_quiet_window");
		expect(archiveFn).not.toHaveBeenCalled();
		expect(removeUserFn).not.toHaveBeenCalled();
		expect(store.getChatThreadArchivedAt("t-1")).toBeNull();
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
		expect(store.getEventsByExecution("exec-1")).toEqual([]);
	});

	it("FLY-2028: first automatic archive fences and commits atomically after a quiet hour", async () => {
		const frontier = snowflakeAt(NOW - 2 * 60 * 60_000);
		const archiveFn = vi.fn(async () => {
			expect(store.getChatThreadCompensationPending("t-1")).toMatchObject({
				version: 1,
				frontier,
			});
			return OK_ARCHIVE;
		});
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			quietWindowMs: 60 * 60_000,
			nowMs: () => NOW,
			archiveFn,
			probeFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: true }),
			frontierFn: vi.fn().mockResolvedValue({ ok: true, messageId: frontier }),
		});

		expect(result).toMatchObject({ archived: true, reason: "ok" });
		expect(store.getChatThreadArchivedAt("t-1")).not.toBeNull();
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
		const events = store.getEventsByExecution("exec-1");
		expect(events).toHaveLength(1);
		expect(events[0]?.event_id).toContain("chat-thread-archived-fly2028-t-1-");
	});

	it("FLY-2028: retries transient preflight reads before the first archive", async () => {
		const frontier = snowflakeAt(NOW - 2 * 60 * 60_000);
		const sleepImpl = vi.fn(async () => {});
		const probeFn = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 429,
				retryAfterMs: 17,
				error: "rate limited",
			})
			.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
			.mockResolvedValueOnce({ ok: true, name: "thread", archived: true });
		const frontierFn = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 503, error: "unavailable" })
			.mockResolvedValue({ ok: true, messageId: frontier });

		await expect(
			archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
				authority: "terminal",
				quietWindowMs: 60 * 60_000,
				nowMs: () => NOW,
				archiveFn: vi.fn().mockResolvedValue(OK_ARCHIVE),
				probeFn,
				frontierFn,
				sleepImpl,
			}),
		).resolves.toMatchObject({ archived: true, reason: "ok" });
		expect(sleepImpl).toHaveBeenNthCalledWith(1, 17);
		expect(sleepImpl).toHaveBeenNthCalledWith(2, 200);
	});

	it("FLY-2028: archives again after a new session reactivates the thread", async () => {
		let current = NOW;
		let discordArchived = false;
		let frontier = snowflakeAt(current - 2 * 60 * 60_000);
		const archiveFn = vi.fn(async () => {
			discordArchived = true;
			return OK_ARCHIVE;
		});
		const deps = {
			authority: "terminal" as const,
			quietWindowMs: 60 * 60_000,
			nowMs: () => current,
			archiveFn,
			probeFn: vi.fn(async () => ({
				ok: true as const,
				name: "thread",
				archived: discordArchived,
			})),
			frontierFn: vi.fn(async () => ({
				ok: true as const,
				messageId: frontier,
			})),
		};

		await expect(
			archiveThreadAndRecord(store, INPUT, "tok-tadashi", deps),
		).resolves.toMatchObject({ archived: true, reason: "ok" });
		expect(store.getChatThreadArchivedAt("t-1")).not.toBeNull();

		discordArchived = false;
		await expect(
			reactivateChatThreadForStartedSession(
				store,
				{ ...INPUT, executionId: "exec-2" },
				"tok-tadashi",
			),
		).resolves.toBe(true);
		expect(store.getChatThreadArchivedAt("t-1")).toBeNull();

		current += 4 * 60 * 60_000;
		frontier = snowflakeAt(current - 2 * 60 * 60_000);
		await expect(
			archiveThreadAndRecord(
				store,
				{ ...INPUT, executionId: "exec-2" },
				"tok-tadashi",
				deps,
			),
		).resolves.toMatchObject({ archived: true, reason: "ok" });

		expect(archiveFn).toHaveBeenCalledTimes(2);
		const archivedEvents = [
			...store.getEventsByExecution("exec-1"),
			...store.getEventsByExecution("exec-2"),
		].filter((event) => event.event_type === "chat_thread_archived");
		expect(archivedEvents).toHaveLength(2);
		expect(new Set(archivedEvents.map(({ event_id }) => event_id)).size).toBe(
			2,
		);
	});

	it("FLY-2028: first-archive probe converges a Discord 404 as missing", async () => {
		const archiveFn = vi.fn();
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			archiveFn,
			probeFn: vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
				error: "Discord 404",
			}),
		});

		expect(result).toMatchObject({
			archived: false,
			status: 404,
			reason: "missing",
		});
		expect(archiveFn).not.toHaveBeenCalled();
		expect(store.getUnarchivedIssueChatThreads()).toEqual([]);
	});

	it("FLY-2028: first-archive probe atomically records an externally archived thread", async () => {
		const archiveFn = vi.fn();
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			archiveFn,
			probeFn: vi
				.fn()
				.mockResolvedValue({ ok: true, name: "thread", archived: true }),
		});

		expect(result).toEqual({
			archived: true,
			attempts: 0,
			reason: "already_archived",
		});
		expect(archiveFn).not.toHaveBeenCalled();
		expect(store.getChatThreadArchivedAt("t-1")).not.toBeNull();
		const events = store.getEventsByExecution("exec-1");
		expect(events).toHaveLength(1);
		expect(events[0]?.event_id).toContain("chat-thread-archive-skip-fly1709-");
	});

	it("FLY-2028: first-archive probe fails closed when archive state is absent", async () => {
		const archiveFn = vi.fn();
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			archiveFn,
			probeFn: vi.fn().mockResolvedValue({ ok: true, name: "thread" }),
		});

		expect(result).toMatchObject({
			archived: false,
			reason: "reopen_check_failed",
			error: "Discord archive state is missing",
		});
		expect(archiveFn).not.toHaveBeenCalled();
		expect(store.getChatThreadArchivedAt("t-1")).toBeNull();
	});

	it("FLY-2028: an uncertain first-archive failure compensates when Discord is archived", async () => {
		const frontier = snowflakeAt(NOW - 2 * 60 * 60_000);
		const unarchiveFn = vi
			.fn()
			.mockResolvedValue({ unarchived: true, attempts: 1, status: 200 });
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			nowMs: () => NOW,
			archiveFn: vi.fn().mockResolvedValue({
				archived: false,
				attempts: 3,
				status: 500,
				reason: "exhausted",
			}),
			probeFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: true })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false }),
			frontierFn: vi.fn().mockResolvedValue({ ok: true, messageId: frontier }),
			unarchiveFn,
		});

		expect(result.reason).toBe("reopen_check_failed");
		expect(unarchiveFn).toHaveBeenCalledOnce();
		expect(store.getChatThreadArchivedAt("t-1")).toBeNull();
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
	});

	it("FLY-2028: a 400 already-archived race commits when the frontier is unchanged", async () => {
		const frontier = snowflakeAt(NOW - 2 * 60 * 60_000);
		const unarchiveFn = vi.fn();
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			nowMs: () => NOW,
			archiveFn: vi.fn().mockResolvedValue({
				archived: false,
				attempts: 1,
				status: 400,
				reason: "client_error",
			}),
			probeFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: true }),
			frontierFn: vi.fn().mockResolvedValue({ ok: true, messageId: frontier }),
			unarchiveFn,
		});

		expect(result).toMatchObject({
			archived: true,
			status: 400,
			reason: "already_archived",
		});
		expect(unarchiveFn).not.toHaveBeenCalled();
		expect(store.getChatThreadArchivedAt("t-1")).not.toBeNull();
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
	});

	it("FLY-2028: a 400 race with a changed frontier compensates and defers", async () => {
		const before = snowflakeAt(NOW - 2 * 60 * 60_000);
		const after = snowflakeAt(NOW - 30 * 60_000);
		const unarchiveFn = vi
			.fn()
			.mockResolvedValue({ unarchived: true, attempts: 1, status: 200 });
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			nowMs: () => NOW,
			archiveFn: vi.fn().mockResolvedValue({
				archived: false,
				attempts: 1,
				status: 400,
				reason: "client_error",
			}),
			probeFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: true })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false }),
			frontierFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, messageId: before })
				.mockResolvedValueOnce({ ok: true, messageId: after }),
			unarchiveFn,
		});

		expect(result).toEqual({
			archived: false,
			attempts: 0,
			reason: "deferred_quiet_window",
		});
		expect(unarchiveFn).toHaveBeenCalledOnce();
		expect(store.getChatThreadArchivedAt("t-1")).toBeNull();
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
		expect(store.getEventsByExecution("exec-1")).toEqual([]);
	});

	it("FLY-2028: first automatic archive fails closed without a usable clock", async () => {
		const archiveFn = vi.fn();
		const probeFn = vi
			.fn()
			.mockResolvedValue({ ok: true, name: "thread", archived: false });

		for (const messageId of [null, "not-a-snowflake", snowflakeAt(NOW + 1)]) {
			const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
				authority: "terminal",
				nowMs: () => NOW,
				archiveFn,
				probeFn,
				frontierFn: vi.fn().mockResolvedValue({ ok: true, messageId }),
			});
			expect(result.archived).toBe(false);
			expect(result.reason).toBe(
				messageId === snowflakeAt(NOW + 1)
					? "deferred_quiet_window"
					: "reopen_check_failed",
			);
		}
		expect(archiveFn).not.toHaveBeenCalled();
		expect(store.getChatThreadArchivedAt("t-1")).toBeNull();
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
	});

	it("FLY-2028: keeps the first-archive receipt when verification is unavailable", async () => {
		const frontier = snowflakeAt(NOW - 2 * 60 * 60_000);
		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			nowMs: () => NOW,
			archiveFn: vi.fn().mockResolvedValue(OK_ARCHIVE),
			probeFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
				.mockResolvedValueOnce({ ok: false, status: 503, error: "down" }),
			frontierFn: vi.fn().mockResolvedValue({ ok: true, messageId: frontier }),
		});

		expect(result).toMatchObject({
			archived: false,
			reason: "reopen_check_failed",
			error: "down",
		});
		expect(store.getChatThreadArchivedAt("t-1")).toBeNull();
		expect(store.getChatThreadCompensationPending("t-1")).toMatchObject({
			frontier,
			cause: "unknown",
		});
	});

	it("FLY-1709: fails closed when reopened-thread authorship cannot be proven", async () => {
		store.markChatThreadArchived("t-1");
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			probeFn: vi
				.fn()
				.mockResolvedValue({ ok: true, name: "thread", archived: false }),
			classifyFn: vi
				.fn()
				.mockResolvedValue({ kind: "unknown", detail: "no history" }),
		});
		expect(res).toMatchObject({
			archived: false,
			reason: "reopen_check_failed",
		});
		expect(archiveFn).not.toHaveBeenCalled();
	});

	it("FLY-1709: re-archives a bot-only reopen only after the quiet-window double check", async () => {
		store.markChatThreadArchived("t-1");
		const frontier = snowflakeAt(NOW - 2 * 60 * 60_000);
		const previousEpoch = store.getChatThreadArchivedAt("t-1");
		await new Promise((resolve) => setTimeout(resolve, 2));
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const probeFn = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
			.mockResolvedValueOnce({ ok: true, name: "thread", archived: true });
		const frontierFn = vi
			.fn()
			.mockResolvedValue({ ok: true, messageId: frontier });
		const removeUserFn = vi.fn();

		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			removeUserFn,
			discordOwnerUserId: "owner-9",
			probeFn,
			classifyFn: vi.fn().mockResolvedValue({
				kind: "bot_only",
				frontierMessageId: frontier,
			}),
			frontierFn,
			nowMs: () => NOW,
		});

		expect(res).toMatchObject({ archived: true, reason: "ok" });
		expect(archiveFn).toHaveBeenCalledOnce();
		expect(frontierFn).toHaveBeenCalledTimes(2);
		expect(removeUserFn).not.toHaveBeenCalled();
		expect(store.getChatThreadArchivedAt("t-1")).not.toBe(previousEpoch);
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
		const success = store
			.getEventsByExecution("exec-1")
			.find((event) => event.event_type === "chat_thread_archived");
		expect(success?.event_id).toContain("chat-thread-rearchived-fly1709-");
		expect(success?.payload).toMatchObject({ reArchived: true });
	});

	it("FLY-1709: restores verified-open when a human arrives after the re-archive PATCH", async () => {
		store.markChatThreadArchived("t-1");
		const before = snowflakeAt(NOW - 2 * 60 * 60_000);
		const after = snowflakeAt(NOW - 30 * 60_000);
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const probeFn = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
			.mockResolvedValueOnce({ ok: true, name: "thread", archived: true })
			.mockResolvedValueOnce({ ok: true, name: "thread", archived: false });
		const frontierFn = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, messageId: before })
			.mockResolvedValueOnce({ ok: true, messageId: after });
		const unarchiveFn = vi
			.fn()
			.mockResolvedValue({ unarchived: true, attempts: 1, status: 200 });
		const classifyFn = vi
			.fn()
			.mockResolvedValueOnce({
				kind: "bot_only",
				frontierMessageId: before,
			})
			.mockResolvedValueOnce({ kind: "human" });

		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			probeFn,
			frontierFn,
			unarchiveFn,
			classifyFn,
			nowMs: () => NOW,
		});

		expect(res).toMatchObject({
			archived: false,
			reason: "founder_reopened",
		});
		expect(unarchiveFn).toHaveBeenCalledOnce();
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
	});

	it("FLY-2028: terminal authority defers a human message racing the re-archive PATCH without audit noise", async () => {
		store.markChatThreadArchived("t-1");
		const before = snowflakeAt(NOW - 2 * 60 * 60_000);
		const after = snowflakeAt(NOW - 30 * 60_000);
		const unarchiveFn = vi
			.fn()
			.mockResolvedValue({ unarchived: true, attempts: 1, status: 200 });

		const result = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			authority: "terminal",
			nowMs: () => NOW,
			archiveFn: vi.fn().mockResolvedValue(OK_ARCHIVE),
			probeFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: true })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false }),
			frontierFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, messageId: before })
				.mockResolvedValueOnce({ ok: true, messageId: before })
				.mockResolvedValueOnce({ ok: true, messageId: after }),
			classifyFn: vi.fn().mockResolvedValue({ kind: "human" }),
			unarchiveFn,
		});

		expect(result).toEqual({
			archived: false,
			attempts: 0,
			reason: "deferred_quiet_window",
		});
		expect(unarchiveFn).toHaveBeenCalledOnce();
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
		expect(store.getEventsByExecution("exec-1")).toEqual([]);
	});

	it("FLY-1709: keeps a durable compensation receipt when restoring open fails", async () => {
		store.markChatThreadArchived("t-1");
		const before = snowflakeAt(NOW - 2 * 60 * 60_000);
		const after = snowflakeAt(NOW - 30 * 60_000);
		const probeFn = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
			.mockResolvedValueOnce({ ok: true, name: "thread", archived: true })
			.mockResolvedValueOnce({ ok: false, status: 503, error: "down" });
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn: vi.fn().mockResolvedValue(OK_ARCHIVE),
			probeFn,
			frontierFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, messageId: before })
				.mockResolvedValueOnce({ ok: true, messageId: after }),
			unarchiveFn: vi
				.fn()
				.mockResolvedValue({ unarchived: false, attempts: 2 }),
			classifyFn: vi.fn().mockResolvedValue({
				kind: "bot_only",
				frontierMessageId: before,
			}),
			nowMs: () => NOW,
		});
		expect(res).toMatchObject({
			archived: false,
			reason: "reopen_check_failed",
		});
		expect(store.getChatThreadCompensationPending("t-1")).not.toBeNull();
	});

	it("FLY-1709: resumes a durable compensation receipt before the archived short-circuit", async () => {
		store.markChatThreadArchived("t-1");
		store.setChatThreadCompensationPending("t-1", {
			version: 1,
			state: "prepared",
			archiveEpoch: store.getChatThreadArchivedAt("t-1")!,
			frontier: "frontier-1",
			cause: "human",
			at: new Date().toISOString(),
		});
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const unarchiveFn = vi
			.fn()
			.mockResolvedValue({ unarchived: true, attempts: 1, status: 200 });
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			unarchiveFn,
			probeFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: true })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false }),
		});

		expect(res).toMatchObject({
			archived: false,
			reason: "reopen_check_failed",
		});
		expect(unarchiveFn).toHaveBeenCalledOnce();
		expect(archiveFn).not.toHaveBeenCalled();
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
	});

	it("FLY-1709: a changed pre-PATCH frontier fails closed without archiving", async () => {
		store.markChatThreadArchived("t-1");
		const before = snowflakeAt(NOW - 2 * 60 * 60_000);
		const after = snowflakeAt(NOW - 90 * 60_000);
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			probeFn: vi
				.fn()
				.mockResolvedValue({ ok: true, name: "thread", archived: false }),
			classifyFn: vi.fn().mockResolvedValue({
				kind: "bot_only",
				frontierMessageId: before,
			}),
			frontierFn: vi.fn().mockResolvedValue({ ok: true, messageId: after }),
			nowMs: () => NOW,
		});

		expect(res.reason).toBe("reopen_check_failed");
		expect(archiveFn).not.toHaveBeenCalled();
		expect(store.getChatThreadCompensationPending("t-1")).toBeNull();
	});

	it("FLY-1165: concurrent double-call on the same thread serializes — archiveFn exactly once, loser gets already_archived", async () => {
		let release: (v: ArchiveChatThreadResult) => void = () => {};
		const gate = new Promise<ArchiveChatThreadResult>((resolve) => {
			release = resolve;
		});
		const archiveFn = vi.fn().mockImplementation(() => gate);
		const p1 = archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			quietWindowMs: 0,
		});
		const p2 = archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			probeFn: vi
				.fn()
				.mockResolvedValue({ ok: true, name: "thread", archived: true }),
		});
		// Let p1 enter its critical section, then release the in-flight PATCH.
		await new Promise((r) => setTimeout(r, 0));
		release(OK_ARCHIVE);
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(archiveFn).toHaveBeenCalledTimes(1);
		expect(r1.archived).toBe(true);
		// The loser performs a fresh Discord GET; verified archived is truthful
		// success even though this invocation did not issue the PATCH.
		expect(r2.archived).toBe(true);
		expect(r2.reason).toBe("already_archived");
	});

	it("FLY-1165: a rejected predecessor does not poison the per-thread lock (Codex R3 #1) and never-throws holds", async () => {
		const archiveFn = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(OK_ARCHIVE);
		const r1 = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			quietWindowMs: 0,
		});
		expect(r1.archived).toBe(false); // never-throws: exception → structured failure
		const r2 = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			quietWindowMs: 0,
		});
		expect(r2.archived).toBe(true);
		expect(archiveFn).toHaveBeenCalledTimes(2);
	});

	it("FLY-1165 (Codex code R2 LOW): a thrown null does not break never-throws", async () => {
		const archiveFn = vi.fn().mockRejectedValue(null);
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			quietWindowMs: 0,
		});
		expect(res.archived).toBe(false);
		expect(res.reason).toBe("error");
	});

	it("FLY-1165 (Codex code R1 #2): a throwing seam is AUDITED, not silently swallowed", async () => {
		const archiveFn = vi.fn().mockRejectedValue(new Error("store exploded"));
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			quietWindowMs: 0,
		});
		expect(res.archived).toBe(false);
		expect(res.error).toContain("store exploded");
		const events = store.getEventsByExecution("exec-1");
		const failedEvent = events.find(
			(e) => e.event_type === "chat_thread_archive_failed",
		);
		expect(failedEvent).toBeTruthy();
		expect((failedEvent?.payload as { error?: string })?.error).toContain(
			"store exploded",
		);
	});

	it("FLY-1709: failed session-start compensation preserves the receipt and epoch", async () => {
		store.markChatThreadArchived("t-1");
		const archivedAt = store.getChatThreadArchivedAt("t-1")!;
		store.setChatThreadCompensationPending("t-1", {
			version: 1,
			state: "prepared",
			archiveEpoch: archivedAt,
			frontier: "123",
			cause: "verify_failed",
			at: new Date().toISOString(),
		});
		const probeFn = vi
			.fn()
			.mockResolvedValue({ ok: true, name: "thread", archived: true });

		await expect(
			reactivateChatThreadForStartedSession(store, INPUT, "tok-tadashi", {
				probeFn,
				unarchiveFn: vi.fn().mockResolvedValue({
					unarchived: false,
					attempts: 2,
					status: 503,
				}),
			}),
		).resolves.toBe(false);
		expect(store.getChatThreadArchivedAt("t-1")).toBe(archivedAt);
		expect(store.getChatThreadCompensationPending("t-1")).not.toBeNull();
		expect(probeFn).toHaveBeenCalledTimes(2);
	});

	it("FLY-1709: queued session-start reactivation clears the epoch committed ahead of it", async () => {
		store.markChatThreadArchived("t-1");
		let release!: () => void;
		let entered!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releasePromise = new Promise<void>((resolve) => {
			release = resolve;
		});
		const archiveCommit = runUnderThreadArchiveLock("t-1", async () => {
			store.markChatThreadArchived("t-1");
			entered();
			await releasePromise;
		});
		await enteredPromise;

		let reactivationSettled = false;
		const reactivation = reactivateChatThreadForStartedSession(
			store,
			INPUT,
			"tok-tadashi",
		).then((result) => {
			reactivationSettled = true;
			return result;
		});
		await Promise.resolve();
		expect(reactivationSettled).toBe(false);

		release();
		await archiveCommit;
		await expect(reactivation).resolves.toBe(true);
		expect(store.getChatThreadArchivedAt("t-1")).toBeNull();
	});
});

describe("FLY-1709 reopen-veto policy", () => {
	const empty = { sessions: [], claims: [] };

	it("parses ISO epochs as points and legacy epochs as second-wide intervals", () => {
		expect(archiveEpochInterval("2026-08-12T12:00:00.123Z")).toEqual({
			startMs: Date.parse("2026-08-12T12:00:00.123Z"),
			endMs: Date.parse("2026-08-12T12:00:00.123Z"),
		});
		const legacy = archiveEpochInterval("2026-08-12 12:00:00")!;
		expect(legacy.endMs - legacy.startMs).toBe(1_000);
		expect(archiveEpochInterval("2026-08-12 12:00:00.417")).toEqual({
			startMs: Date.parse("2026-08-12T12:00:00.417Z"),
			endMs: Date.parse("2026-08-12T12:00:00.417Z"),
		});
	});

	it("temporarily vetoes a fresh post-epoch admission without probing", async () => {
		const now = Date.parse("2026-08-12T12:04:00.000Z");
		const lookup = vi.fn();
		const hit = await resolveReopenVeto(
			{
				sessions: [
					{
						executionId: "exec-new",
						startedAt: new Date(now - 60_000).toISOString(),
						status: "running",
						projectName: "Flywheel",
					},
				],
				claims: [],
			},
			"2026-08-12T12:00:00.000Z",
			{ nowMs: () => now, targetLookupFn: lookup },
		);
		expect(hit).toEqual({ executionId: "exec-new" });
		expect(lookup).not.toHaveBeenCalled();
	});

	it("vetoes a genuinely live pre-epoch runner but ignores a dead husk", async () => {
		const candidate = {
			sessions: [
				{
					executionId: "exec-old",
					startedAt: "2026-08-12T11:00:00.000Z",
					status: "awaiting_review",
					projectName: "Flywheel",
				},
			],
			claims: [],
		};
		const targetLookupFn = vi.fn(() => ({
			kind: "found" as const,
			target: { tmuxWindow: "fw:@1", sessionName: "fw" },
		}));
		expect(
			await resolveReopenVeto(candidate, "2026-08-12T12:00:00.000Z", {
				targetLookupFn,
				livenessProbeFn: vi.fn(async () => "alive"),
			}),
		).toEqual({ executionId: "exec-old" });
		expect(
			await resolveReopenVeto(candidate, "2026-08-12T12:00:00.000Z", {
				targetLookupFn,
				livenessProbeFn: vi.fn(async () => "dead_pin"),
			}),
		).toBeNull();
	});

	it("does not let an expired orphan launch claim recreate the deadlock", async () => {
		const now = Date.parse("2026-08-12T13:00:00.000Z");
		expect(
			await resolveReopenVeto(
				{
					...empty,
					claims: [
						{
							executionId: "orphan",
							createdAt: "2026-08-12T12:01:00.000Z",
							updatedAt: "2026-08-12T12:01:00.000Z",
							state: "active",
							projectName: "Flywheel",
						},
					],
				},
				"2026-08-12T12:00:00.000Z",
				{ nowMs: () => now },
			),
		).toBeNull();
	});
});

describe("maybeArchiveThreadOnClose (central close cascade)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	function seedCompleted(
		execId: string,
		issueId: string,
		status = "completed",
	) {
		store.upsertSession({
			execution_id: execId,
			issue_id: issueId,
			issue_identifier: issueId,
			project_name: "Flywheel",
			status,
			issue_labels: JSON.stringify(["Flywheel"]),
		});
	}

	it("archives a Done-cleanup close (completed + no other active runner)", async () => {
		seedCompleted("exec-1", "FLY-100");
		store.upsertChatThread("t-1", "ch-eng", "FLY-100", "tadashi");
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);

		await maybeArchiveThreadOnClose(store, store.getSession("exec-1")!, {
			projects: [PROJECT],
			archiveFn,
			nowMs: () => NOW,
			probeFn: vi
				.fn()
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: false })
				.mockResolvedValueOnce({ ok: true, name: "thread", archived: true }),
			frontierFn: vi.fn().mockResolvedValue({
				ok: true,
				messageId: snowflakeAt(NOW - 2 * 60 * 60_000),
			}),
		});

		expect(archiveFn).toHaveBeenCalledWith(
			"t-1",
			"tok-tadashi",
			expect.any(Object),
		);
	});

	it("logs a quiet-window deferral from the close cascade", async () => {
		seedCompleted("exec-1", "FLY-100");
		store.upsertChatThread("t-1", "ch-eng", "FLY-100", "tadashi");
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		await maybeArchiveThreadOnClose(store, store.getSession("exec-1")!, {
			projects: [PROJECT],
			nowMs: () => NOW,
			probeFn: vi
				.fn()
				.mockResolvedValue({ ok: true, name: "thread", archived: false }),
			frontierFn: vi.fn().mockResolvedValue({
				ok: true,
				messageId: snowflakeAt(NOW - 5 * 60_000),
			}),
		});

		expect(info).toHaveBeenCalledWith(
			expect.stringContaining("archive deferred for FLY-100 (quiet window)"),
		);
		info.mockRestore();
	});

	it("does NOT archive a non-completed close (e.g. rejected/terminated)", async () => {
		seedCompleted("exec-1", "FLY-100", "rejected");
		store.upsertChatThread("t-1", "ch-eng", "FLY-100", "tadashi");
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);

		await maybeArchiveThreadOnClose(store, store.getSession("exec-1")!, {
			projects: [PROJECT],
			archiveFn,
		});

		expect(archiveFn).not.toHaveBeenCalled();
	});

	it("does NOT archive when the issue still has another active runner", async () => {
		seedCompleted("exec-1", "FLY-100"); // the one closing
		seedCompleted("exec-2", "FLY-100", "running"); // sibling still active
		store.upsertChatThread("t-1", "ch-eng", "FLY-100", "tadashi");
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);

		await maybeArchiveThreadOnClose(store, store.getSession("exec-1")!, {
			projects: [PROJECT],
			archiveFn,
		});

		expect(archiveFn).not.toHaveBeenCalled();
	});

	it("is a no-op when the issue has no registered chat thread", async () => {
		seedCompleted("exec-1", "FLY-100");
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);

		await maybeArchiveThreadOnClose(store, store.getSession("exec-1")!, {
			projects: [PROJECT],
			archiveFn,
		});

		expect(archiveFn).not.toHaveBeenCalled();
	});

	it("never throws when the archive sink fails", async () => {
		seedCompleted("exec-1", "FLY-100");
		store.upsertChatThread("t-1", "ch-eng", "FLY-100", "tadashi");
		const archiveFn = vi.fn().mockRejectedValue(new Error("boom"));

		await expect(
			maybeArchiveThreadOnClose(store, store.getSession("exec-1")!, {
				projects: [PROJECT],
				archiveFn,
			}),
		).resolves.toBeUndefined();
	});

	it("FLY-1165: close cascade respects sink-level archive-once (a re-opened thread is not re-PATCHed)", async () => {
		seedCompleted("exec-1", "FLY-100");
		store.upsertChatThread("t-1", "ch-eng", "FLY-100", "tadashi");
		// Archived once already; Annie may have re-opened it in Discord since
		// (auto-unarchive on message) — this non-authoritative cascade must not
		// fight her. Fresh terminal evidence is owned by targeted/reconcile paths.
		store.markChatThreadArchived("t-1");
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);

		await maybeArchiveThreadOnClose(store, store.getSession("exec-1")!, {
			projects: [PROJECT],
			archiveFn,
			probeFn: vi.fn().mockResolvedValue({
				ok: true,
				name: "thread",
				archived: false,
			}),
			classifyFn: vi.fn().mockResolvedValue({ kind: "human" }),
		});

		expect(archiveFn).not.toHaveBeenCalled();
	});
});
