import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JournalEntry } from "../LeadJournal.js";
import { SqliteJournalStore } from "../SqliteJournalStore.js";

const ROUTE = {
	kind: "roundtable_thread_from_message" as const,
	parentChannelId: "roundtable",
	sourceMessageId: "42",
	threadId: "42",
};

function entry(over: Partial<JournalEntry> = {}): JournalEntry {
	return {
		id: "id-1",
		idempotencyKey: "k1",
		source: "discord",
		payload: "p",
		state: "accepted",
		createdAt: 1,
		updatedAt: 1,
		...over,
	};
}

describe("SqliteJournalStore — replyRoute (FLY-314 Phase 2)", () => {
	let store: SqliteJournalStore;
	beforeEach(() => {
		store = new SqliteJournalStore(":memory:");
	});
	afterEach(() => store.close());

	it("round-trips replyRoute through insertAccepted → getById", () => {
		store.insertAccepted(entry({ replyRoute: ROUTE }));
		const got = store.getById("id-1");
		expect(got?.replyRoute).toEqual(ROUTE);
	});

	it("an entry with no replyRoute round-trips as undefined (byte-compat)", () => {
		store.insertAccepted(entry());
		expect(store.getById("id-1")?.replyRoute).toBeUndefined();
	});
});

describe("SqliteJournalStore — old-schema migration (Codex R3#2)", () => {
	let dir: string;
	let path: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly314-journal-"));
		path = join(dir, "journal.db");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("opens a pre-Phase-2 DB (no reply_route_json), migrates, keeps old rows valid", () => {
		// Build a pre-Phase-2 journal table WITHOUT reply_route_json + insert a row.
		const legacy = new Database(path);
		legacy.exec(`
			CREATE TABLE journal (
				id TEXT PRIMARY KEY,
				idempotency_key TEXT UNIQUE NOT NULL,
				source TEXT NOT NULL,
				payload TEXT NOT NULL,
				state TEXT NOT NULL,
				client_correlation_id TEXT,
				turn_id TEXT,
				output TEXT,
				outbox_id TEXT,
				reason TEXT,
				reply_channel_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
		legacy
			.prepare(
				`INSERT INTO journal (id, idempotency_key, source, payload, state, reply_channel_id, created_at, updated_at)
				 VALUES ('old-1','ok1','discord','p','accepted','some-chan',1,1)`,
			)
			.run();
		legacy.close();

		// Open through the current store → migrate() adds reply_route_json.
		const store = new SqliteJournalStore(path);
		const old = store.getById("old-1");
		expect(old?.replyChannelId).toBe("some-chan"); // old row still valid
		expect(old?.replyRoute).toBeUndefined(); // null route → undefined

		// New inserts can now persist a route.
		store.insertAccepted(
			entry({ id: "new-1", idempotencyKey: "nk1", replyRoute: ROUTE }),
		);
		expect(store.getById("new-1")?.replyRoute).toEqual(ROUTE);
		store.close();
	});
});
