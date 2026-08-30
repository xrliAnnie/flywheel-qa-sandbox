import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MailboxQueue } from "../mailbox-queue.js";
import { encodeSenderRef } from "../sender-ref.js";

function enqueue(queue: MailboxQueue, id: string): void {
	queue.enqueue({
		id,
		deliveryId: `delivery:${id}`,
		fromAgent: "bridge",
		toAgent: "lead-a",
		recipientKind: "lead",
		type: "patrol_tick",
		content: "tick",
		createdAt: "2026-08-01T00:00:00.000Z",
		senderRef: encodeSenderRef(),
	});
}

describe("FLY-1687 MailboxQueue settlement reader", () => {
	it("distinguishes absent identity from every live state", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			expect(queue.inspectDeliveryState("missing")).toEqual({
				kind: "absent_identity",
			});
			enqueue(queue, "tick-1");
			expect(queue.inspectDeliveryState("delivery:tick-1")).toMatchObject({
				kind: "live",
				state: "QUEUED",
				deadReason: null,
				lastError: null,
				createdAt: "2026-08-01T00:00:00.000Z",
				deliveredAt: null,
				notifiedAt: null,
			});
			queue.ack("tick-1", "2026-08-01T01:00:00.000Z");
			expect(queue.inspectDeliveryState("tick-1")).toEqual({
				kind: "live",
				state: "ACKED",
				settledAt: "2026-08-01T01:00:00.000Z",
				deadReason: null,
				lastError: null,
				createdAt: "2026-08-01T00:00:00.000Z",
				deliveredAt: "2026-08-01T01:00:00.000Z",
				notifiedAt: null,
			});
		} finally {
			queue.close();
		}
	});

	it("restores terminal ACKED and DEAD settlement after live-row archival", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1687-settlement-"));
		const dbPath = join(root, "comm.db");
		let queue = new MailboxQueue(dbPath);
		try {
			enqueue(queue, "acked");
			queue.ack("acked", "2026-08-01T00:00:00.000Z");
			enqueue(queue, "dead");
			queue.markDead("dead", "2026-08-01T02:00:00.000Z", "test");
			expect(
				queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
			).toMatchObject({ archivedMessages: 2 });
			queue.close();
			queue = new MailboxQueue(dbPath);

			expect(queue.inspectDeliveryState("delivery:acked")).toEqual({
				kind: "archived_terminal",
				state: "ACKED",
				settledAt: "2026-08-01T00:00:00.000Z",
				deadReason: null,
				lastError: null,
				createdAt: "2026-08-01T00:00:00.000Z",
				deliveredAt: "2026-08-01T00:00:00.000Z",
				notifiedAt: null,
			});
			expect(queue.inspectDeliveryState("dead")).toEqual({
				kind: "archived_terminal",
				state: "DEAD",
				settledAt: "2026-08-01T02:00:00.000Z",
				deadReason: "test",
				lastError: "test",
				createdAt: "2026-08-01T00:00:00.000Z",
				deliveredAt: null,
				notifiedAt: null,
			});
		} finally {
			queue.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("classifies an active identity with no live row as torn", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2165-torn-settlement-"));
		const dbPath = join(root, "comm.db");
		let queue = new MailboxQueue(dbPath);
		try {
			enqueue(queue, "torn");
			queue.close();
			const raw = new Database(dbPath);
			raw.exec("DROP TRIGGER mailbox_delete_requires_archive");
			raw.prepare("DELETE FROM mailbox WHERE id = 'torn'").run();
			raw.close();
			queue = new MailboxQueue(dbPath, { readOnly: true });

			expect(queue.inspectDeliveryState("delivery:torn")).toEqual({
				kind: "torn_identity",
			});
		} finally {
			queue.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns typed evidence for an archived nonterminal row", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2165-nonterminal-settlement-"));
		const dbPath = join(root, "comm.db");
		let queue = new MailboxQueue(dbPath);
		try {
			enqueue(queue, "nonterminal");
			queue.close();
			const raw = new Database(dbPath);
			const row = raw
				.prepare("SELECT * FROM mailbox WHERE id = 'nonterminal'")
				.get();
			raw
				.prepare(
					`INSERT INTO mailbox_log
				 (event_id, message_id, event, at, row_json)
				 VALUES ('archived:nonterminal', 'nonterminal', 'archived',
				         '2026-08-01T01:00:00.000Z', ?)`,
				)
				.run(JSON.stringify(row));
			raw
				.prepare(
					"UPDATE mailbox_identity SET archived_at='2026-08-01T01:00:00.000Z' WHERE id='nonterminal'",
				)
				.run();
			raw.prepare("DELETE FROM mailbox WHERE id='nonterminal'").run();
			raw.close();
			queue = new MailboxQueue(dbPath, { readOnly: true });

			expect(queue.inspectDeliveryState("nonterminal")).toEqual({
				kind: "archived_nonterminal",
				state: "QUEUED",
				settledAt: null,
				deadReason: null,
				lastError: null,
				createdAt: "2026-08-01T00:00:00.000Z",
				deliveredAt: null,
				notifiedAt: null,
			});
		} finally {
			queue.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses log_seq to break equal archive timestamp ties", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2165-latest-settlement-"));
		const dbPath = join(root, "comm.db");
		let queue = new MailboxQueue(dbPath);
		try {
			enqueue(queue, "latest");
			queue.ack("latest", "2026-08-01T01:00:00.000Z");
			queue.close();
			const raw = new Database(dbPath);
			const row = raw.prepare("SELECT * FROM mailbox WHERE id='latest'").get();
			const insert = raw.prepare(
				`INSERT INTO mailbox_log
				 (event_id, message_id, event, at, row_json)
				 VALUES (?, 'latest', 'archived', '2026-08-01T02:00:00.000Z', ?)`,
			);
			insert.run("archived:latest:old", JSON.stringify(row));
			insert.run("archived:latest:new", "{}");
			raw
				.prepare(
					"UPDATE mailbox_identity SET archived_at='2026-08-01T02:00:00.000Z' WHERE id='latest'",
				)
				.run();
			raw.exec("DROP TRIGGER mailbox_delete_requires_archive");
			raw.prepare("DELETE FROM mailbox WHERE id='latest'").run();
			raw.close();
			queue = new MailboxQueue(dbPath, { readOnly: true });

			expect(() => queue.inspectDeliveryState("latest")).toThrow(
				/archived mailbox snapshot is not terminal/,
			);
			expect(queue.getIdentityCarrier("latest")).toBe("unknown_archived");
		} finally {
			queue.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
