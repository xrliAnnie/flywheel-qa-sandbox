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
});
