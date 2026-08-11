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
	it("creates delivered_at, lease_retry_count, and the lease-expiry index for a new queue", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1573-new-schema-"));
		roots.push(root);
		const path = join(root, "comm.db");
		const queue = new MailboxQueue(path);
		queue.close();
		const db = new Database(path, { readonly: true });
		expect(columns(db)).toEqual(
			expect.arrayContaining(["delivered_at", "lease_retry_count"]),
		);
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
				expect.arrayContaining(["delivered_at", "lease_retry_count"]),
			);
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
			expect.arrayContaining(["delivered_at", "lease_retry_count"]),
		);
		db.close();
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
