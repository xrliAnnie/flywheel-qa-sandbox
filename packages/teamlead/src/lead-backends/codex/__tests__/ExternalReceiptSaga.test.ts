import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalReceiptSaga } from "../ExternalReceiptSaga.js";

const queues: MailboxQueue[] = [];
afterEach(() => {
	for (const queue of queues.splice(0)) queue.close();
});

function queue(): MailboxQueue {
	const value = new MailboxQueue(
		join(mkdtempSync(join(tmpdir(), "fly1392-xdept-")), "comm.db"),
	);
	queues.push(value);
	return value;
}

describe("ExternalReceiptSaga", () => {
	it("creates one external delivery_pending row and completes accepted replays", () => {
		const receipts = queue();
		let now = "2026-07-21T12:00:00.000Z";
		const saga = new ExternalReceiptSaga({
			leadId: "lead-a",
			queue: receipts,
			journal: { getByIdempotencyKey: () => undefined },
			now: () => now,
		});
		const message = {
			messageId: "discord-1",
			channelId: "roundtable",
			content: "please coordinate",
			createdAt: "2026-07-21T11:59:00.000Z",
		};

		saga.begin(message);
		saga.begin(message);
		expect(receipts.getById("xdept:lead-a:discord-1")).toMatchObject({
			carrier: "external",
			priority: 1,
			state: "QUEUED",
			acked_at: null,
			ref_id: "discord-1",
		});
		saga.complete("discord-1");
		now = "2026-07-21T12:05:00.000Z";
		saga.complete("discord-1");
		expect(receipts.getById("xdept:lead-a:discord-1")).toMatchObject({
			state: "ACKED",
			acked_at: "2026-07-21T12:00:00.000Z",
		});
	});

	it("validates the owning Lead journal outbound mapping without a second ledger", () => {
		const receipts = queue();
		const mappings = new Map<string, { id: string }>();
		const saga = new ExternalReceiptSaga({
			leadId: "lead-a",
			queue: receipts,
			journal: {
				getByIdempotencyKey: (key) => mappings.get(key),
			},
			now: () => "2026-07-21T12:00:00.000Z",
		});
		saga.begin({
			messageId: "discord-2",
			channelId: "roundtable",
			content: "coordinate",
			createdAt: "2026-07-21T11:59:00.000Z",
		});
		saga.complete("discord-2");

		expect(() => saga.handle("discord-2", "journal-entry-2")).toThrow(
			/journal mapping is unavailable/,
		);
		expect(receipts.getById("xdept:lead-a:discord-2")?.state).toBe("ACKED");
		mappings.set("discord-2", { id: "journal-entry-other" });
		expect(() => saga.handle("discord-2", "journal-entry-2")).toThrow(
			/journal mapping mismatch/,
		);
		expect(receipts.getById("xdept:lead-a:discord-2")?.state).toBe("ACKED");

		mappings.set("discord-2", { id: "journal-entry-2" });
		saga.handle("discord-2", "journal-entry-2");
		expect(receipts.getById("xdept:lead-a:discord-2")?.state).toBe("ACKED");
	});

	it("reconciles accepted, proven-absent, and unreadable journal branches", () => {
		const receipts = queue();
		const journal = {
			getByIdempotencyKey(key: string): { id: string } | undefined {
				if (key === "100") return { id: "entry-accepted" };
				if (key === "102") throw new Error("journal unavailable");
				return undefined;
			},
		};
		const saga = new ExternalReceiptSaga({
			leadId: "lead-a",
			queue: receipts,
			journal,
			now: () => "2026-07-21T12:00:00.000Z",
		});
		for (const messageId of ["100", "101", "102"]) {
			saga.begin({
				messageId,
				channelId: "roundtable",
				content: messageId,
				createdAt: "2026-07-21T10:00:00.000Z",
			});
		}

		expect(
			saga.reconcile({
				olderThan: "2026-07-21T11:00:00.000Z",
				absenceProvenThroughMessageId: "102",
			}),
		).toEqual({ delivered: 1, aborted: 1, quarantined: 1, deferred: 0 });
		expect(receipts.getById("xdept:lead-a:100")?.acked_at).toBe(
			"2026-07-21T12:00:00.000Z",
		);
		expect(receipts.getById("xdept:lead-a:101")).toMatchObject({
			state: "DEAD",
			dead_reason: "journal_absent_after_watermark",
		});
		expect(receipts.getById("xdept:lead-a:102")).toMatchObject({
			state: "DEAD",
			dead_reason: "journal unavailable: journal unavailable",
		});
	});

	it("never reconciles another external producer lane", () => {
		const receipts = queue();
		receipts.enqueue({
			id: "chat:lead-a:100000000000000001",
			fromAgent: "founder",
			toAgent: "lead-a",
			recipientKind: "lead",
			sourceKind: "discord_chat",
			type: "external_delivery",
			msgClass: "model",
			priority: 0,
			content: "founder task",
			refId: null,
			createdAt: "2026-07-21T10:00:00.000Z",
			carrier: "external",
			senderRef: encodeSenderRef(),
		});
		const saga = new ExternalReceiptSaga({
			leadId: "lead-a",
			queue: receipts,
			journal: { getByIdempotencyKey: () => undefined },
			now: () => "2026-07-21T12:00:00.000Z",
		});

		expect(
			saga.reconcile({
				olderThan: "2026-07-21T11:00:00.000Z",
				absenceProvenThroughMessageId: "999999999999999999",
			}),
		).toEqual({ delivered: 0, aborted: 0, quarantined: 0, deferred: 0 });
		expect(receipts.getById("chat:lead-a:100000000000000001")).toMatchObject({
			state: "QUEUED",
			last_error: null,
		});
	});
});
