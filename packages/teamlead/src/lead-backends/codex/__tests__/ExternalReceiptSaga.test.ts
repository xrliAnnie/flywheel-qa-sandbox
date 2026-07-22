import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalReceiptSaga } from "../ExternalReceiptSaga.js";

const queues: LeadInboxQueue[] = [];
afterEach(() => {
	for (const queue of queues.splice(0)) queue.close();
});

function queue(): LeadInboxQueue {
	const value = new LeadInboxQueue(
		join(mkdtempSync(join(tmpdir(), "fly1392-xdept-")), "comm.db"),
	);
	queues.push(value);
	return value;
}

const WINDOWS = [1_800_000, 1_800_000, 14_400_000, 86_400_000] as const;

describe("ExternalReceiptSaga", () => {
	it("creates one external delivery_pending row and completes accepted replays", () => {
		const receipts = queue();
		let now = "2026-07-21T12:00:00.000Z";
		const saga = new ExternalReceiptSaga({
			leadId: "lead-a",
			queue: receipts,
			journal: { getByIdempotencyKey: () => undefined },
			receiptWindowsMs: WINDOWS,
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
			delivered_at: null,
			ref_message_id: "discord-1",
		});
		saga.complete("discord-1");
		now = "2026-07-21T12:05:00.000Z";
		saga.complete("discord-1");
		expect(receipts.getById("xdept:lead-a:discord-1")).toMatchObject({
			delivered_at: "2026-07-21T12:00:00.000Z",
			next_unprocessed_at: "2026-07-21T12:30:00.000Z",
		});
	});

	it("settles only from the owning Lead journal outbound mapping", () => {
		const receipts = queue();
		const mappings = new Map<string, { id: string }>();
		const saga = new ExternalReceiptSaga({
			leadId: "lead-a",
			queue: receipts,
			journal: {
				getByIdempotencyKey: (key) => mappings.get(key),
			},
			receiptWindowsMs: WINDOWS,
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
		expect(receipts.getById("xdept:lead-a:discord-2")?.processed_at).toBeNull();
		mappings.set("discord-2", { id: "journal-entry-other" });
		expect(() => saga.handle("discord-2", "journal-entry-2")).toThrow(
			/journal mapping mismatch/,
		);
		expect(receipts.getById("xdept:lead-a:discord-2")?.processed_at).toBeNull();

		mappings.set("discord-2", { id: "journal-entry-2" });
		saga.handle("discord-2", "journal-entry-2");
		expect(receipts.getById("xdept:lead-a:discord-2")).toMatchObject({
			processed_at: "2026-07-21T12:00:00.000Z",
		});
		expect(
			JSON.parse(
				receipts.getById("xdept:lead-a:discord-2")?.processed_evidence ?? "{}",
			),
		).toMatchObject({
			kind: "journal_outbound",
			actor: "lead-a",
			ref: "journal-entry-2",
		});
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
			receiptWindowsMs: WINDOWS,
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
		expect(receipts.getById("xdept:lead-a:100")?.delivered_at).toBe(
			"2026-07-21T12:00:00.000Z",
		);
		expect(receipts.getById("xdept:lead-a:101")?.disposition).toBe(
			"delivery_aborted",
		);
		expect(receipts.getById("xdept:lead-a:102")?.disposition).toBe(
			"delivery_quarantined",
		);
	});
});
