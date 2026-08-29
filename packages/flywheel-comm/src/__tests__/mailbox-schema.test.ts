import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	MAILBOX_SCHEMA,
	MAILBOX_SCHEMA_GENERATION,
} from "../mailbox-schema.js";

function openMailboxDb(): Database.Database {
	const db = new Database(":memory:");
	db.exec(MAILBOX_SCHEMA);
	return db;
}

describe("FLY-1572 mailbox schema", () => {
	it("creates the shared mailbox, identity registry, append-only log, and GC outbox", () => {
		const db = openMailboxDb();
		try {
			const objects = db
				.prepare(
					"SELECT name, type FROM sqlite_master WHERE name IN ('mailbox','mailbox_identity','mailbox_log','content_ref_gc_outbox','mailbox_migration_meta','messages','lead_inbox') ORDER BY name",
				)
				.all();
			expect(objects).toEqual([
				{ name: "content_ref_gc_outbox", type: "table" },
				{ name: "lead_inbox", type: "view" },
				{ name: "mailbox", type: "table" },
				{ name: "mailbox_identity", type: "table" },
				{ name: "mailbox_log", type: "table" },
				{ name: "mailbox_migration_meta", type: "table" },
				{ name: "messages", type: "view" },
			]);
			expect(
				db
					.prepare(
						"SELECT schema_generation FROM mailbox_migration_meta WHERE singleton = 1",
					)
					.get(),
			).toEqual({ schema_generation: MAILBOX_SCHEMA_GENERATION });
		} finally {
			db.close();
		}
	});

	it("keeps the queue state machine and delivery identity in one row", () => {
		const db = openMailboxDb();
		try {
			const columns = new Map(
				(
					db.prepare("PRAGMA table_info(mailbox)").all() as Array<{
						name: string;
						notnull: number;
						dflt_value: string | null;
					}>
				).map((column) => [column.name, column]),
			);
			for (const required of [
				"id",
				"delivery_id",
				"from_agent",
				"to_agent",
				"recipient_kind",
				"type",
				"content",
				"state",
				"claimed_by",
				"claim_expires_at",
				"retry_count",
				"acked_at",
				"dead_at",
				"dead_reason",
				"priority",
				"batch_id",
				"collapse_key",
				"sender_ref",
			]) {
				expect(columns.has(required), required).toBe(true);
			}
			expect(columns.get("state")?.dflt_value).toBe("'QUEUED'");
			expect(columns.get("retry_count")?.dflt_value).toBe("0");
		} finally {
			db.close();
		}
	});

	it("creates the bounded dead-letter scan indexes for a new mailbox", () => {
		const db = openMailboxDb();
		try {
			const indexes = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('mailbox_dead_scan','mailbox_dead_notice_lookup') ORDER BY name",
				)
				.all();
			expect(indexes).toEqual([
				{ name: "mailbox_dead_notice_lookup" },
				{ name: "mailbox_dead_scan" },
			]);
		} finally {
			db.close();
		}
	});

	it("requires a live identity reservation before inserting a mailbox row", () => {
		const db = openMailboxDb();
		try {
			expect(() =>
				db
					.prepare(
						"INSERT INTO mailbox (id, delivery_id, from_agent, to_agent, recipient_kind, type, content, created_at, sender_ref) VALUES ('m1','d1','runner','lead','lead','question','hello','2026-08-05T00:00:00.000Z','{\"v\":1,\"authority\":\"unprotected\"}')",
					)
					.run(),
			).toThrow(/identity not reserved or already archived/);

			db.prepare(
				"INSERT INTO mailbox_identity (id, delivery_id, insert_projection_hash) VALUES ('m1','d1','hash')",
			).run();
			expect(() =>
				db
					.prepare(
						"INSERT INTO mailbox (id, delivery_id, from_agent, to_agent, recipient_kind, type, content, created_at, sender_ref) VALUES ('m1','d1','runner','lead','lead','question','hello','2026-08-05T00:00:00.000Z','{\"v\":1,\"authority\":\"unprotected\"}')",
					)
					.run(),
			).not.toThrow();
			db.prepare(
				"UPDATE mailbox_identity SET archived_at = '2026-08-05T01:00:00.000Z' WHERE id = 'm1'",
			).run();
			db.prepare("DELETE FROM mailbox WHERE id = 'm1'").run();
			expect(() =>
				db
					.prepare(
						"INSERT INTO mailbox (id, delivery_id, from_agent, to_agent, recipient_kind, type, content, created_at, sender_ref) VALUES ('m1','d1','runner','lead','lead','question','hello','2026-08-05T00:00:00.000Z','{\"v\":1,\"authority\":\"unprotected\"}')",
					)
					.run(),
			).toThrow(/identity not reserved or already archived/);
		} finally {
			db.close();
		}
	});

	it("makes mailbox_log append-only", () => {
		const db = openMailboxDb();
		try {
			db.prepare(
				"INSERT INTO mailbox_log (event_id, message_id, event, at, row_json) VALUES ('archived:m1','m1','archived','2026-08-05T00:00:00.000Z','{}')",
			).run();
			expect(() =>
				db
					.prepare("UPDATE mailbox_log SET row_json = '{\"changed\":true}'")
					.run(),
			).toThrow(/mailbox_log is append-only/);
			expect(() => db.prepare("DELETE FROM mailbox_log").run()).toThrow(
				/mailbox_log is append-only/,
			);
		} finally {
			db.close();
		}
	});
});
