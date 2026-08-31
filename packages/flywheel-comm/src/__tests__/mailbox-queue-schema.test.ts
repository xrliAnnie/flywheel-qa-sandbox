import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { ensureMailboxQueueSchema, MailboxQueue } from "../mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../mailbox-schema.js";

const roots: string[] = [];

function columns(db: Database.Database): string[] {
	return (
		db.prepare("PRAGMA table_info(mailbox)").all() as Array<{ name: string }>
	).map((row) => row.name);
}

function createLegacyMailbox(db: Database.Database): void {
	db.exec(`
		CREATE TABLE mailbox (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			state TEXT NOT NULL DEFAULT 'QUEUED',
			carrier TEXT NOT NULL DEFAULT 'inbox',
			claim_expires_at TEXT
		);
	`);
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("FLY-1573 mailbox queue schema upgrade", () => {
	it("creates delivered_at, notified_at, lease_retry_count, and the lease-expiry index for a new queue", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1573-new-schema-"));
		roots.push(root);
		const path = join(root, "comm.db");
		const queue = new MailboxQueue(path);
		queue.close();
		const db = new Database(path, { readonly: true });
		expect(columns(db)).toEqual(
			expect.arrayContaining([
				"delivered_at",
				"notified_at",
				"lease_retry_count",
			]),
		);
		expect(
			db.prepare("SELECT notified_at FROM mailbox LIMIT 1").get(),
		).toBeUndefined();
		expect(
			db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE name = 'mailbox_lease_expiry'",
				)
				.get(),
		).toBeTruthy();
		db.close();
	});

	it("upgrades a legacy caller-owned connection before any statement is prepared", () => {
		const db = new Database(":memory:");
		createLegacyMailbox(db);
		const queue = new MailboxQueue(db);
		try {
			expect(columns(db)).toEqual(
				expect.arrayContaining([
					"delivered_at",
					"notified_at",
					"lease_retry_count",
				]),
			);
			expect(
				db
					.prepare(
						"SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'mailbox_message_projection'",
					)
					.get(),
			).toBeUndefined();
			expect(
				db
					.prepare(
						"SELECT sql FROM sqlite_master WHERE name = 'mailbox_lease_expiry'",
					)
					.get(),
			).toBeTruthy();
		} finally {
			queue.close();
			db.close();
		}
	});

	it("is idempotent on one connection and safe across two opens of one legacy file", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1573-schema-"));
		roots.push(root);
		const path = join(root, "comm.db");
		const first = new Database(path);
		createLegacyMailbox(first);
		ensureMailboxQueueSchema(first);
		ensureMailboxQueueSchema(first);
		first.close();

		const second = new Database(path);
		expect(() => ensureMailboxQueueSchema(second)).not.toThrow();
		expect(
			columns(second).filter((name) => name === "delivered_at"),
		).toHaveLength(1);
		expect(
			columns(second).filter((name) => name === "lease_retry_count"),
		).toHaveLength(1);
		expect(
			columns(second).filter((name) => name === "notified_at"),
		).toHaveLength(1);
		second.close();
	});

	it("CommDB opens a new file with the upgraded schema", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1573-commdb-"));
		roots.push(root);
		const path = join(root, "comm.db");
		const comm = new CommDB(path, true, false);
		comm.close();
		const db = new Database(path, { readonly: true });
		expect(columns(db)).toEqual(
			expect.arrayContaining([
				"delivered_at",
				"notified_at",
				"lease_retry_count",
			]),
		);
		db.close();
	});

	it("adds the dead-letter scan indexes to an existing full mailbox", () => {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		db.exec(
			"DROP INDEX mailbox_dead_scan; DROP INDEX mailbox_dead_notice_lookup",
		);

		expect(() => ensureMailboxQueueSchema(db)).not.toThrow();
		const indexes = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('mailbox_dead_scan','mailbox_dead_notice_lookup') ORDER BY name",
			)
			.all();
		expect(indexes).toEqual([
			{ name: "mailbox_dead_notice_lookup" },
			{ name: "mailbox_dead_scan" },
		]);
		db.close();
	});

	it("rebuilds an old delivered-at projection and preserves legacy push transport evidence", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1773-view-upgrade-"));
		roots.push(root);
		const path = join(root, "comm.db");
		const comm = new CommDB(path, true, false);
		const id = comm.insertInstruction("bridge", "lead-a", "legacy push");
		comm.close();

		const legacy = new Database(path);
		const notifiedAt = "2099-01-01T00:00:00.000Z";
		legacy
			.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = 'legacy-push',
				 claim_expires_at = ? WHERE id = ?`,
			)
			.run(notifiedAt, id);
		legacy.exec(`
			DROP VIEW mailbox_message_projection;
			CREATE VIEW mailbox_message_projection AS
			SELECT id,
			  CASE WHEN state = 'ACKED' THEN acked_at END AS read_at,
			  CASE
			    WHEN state = 'LEASED' THEN claim_expires_at
			    WHEN state = 'ACKED' THEN acked_at
			  END AS delivered_at
			FROM mailbox;
		`);
		legacy.close();

		const upgraded = new CommDB(path, false, false);
		upgraded.close();
		const db = new Database(path, { readonly: true });
		const view = db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'mailbox_message_projection'",
			)
			.get() as { sql: string };
		expect(view.sql).toContain("mailbox_projection_delivered_on_ack_v2");
		expect(view.sql).not.toContain(
			"WHEN state = 'LEASED' THEN claim_expires_at",
		);
		expect(
			db
				.prepare(
					"SELECT mailbox.notified_at, mailbox_message_projection.delivered_at FROM mailbox_message_projection JOIN mailbox USING (id) WHERE id = ?",
				)
				.get(id),
		).toMatchObject({ notified_at: notifiedAt, delivered_at: null });
		db.close();
	});

	it("does not backfill a live pre-notify claim after the projection is already current", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1773-current-view-reopen-"));
		roots.push(root);
		const path = join(root, "comm.db");
		const first = new CommDB(path, true, false);
		const id = first.insertInstruction("bridge", "lead-a", "live claim");
		first.close();

		const raw = new Database(path);
		raw
			.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = 'legacy-push',
				 claim_expires_at = ?, notified_at = NULL WHERE id = ?`,
			)
			.run("2099-01-01T00:00:00.000Z", id);
		raw.close();

		const reopened = new CommDB(path, false, false);
		reopened.close();
		const verify = new Database(path, { readonly: true });
		expect(
			verify.prepare("SELECT notified_at FROM mailbox WHERE id = ?").get(id),
		).toEqual({ notified_at: null });
		verify.close();
	});

	it("the lease-expiry reconciliation query uses the partial expiry index", () => {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			const plan = db
				.prepare(
					`EXPLAIN QUERY PLAN
					 SELECT batch_id, MIN(seq), to_agent FROM mailbox
					  WHERE recipient_kind = ? AND carrier = 'inbox' AND state = 'LEASED'
					    AND batch_id IS NOT NULL AND claim_expires_at <= ?
					  GROUP BY batch_id, to_agent ORDER BY MIN(seq) LIMIT ?`,
				)
				.all("runner", "2099-01-01T00:00:00.000Z", 10) as Array<{
				detail: string;
			}>;
			expect(plan.map(({ detail }) => detail).join("\n")).toContain(
				"mailbox_lease_expiry",
			);
		} finally {
			queue.close();
			db.close();
		}
	});
});
