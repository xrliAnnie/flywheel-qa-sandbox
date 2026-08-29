import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON,
	MailboxQueue,
} from "../mailbox-queue.js";
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

function expectUses(details: readonly string[], index: string): void {
	expect(details.join("\n")).toMatch(new RegExp(`(?:SEARCH|SCAN) .*${index}`));
}

function expectNoBareMailboxScan(details: readonly string[]): void {
	expect(details.filter((detail) => detail === "SCAN mailbox")).toEqual([]);
}

describe("FLY-2136 dead-letter query plans", () => {
	let db: Database.Database | undefined;

	afterEach(() => db?.close());

	it("keeps the per-recipient dead-letter scan on bounded partial indexes", () => {
		db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);

		const recipients = plan(
			db,
			`SELECT to_agent FROM mailbox
			  WHERE recipient_kind = 'runner' AND carrier = 'inbox' AND state = 'DEAD'
			    AND to_agent > ?
			  GROUP BY to_agent ORDER BY to_agent LIMIT ?`,
			"runner-a",
			101,
		);
		expectUses(recipients, "mailbox_dead_scan");
		expectNoBareMailboxScan(recipients);
		expect(recipients.join("\n")).not.toContain("TEMP B-TREE FOR GROUP BY");

		const latestNotice = plan(
			db,
			`SELECT id, created_at FROM mailbox
			  WHERE type = 'dead_letter_notice' AND source_kind = 'dead_letter'
			    AND source_ref = ?
			  ORDER BY seq DESC LIMIT 1`,
			"runner-a",
		);
		expectUses(latestNotice, "mailbox_dead_notice_lookup");
		expectNoBareMailboxScan(latestNotice);

		const aggregate = plan(
			db,
			`SELECT COUNT(*) AS count, MAX(seq) AS through_seq FROM mailbox
			  WHERE recipient_kind = 'runner' AND carrier = 'inbox'
			    AND state = 'DEAD' AND to_agent = ? AND seq > ?`,
			"runner-a",
			0,
		);
		expectUses(aggregate, "mailbox_dead_scan");
		expectNoBareMailboxScan(aggregate);

		const uncoveredRecipients = plan(
			db,
			`SELECT recipient_kind, to_agent FROM mailbox
			  WHERE carrier = 'inbox' AND state = 'DEAD'
			    AND dead_reason IS NOT '${FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON}'
			    AND recipient_kind IN ('lead','runner')
			  GROUP BY recipient_kind, to_agent
			  ORDER BY recipient_kind, to_agent LIMIT ?`,
			100,
		);
		expectUses(uncoveredRecipients, "mailbox_dead_scan");
		expectNoBareMailboxScan(uncoveredRecipients);
		expect(uncoveredRecipients.join("\n")).not.toContain(
			"TEMP B-TREE FOR GROUP BY",
		);
	});

	it("scans the FLY-2058 66K terminal-row shape within the Bridge tick budget", () => {
		db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		const now = "2026-08-29T01:15:00.000Z";
		const ownerEpoch = "fly2136-owner";
		queue.acquireOrRenewOwner({
			ownerEpoch,
			now,
			leaseTtlMs: 60_000,
		});

		const reserve = db.prepare(
			"INSERT INTO mailbox_identity (id, delivery_id, insert_projection_hash) VALUES (?, ?, 'seed')",
		);
		const insert = db.prepare(
			`INSERT INTO mailbox
				  (id, delivery_id, from_agent, to_agent, recipient_kind, type,
				   content, created_at, state, acked_at, dead_at, dead_reason)
				 VALUES (?, ?, 'bridge', ?, ?, 'instruction', 'seed', ?, ?, ?, ?, ?)`,
		);
		const seed = db.transaction(() => {
			for (let index = 0; index < 63_007; index += 1) {
				const id = `acked-${index}`;
				const deliveryId = `delivery-${id}`;
				reserve.run(id, deliveryId);
				insert.run(
					id,
					deliveryId,
					"lead-a",
					"lead",
					now,
					"ACKED",
					now,
					null,
					null,
				);
			}
			for (let index = 0; index < 3_212; index += 1) {
				const id = `dead-${index}`;
				const deliveryId = `delivery-${id}`;
				reserve.run(id, deliveryId);
				insert.run(
					id,
					deliveryId,
					`runner-${String(index % 50).padStart(2, "0")}`,
					"runner",
					now,
					"DEAD",
					null,
					now,
					"lease_expired_unacked",
				);
			}
		});
		seed();

		const startedAt = performance.now();
		const notices = queue.scanAndInsertDeadLetterNotices({
			ownerEpoch,
			now,
			windowMs: 1_800_000,
			maxRecipients: 100,
			maxDeadRowsPerRecipient: 20,
			maxSummaryBytes: 4_000,
			resolveOwningLead: () => "lead-a",
		});
		const alerts = queue.listUncoveredLeadDeadLetters({
			sinceCursor: [],
			limit: 100,
			maxRowsPerRecipient: 20,
			maxSummaryBytes: 4_096,
			resolveOwningLead: () => "lead-a",
		});
		const elapsedMs = performance.now() - startedAt;

		expect(notices.inserted).toHaveLength(50);
		expect(alerts).toEqual([]);
		expect(elapsedMs).toBeLessThan(500);
		queue.close();
	}, 20_000);
});
