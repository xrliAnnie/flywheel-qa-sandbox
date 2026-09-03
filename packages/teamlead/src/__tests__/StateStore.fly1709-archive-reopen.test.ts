import { describe, expect, it } from "vitest";
import {
	type SessionEvent,
	StateStore,
	type ThreadArchiveCompensationReceipt,
} from "../StateStore.js";

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

const RECEIPT: ThreadArchiveCompensationReceipt = {
	version: 1,
	state: "prepared",
	archiveEpoch: "2026-08-12T18:00:00.000Z",
	frontier: "123456789",
	cause: "unknown",
	at: "2026-08-12T18:00:01.000Z",
};

function auditEvent(eventId = "fly1709-rearchive"): SessionEvent {
	return {
		event_id: eventId,
		execution_id: "exec-1",
		issue_id: "FLY-1709",
		project_name: "flywheel",
		event_type: "chat_thread_archived",
		source: "test.fly1709",
		payload: { reArchived: true },
	};
}

describe("FLY-1709 StateStore archive epoch and compensation", () => {
	it("migrates a legacy chat_threads table idempotently", async () => {
		const fs = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = fs.mkdtempSync(join(tmpdir(), "fly1709-migration-"));
		const path = join(dir, "legacy.sqlite");
		try {
			const initSqlJs = (await import("sql.js")).default;
			const SQL = await initSqlJs();
			const seed = new SQL.Database();
			seed.run(`CREATE TABLE chat_threads (
				thread_id TEXT PRIMARY KEY,
				channel_id TEXT NOT NULL,
				issue_id TEXT,
				lead_id TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				discord_missing_at TEXT,
				archived_at TEXT
			)`);
			seed.run(
				"INSERT INTO chat_threads (thread_id, channel_id, issue_id, lead_id) VALUES (?, ?, ?, ?)",
				["legacy-1", "channel-1", "FLY-1709", "lead-1"],
			);
			fs.writeFileSync(path, Buffer.from(seed.export()));
			seed.close();

			const migrated = await StateStore.create(path);
			migrated.setChatThreadCompensationPending("legacy-1", RECEIPT);
			expect(migrated.getChatThreadCompensationPending("legacy-1")).toEqual(
				RECEIPT,
			);
			migrated.close();

			const reopened = await StateStore.create(path);
			expect(reopened.getChatThreadCompensationPending("legacy-1")).toEqual(
				RECEIPT,
			);
			reopened.close();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads, writes with ISO millisecond precision, and explicitly clears an archive epoch", async () => {
		const store = await freshStore();
		store.upsertChatThread("thread-1", "channel-1", "FLY-1709", "lead-1");
		expect(store.getChatThreadArchivedAt("thread-1")).toBeNull();

		store.markChatThreadArchived("thread-1");
		const archivedAt = store.getChatThreadArchivedAt("thread-1");
		expect(archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

		store.clearChatThreadArchived("thread-1");
		expect(store.getChatThreadArchivedAt("thread-1")).toBeNull();
		expect(store.isChatThreadArchived("thread-1")).toBe(false);
	});

	it("round-trips and clears a write-ahead compensation receipt", async () => {
		const store = await freshStore();
		store.upsertChatThread("thread-1", "channel-1", "FLY-1709", "lead-1");
		expect(store.getChatThreadCompensationPending("thread-1")).toBeNull();

		store.setChatThreadCompensationPending("thread-1", RECEIPT);
		expect(store.getChatThreadCompensationPending("thread-1")).toEqual(RECEIPT);

		store.clearChatThreadCompensationPending("thread-1");
		expect(store.getChatThreadCompensationPending("thread-1")).toBeNull();
	});

	it("treats malformed or unknown-version receipt JSON as fail-closed pending", async () => {
		const store = await freshStore();
		store.upsertChatThread("thread-1", "channel-1", "FLY-1709", "lead-1");
		const rawStore = store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		rawStore.db.run(
			"UPDATE chat_threads SET reopen_compensation_pending = ? WHERE thread_id = ?",
			["{not-json", "thread-1"],
		);
		expect(store.getChatThreadCompensationPending("thread-1")).toMatchObject({
			version: 0,
			state: "invalid",
			cause: "verify_failed",
		});

		rawStore.db.run(
			"UPDATE chat_threads SET reopen_compensation_pending = ? WHERE thread_id = ?",
			[JSON.stringify({ ...RECEIPT, version: 2 }), "thread-1"],
		);
		expect(store.getChatThreadCompensationPending("thread-1")).toMatchObject({
			version: 0,
			state: "invalid",
		});
	});

	it("atomically commits a refreshed epoch, receipt clear, and audit event", async () => {
		const store = await freshStore();
		store.upsertChatThread("thread-1", "channel-1", "FLY-1709", "lead-1");
		store.markChatThreadArchived("thread-1");
		const previousEpoch = store.getChatThreadArchivedAt("thread-1");
		store.setChatThreadCompensationPending("thread-1", RECEIPT);
		await new Promise((resolve) => setTimeout(resolve, 2));

		store.commitThreadArchive("thread-1", auditEvent());

		expect(store.getChatThreadCompensationPending("thread-1")).toBeNull();
		expect(store.getChatThreadArchivedAt("thread-1")).not.toBe(previousEpoch);
		expect(store.getEventsByExecution("exec-1")).toHaveLength(1);
	});

	it("atomically commits a first archive without an existing epoch", async () => {
		const store = await freshStore();
		store.upsertChatThread("thread-1", "channel-1", "FLY-2028", "lead-1");
		store.setChatThreadCompensationPending("thread-1", RECEIPT);

		store.commitThreadArchive("thread-1", auditEvent("fly2028-first-archive"));

		expect(store.getChatThreadArchivedAt("thread-1")).not.toBeNull();
		expect(store.getChatThreadCompensationPending("thread-1")).toBeNull();
		expect(store.getEventsByExecution("exec-1")).toHaveLength(1);
	});

	it("rolls back every re-archive field if the audit insert fails", async () => {
		const store = await freshStore();
		store.upsertChatThread("thread-1", "channel-1", "FLY-1709", "lead-1");
		store.markChatThreadArchived("thread-1");
		const previousEpoch = store.getChatThreadArchivedAt("thread-1");
		store.setChatThreadCompensationPending("thread-1", RECEIPT);
		const invalid = {
			...auditEvent(),
			event_id: null,
		} as unknown as SessionEvent;

		expect(() => store.commitThreadArchive("thread-1", invalid)).toThrow();

		expect(store.getChatThreadArchivedAt("thread-1")).toBe(previousEpoch);
		expect(store.getChatThreadCompensationPending("thread-1")).toEqual(RECEIPT);
		expect(store.getEventsByExecution("exec-1")).toEqual([]);
	});

	it("atomically clears both the archive epoch and any compensation receipt on reactivation", async () => {
		const store = await freshStore();
		store.upsertChatThread("thread-1", "channel-1", "FLY-1709", "lead-1");
		store.markChatThreadArchived("thread-1");
		store.setChatThreadCompensationPending("thread-1", RECEIPT);

		store.commitReactivation("thread-1");

		expect(store.getChatThreadArchivedAt("thread-1")).toBeNull();
		expect(store.getChatThreadCompensationPending("thread-1")).toBeNull();
	});
});

describe("FLY-1709 StateStore conclusion and reopen-veto snapshots", () => {
	it("snapshots active-status sessions and open launch claims without holding statements", async () => {
		const store = await freshStore();
		store.upsertSession({
			execution_id: "exec-live",
			issue_id: "FLY-1709",
			project_name: "flywheel",
			status: "awaiting_review",
			started_at: "2026-08-12T18:00:02.000Z",
		});
		store.upsertSession({
			execution_id: "exec-done",
			issue_id: "FLY-1709",
			project_name: "flywheel",
			status: "completed",
			started_at: "2026-08-12T17:00:00.000Z",
		});
		store.insertLaunchClaim({
			executionId: "exec-claim",
			rootUuid: "FLY-1709",
			project: "flywheel",
		});

		const candidates = store.listReopenVetoCandidates("FLY-1709");

		expect(candidates.sessions).toEqual([
			expect.objectContaining({
				executionId: "exec-live",
				status: "awaiting_review",
				startedAt: "2026-08-12T18:00:02.000Z",
			}),
		]);
		expect(candidates.claims).toEqual([
			expect.objectContaining({
				executionId: "exec-claim",
				state: "starting",
			}),
		]);
	});

	it("resolves identifier-keyed reopen checks to UUID-rooted launch claims", async () => {
		const store = await freshStore();
		const issueUuid = "11111111-1111-4111-8111-111111111111";
		store.upsertSession({
			execution_id: "exec-seed",
			issue_id: issueUuid,
			issue_identifier: "FLY-1709",
			project_name: "flywheel",
			status: "completed",
		});
		store.insertLaunchClaim({
			executionId: "exec-claim",
			rootUuid: issueUuid,
			project: "flywheel",
		});

		const candidates = store.listReopenVetoCandidates("FLY-1709");

		expect(candidates.claims).toEqual([
			expect.objectContaining({ executionId: "exec-claim" }),
		]);
	});
});
