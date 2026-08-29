import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MailboxQueue } from "../mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../mailbox-schema.js";
import { encodeSenderRef } from "../sender-ref.js";

const NOW = "2026-08-23T13:42:04.000Z";
const OWNER = "fly2008-owner";
const SENDER_REF = encodeSenderRef();

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

describe("FLY-2008 mailbox hot-path query plans", () => {
	let db: Database.Database | undefined;

	afterEach(() => db?.close());

	it("uses bounded indexes for the per-tick mailbox statements with bound parameters", () => {
		db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);

		const legacyAdopt = plan(
			db,
			`UPDATE mailbox SET recipient_kind = 'lead'
			 WHERE to_agent = ? AND type = 'instruction' AND carrier = 'inbox'
			   AND recipient_kind <> 'lead' AND batch_id IS NULL
			   AND (state = 'QUEUED' OR (state = 'LEASED' AND claimed_by = 'legacy-push'))`,
			"lead-a",
		);
		expectUses(legacyAdopt, "mailbox_legacy_adopt");
		expectNoBareMailboxScan(legacyAdopt);

		const legacyExpiry = plan(
			db,
			`SELECT id FROM mailbox
			 WHERE recipient_kind = 'lead' AND to_agent = ? AND carrier = 'inbox'
			   AND state = 'LEASED' AND claimed_by = 'legacy-push'
			   AND batch_id IS NULL AND claim_expires_at <= ?
			 ORDER BY +seq LIMIT ?`,
			"lead-a",
			NOW,
			10,
		);
		expectUses(legacyExpiry, "mailbox_lease_expiry");
		expectNoBareMailboxScan(legacyExpiry);

		const legacyRemaining = plan(
			db,
			`SELECT 1 FROM mailbox
			 WHERE recipient_kind = 'lead' AND to_agent = ? AND carrier = 'inbox'
			   AND state = 'LEASED' AND claimed_by = 'legacy-push'
			   AND batch_id IS NULL AND claim_expires_at <= ? LIMIT 1`,
			"lead-a",
			NOW,
		);
		expectUses(legacyRemaining, "mailbox_lease_expiry");
		expectNoBareMailboxScan(legacyRemaining);

		const frozenBatch = plan(
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
			"lead",
			"lead-a",
			"lead-a",
			"model",
			"model",
			NOW,
			OWNER,
			NOW,
		);
		expectUses(frozenBatch, "mailbox_lease_expiry");
		expectNoBareMailboxScan(frozenBatch);

		const leadInflight = plan(
			db,
			`SELECT COUNT(DISTINCT batch_id) AS count FROM mailbox
			 WHERE to_agent = ? AND recipient_kind = 'lead' AND carrier = 'inbox'
			   AND state = 'LEASED' AND batch_id IS NOT NULL
			   AND COALESCE(notified_at, delivered_at) IS NULL`,
			"lead-a",
		);
		expectUses(leadInflight, "mailbox_lead_reclaim");
		expectNoBareMailboxScan(leadInflight);

		const reconcileExpired = plan(
			db,
			`SELECT batch_id, MIN(seq) AS first_seq, to_agent
			 FROM mailbox
			 WHERE recipient_kind = ? AND carrier = 'inbox' AND state = 'LEASED'
			   AND batch_id IS NOT NULL AND claim_expires_at <= ?
			   AND (? IS NULL OR to_agent = ?)
			 GROUP BY batch_id, to_agent HAVING MIN(seq) > ?
			 ORDER BY first_seq LIMIT ?`,
			"lead",
			NOW,
			"lead-a",
			"lead-a",
			0,
			10,
		);
		expectUses(reconcileExpired, "mailbox_lease_expiry");
		expectNoBareMailboxScan(reconcileExpired);

		const queuedBridge = plan(
			db,
			`SELECT * FROM mailbox
			 WHERE recipient_kind = 'bridge' AND carrier = 'inbox'
			   AND from_agent = ? AND msg_class = 'protocol' AND state = 'QUEUED'
			   AND (next_retry_at IS NULL OR next_retry_at <= ?)
			 ORDER BY priority, seq LIMIT 1`,
			"runner-a",
			NOW,
		);
		expectUses(queuedBridge, "mailbox_claim_bridge");
		expectNoBareMailboxScan(queuedBridge);

		const leasedBridge = plan(
			db,
			`SELECT * FROM mailbox
			 WHERE recipient_kind = 'bridge' AND carrier = 'inbox'
			   AND from_agent = ? AND msg_class = 'protocol' AND state = 'LEASED'
			   AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)
			   AND (next_retry_at IS NULL OR next_retry_at <= ?)
			 ORDER BY priority, seq LIMIT 1`,
			"runner-a",
			OWNER,
			NOW,
			NOW,
		);
		expectUses(leasedBridge, "mailbox_bridge_reclaim");
		expectNoBareMailboxScan(leasedBridge);

		const pendingQuestions = plan(
			db,
			`SELECT q.* FROM mailbox_message_projection q
			 WHERE q.to_agent = ? AND q.type = 'question'
			   AND NOT EXISTS (
			     SELECT 1 FROM mailbox_message_projection r
			      WHERE r.parent_id = q.id AND r.type = 'response'
			   )
			   AND q.relay_state != 'terminal_disposed'
			 ORDER BY q.created_at ASC`,
			"lead-a",
		);
		expectUses(pendingQuestions, "mailbox_questions_by_recipient");
		expectNoBareMailboxScan(pendingQuestions);

		const pendingBlockingGateByRunner = plan(
			db,
			`SELECT COUNT(*) as cnt FROM mailbox_message_projection q
			 WHERE q.from_agent = ? AND q.type = 'question'
			   AND q.checkpoint IS NOT NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM mailbox_message_projection r
			      WHERE r.parent_id = q.id AND r.type = 'response'
			   )
			   AND q.relay_state != 'terminal_disposed'`,
			"runner-a",
		);
		expectUses(pendingBlockingGateByRunner, "mailbox_questions_by_sender");
		expectNoBareMailboxScan(pendingBlockingGateByRunner);

		const openGatesByRunner = plan(
			db,
			`SELECT q.* FROM mailbox_message_projection q
			 WHERE q.from_agent = ? AND q.type = 'question'
			   AND q.checkpoint IS NOT NULL
			   AND q.relay_state != 'terminal_disposed'
			   AND q.superseded_at IS NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM mailbox_message_projection response
			      WHERE response.parent_id = q.id AND response.type = 'response'
			   )
			 ORDER BY q.created_at ASC, q.id ASC`,
			"runner-a",
		);
		expectUses(openGatesByRunner, "mailbox_questions_by_sender");
		expectNoBareMailboxScan(openGatesByRunner);

		const deliverableForLead = plan(
			db,
			`SELECT COUNT(*) AS count FROM mailbox
			 WHERE carrier = 'inbox' AND state = 'QUEUED'
			   AND (next_retry_at IS NULL OR next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			   AND to_agent = ?`,
			"lead-a",
		);
		expectUses(deliverableForLead, "mailbox_deliverable_by_agent");
		expectNoBareMailboxScan(deliverableForLead);

		const deliverableAll = plan(
			db,
			`SELECT COUNT(*) AS count FROM mailbox
			 WHERE carrier = 'inbox' AND state = 'QUEUED'
			   AND (next_retry_at IS NULL OR next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
		);
		expectUses(deliverableAll, "mailbox_deliverable_by_agent");
		expectNoBareMailboxScan(deliverableAll);

		const queueHead = plan(
			db,
			`SELECT * FROM mailbox AS candidate
			 WHERE candidate.recipient_kind = ? AND candidate.carrier = 'inbox'
			   AND (? IS NULL OR candidate.to_agent = ?)
			   AND (? IS NULL OR candidate.msg_class = ?)
			   AND candidate.state = 'QUEUED' AND candidate.batch_id IS NULL
			   AND (candidate.next_retry_at IS NULL OR candidate.next_retry_at <= ?)
			   AND (? = 'lead' OR (
			     SELECT COUNT(DISTINCT active.batch_id) FROM mailbox AS active
			      WHERE active.to_agent = candidate.to_agent
			        AND active.recipient_kind = 'runner' AND active.carrier = 'inbox'
			        AND active.state = 'LEASED' AND active.delivered_at IS NOT NULL
			        AND active.claim_expires_at > ? AND active.batch_id IS NOT NULL
			   ) < ?)
			 ORDER BY candidate.priority, candidate.seq LIMIT 1`,
			"lead",
			"lead-a",
			"lead-a",
			"model",
			"model",
			NOW,
			"lead",
			NOW,
			3,
		);
		expectUses(queueHead, "mailbox_deliverable_by_agent");
		expectNoBareMailboxScan(queueHead);

		const claimRunner = plan(
			db,
			`SELECT * FROM mailbox
			 WHERE recipient_kind = 'runner' AND carrier = 'inbox'
			   AND state = 'QUEUED'
			   AND (next_retry_at IS NULL OR next_retry_at <= ?)
			 ORDER BY priority, seq LIMIT 1`,
			NOW,
		);
		expectUses(claimRunner, "mailbox_claim_runner");
		expectNoBareMailboxScan(claimRunner);

		const positiveControl = plan(
			db,
			"SELECT * FROM mailbox WHERE content LIKE ?",
			"%unindexed%",
		);
		expect(positiveControl).toContain("SCAN mailbox");
	});

	it("keeps the production methods on the indexable split-query shapes", () => {
		const source = readFileSync(
			new URL("../mailbox-queue.ts", import.meta.url),
			"utf8",
		);
		const bridgeStart = source.indexOf("\tclaimBridgeProtocol(");
		const bridgeEnd = source.indexOf(
			"\n\trecordRunnerBatchDeliveryFailure(",
			bridgeStart,
		);
		const bridgeSource = source.slice(bridgeStart, bridgeEnd);
		expect(bridgeSource).toContain("state = 'QUEUED'");
		expect(bridgeSource).toContain("state = 'LEASED'");
		expect(bridgeSource).not.toContain("state = 'QUEUED' OR");

		const countStart = source.indexOf("\tcountDeliverable(");
		const countEnd = source.indexOf("\n\tcountRunnerDeliverable(", countStart);
		const countSource = source.slice(countStart, countEnd);
		expect(countSource).toContain("toAgent === undefined");
		expect(countSource).not.toContain("? IS NULL OR to_agent = ?");

		const legacyStart = source.indexOf("\treleaseExpiredLegacyPushClaims(");
		const legacyEnd = source.indexOf(
			"\n\tlistRetiredLeadRecipients(",
			legacyStart,
		);
		expect(source.slice(legacyStart, legacyEnd)).toContain("ORDER BY +seq");
	});
});

describe("FLY-2008 mailbox query behavior equivalence", () => {
	function fixture(): { db: Database.Database; queue: MailboxQueue } {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		queue.acquireOrRenewOwner({
			ownerEpoch: OWNER,
			now: NOW,
			leaseTtlMs: 60_000,
		});
		return { db, queue };
	}

	function enqueueBridge(
		queue: MailboxQueue,
		id: string,
		priority: 0 | 1 | 2 | 3,
	): void {
		queue.enqueue({
			id,
			fromAgent: "runner-a",
			toAgent: "bridge",
			recipientKind: "bridge",
			type: "instruction",
			msgClass: "protocol",
			content: id,
			createdAt: NOW,
			priority,
			senderRef: SENDER_REF,
		});
	}

	it("claims the global (priority, seq) winner across queued and reclaimable leased rows", () => {
		const { db, queue } = fixture();
		try {
			enqueueBridge(queue, "queued", 2);
			enqueueBridge(queue, "leased-expired", 1);
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = 'old-owner',
				 claim_expires_at = '2026-08-23T13:41:00.000Z' WHERE id = ?`,
			).run("leased-expired");

			expect(
				queue.claimBridgeProtocol({
					fromAgent: "runner-a",
					ownerEpoch: OWNER,
					now: NOW,
					claimTtlMs: 30_000,
				})?.id,
			).toBe("leased-expired");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("does not steal an unexpired foreign lease or a future retry", () => {
		const { db, queue } = fixture();
		try {
			enqueueBridge(queue, "foreign-active", 0);
			enqueueBridge(queue, "future-retry", 1);
			enqueueBridge(queue, "eligible", 2);
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = 'other-owner',
				 claim_expires_at = '2026-08-23T13:43:00.000Z' WHERE id = ?`,
			).run("foreign-active");
			db.prepare(
				"UPDATE mailbox SET next_retry_at = '2026-08-23T13:43:00.000Z' WHERE id = ?",
			).run("future-retry");

			expect(
				queue.claimBridgeProtocol({
					fromAgent: "runner-a",
					ownerEpoch: OWNER,
					now: NOW,
					claimTtlMs: 30_000,
				})?.id,
			).toBe("eligible");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("preserves seq order while releasing bounded expired legacy claims", () => {
		const { db, queue } = fixture();
		try {
			for (const id of ["legacy-1", "legacy-2", "legacy-3"]) {
				queue.enqueue({
					id,
					fromAgent: "runner-a",
					toAgent: "lead-a",
					recipientKind: "lead",
					type: "instruction",
					content: id,
					createdAt: NOW,
					senderRef: SENDER_REF,
				});
			}
			db.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = 'legacy-push',
				 claim_expires_at = '2026-08-23T13:41:00.000Z'`,
			).run();

			expect(
				queue.releaseExpiredLegacyPushClaims({
					toAgent: "lead-a",
					ownerEpoch: OWNER,
					now: NOW,
					maxRows: 2,
				}),
			).toEqual({ requeued: 2, remaining: true });
			expect(
				db
					.prepare("SELECT id FROM mailbox WHERE state = 'QUEUED' ORDER BY seq")
					.all(),
			).toEqual([{ id: "legacy-1" }, { id: "legacy-2" }]);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("counts the same due rows with and without a recipient filter", () => {
		const { db, queue } = fixture();
		try {
			for (const [id, toAgent] of [
				["due-a", "lead-a"],
				["future-a", "lead-a"],
				["due-b", "lead-b"],
			] as const) {
				queue.enqueue({
					id,
					fromAgent: "runner-a",
					toAgent,
					recipientKind: "lead",
					type: "instruction",
					content: id,
					createdAt: NOW,
					senderRef: SENDER_REF,
				});
			}
			db.prepare(
				"UPDATE mailbox SET next_retry_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
			).run("future-a");

			expect(queue.countDeliverable("lead-a")).toBe(1);
			expect(queue.countDeliverable("lead-b")).toBe(1);
			expect(queue.countDeliverable()).toBe(2);
		} finally {
			queue.close();
			db.close();
		}
	});
});
