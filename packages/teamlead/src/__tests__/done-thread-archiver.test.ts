/**
 * FLY-369: archive-on-close — done-thread-archiver unit tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveChatThreadResult } from "../bridge/chat-thread-utils.js";
import {
	archiveThreadAndRecord,
	maybeArchiveThreadOnClose,
	resolveBotTokenForThread,
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
			{ archiveFn },
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
			{ archiveFn },
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
			{ archiveFn, removeUserFn, discordOwnerUserId: "owner-9" },
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
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
			removeUserFn,
			discordOwnerUserId: "owner-9",
		});
		expect(res.archived).toBe(false);
		expect(res.reason).toBe("already_archived");
		expect(res.attempts).toBe(0);
		expect(archiveFn).not.toHaveBeenCalled();
		expect(removeUserFn).not.toHaveBeenCalled();
	});

	it("FLY-1165: concurrent double-call on the same thread serializes — archiveFn exactly once, loser gets already_archived", async () => {
		let release: (v: ArchiveChatThreadResult) => void = () => {};
		const gate = new Promise<ArchiveChatThreadResult>((resolve) => {
			release = resolve;
		});
		const archiveFn = vi.fn().mockImplementation(() => gate);
		const p1 = archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
		});
		const p2 = archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
		});
		// Let p1 enter its critical section, then release the in-flight PATCH.
		await new Promise((r) => setTimeout(r, 0));
		release(OK_ARCHIVE);
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(archiveFn).toHaveBeenCalledTimes(1);
		expect(r1.archived).toBe(true);
		expect(r2.archived).toBe(false);
		expect(r2.reason).toBe("already_archived");
	});

	it("FLY-1165: a rejected predecessor does not poison the per-thread lock (Codex R3 #1) and never-throws holds", async () => {
		const archiveFn = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(OK_ARCHIVE);
		const r1 = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
		});
		expect(r1.archived).toBe(false); // never-throws: exception → structured failure
		const r2 = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
		});
		expect(r2.archived).toBe(true);
		expect(archiveFn).toHaveBeenCalledTimes(2);
	});

	it("FLY-1165 (Codex code R2 LOW): a thrown null does not break never-throws", async () => {
		const archiveFn = vi.fn().mockRejectedValue(null);
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
		});
		expect(res.archived).toBe(false);
		expect(res.reason).toBe("error");
	});

	it("FLY-1165 (Codex code R1 #2): a throwing seam is AUDITED, not silently swallowed", async () => {
		const archiveFn = vi.fn().mockRejectedValue(new Error("store exploded"));
		const res = await archiveThreadAndRecord(store, INPUT, "tok-tadashi", {
			archiveFn,
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
		});

		expect(archiveFn).toHaveBeenCalledWith(
			"t-1",
			"tok-tadashi",
			expect.any(Object),
		);
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
		// (auto-unarchive on message) — the cascade must NOT fight her.
		store.markChatThreadArchived("t-1");
		const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);

		await maybeArchiveThreadOnClose(store, store.getSession("exec-1")!, {
			projects: [PROJECT],
			archiveFn,
		});

		expect(archiveFn).not.toHaveBeenCalled();
	});
});
