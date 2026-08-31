import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MailboxQueue } from "../mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../mailbox-schema.js";

type PlanRow = { detail: string };

function plan(
	db: Database.Database,
	sql: string,
	...params: readonly unknown[]
): string[] {
	return (
		db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as PlanRow[]
	).map(({ detail }) => detail);
}

describe("FLY-2139 mailbox query plans", () => {
	let db: Database.Database | undefined;

	afterEach(() => db?.close());

	it("uses one named index for batch reads and their delivery fence", () => {
		db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		for (const [sql, params] of [
			[
				"SELECT * FROM mailbox WHERE batch_id = ? ORDER BY priority, seq",
				["batch-1"],
			],
			[
				"SELECT state, claimed_by FROM mailbox WHERE batch_id = ? AND recipient_kind = ? ORDER BY priority, seq",
				["batch-1", "runner"],
			],
		] as const) {
			const details = plan(db, sql, ...params);
			expect(details.join("\n")).toContain("mailbox_batch_lookup");
			expect(details).not.toContain("SCAN mailbox");
			expect(details.join("\n")).not.toContain("TEMP B-TREE");
		}

		const frozenLease = plan(
			db,
			`SELECT batch_id FROM mailbox
			  WHERE recipient_kind = ? AND carrier = 'inbox'
			    AND (? IS NULL OR to_agent = ?)
			    AND (? IS NULL OR msg_class = ?)
			    AND state = 'LEASED' AND batch_id IS NOT NULL
			    AND COALESCE(notified_at, delivered_at) IS NULL
			    AND (next_retry_at IS NULL OR next_retry_at <= ?)
			    AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at <= ?)
			  ORDER BY priority, seq LIMIT 1`,
			"runner",
			undefined,
			undefined,
			undefined,
			undefined,
			"2026-08-29T12:00:00.000Z",
			"owner",
			"2026-08-29T12:00:00.000Z",
		);
		expect(frozenLease.join("\n")).toContain("mailbox_lease_expiry_order");
		expect(frozenLease).not.toContain("SCAN mailbox");
		expect(frozenLease.join("\n")).not.toContain("TEMP B-TREE");
	});

	it("uses named indexes for retention parent-reference anti-joins", () => {
		db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const candidateDetails = plan(
			db,
			`SELECT m.seq FROM mailbox m
			  WHERE m.state IN ('ACKED','DEAD')
			    AND NOT EXISTS (SELECT 1 FROM mailbox child WHERE child.ref_id=m.id)
			    AND NOT EXISTS (SELECT 1 FROM mailbox child WHERE child.superseded_by=m.id)`,
		);
		expect(candidateDetails.join("\n")).toContain("mailbox_ref_lookup");
		expect(candidateDetails.join("\n")).toContain(
			"mailbox_superseded_by_lookup",
		);
		expect(
			candidateDetails.filter((detail) => detail.includes("SCAN child")),
		).toEqual([]);

		for (const [column, index] of [
			["ref_id", "mailbox_ref_lookup"],
			["superseded_by", "mailbox_superseded_by_lookup"],
		] as const) {
			const details = plan(
				db,
				`SELECT 1 FROM mailbox child WHERE child.${column} = ?`,
				"parent-id",
			);
			expect(details.join("\n")).toContain(index);
			expect(details.join("\n")).not.toContain("SCAN child");
		}
	});

	it("installs the index on an already-materialized writable mailbox", () => {
		db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		db.exec(`DROP INDEX mailbox_batch_lookup;
			DROP INDEX mailbox_lease_expiry_order;
			DROP INDEX mailbox_ref_lookup;
			DROP INDEX mailbox_superseded_by_lookup`);
		const queue = new MailboxQueue(db);
		expect(
			db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_batch_lookup'",
				)
				.get(),
		).toBeDefined();
		expect(
			db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_ref_lookup'",
				)
				.get(),
		).toBeDefined();
		expect(
			db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_superseded_by_lookup'",
				)
				.get(),
		).toBeDefined();
		expect(
			db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_lease_expiry_order'",
				)
				.get(),
		).toBeDefined();
		queue.close();
		db = undefined;
	});
});
