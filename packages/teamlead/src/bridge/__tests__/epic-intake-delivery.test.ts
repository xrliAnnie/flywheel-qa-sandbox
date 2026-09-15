import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { formatEpicIntake } from "../hook-payload.js";
import { enqueueLeadEvent } from "../lead-event-queue.js";
import { leadEventEnvelopeFromJournalRow } from "../legacy-lead-event-reconciler.js";
import { LegacyRowPoisonError } from "../legacy-row-errors.js";

const at = "2026-09-14T20:00:00.000Z";
describe("intake journal delivery", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.recordEpicIntake({
			issueUuid: "test-uuid",
			identifier: "TEST-1",
			startedAt: at,
			intakeAt: at,
			observedAt: at,
			projectName: "test",
			leadId: "lead",
			bindingDigest: "binding",
			sourceSpanIds: ["span"],
			backfill: true,
			active: true,
			hasChildIssues: false,
		});
	});
	afterEach(() => store.close());
	it("redrives committed intake through the canonical journal and renders pending work separately from ACK", () => {
		const rows = store.listUndeliveredLeadInboxEvents({
			leadId: "lead",
			projectName: "test",
		});
		expect(rows).toHaveLength(1);
		const env = leadEventEnvelopeFromJournalRow(rows[0]);
		expect(env.eventId).toBe(`epic_intake:test-uuid:${at}`);
		const text = formatEpicIntake(env);
		expect(text).toContain("TEST-1");
		expect(text).toContain(at);
		expect(text).toContain("backfill=true");
		expect(text).toContain("ACK");
		expect(text).toContain("下一巡检周期");
		expect(
			store.listUndeliveredLeadInboxEvents({
				leadId: "other",
				projectName: "test",
			}),
		).toEqual([]);
	});
	it("rejects deterministic malformed intake as poison before runtime delivery", () => {
		store.appendLeadEvent(
			"lead",
			"bad",
			"epic_intake",
			JSON.stringify({
				event_type: "epic_intake",
				project_name: "test",
				epic_intake: {},
			}),
		);
		const row = store
			.listUndeliveredLeadInboxEvents({ leadId: "lead", projectName: "test" })
			.find((r) => r.event_id === "bad");
		expect(row).toBeDefined();
		expect(() => leadEventEnvelopeFromJournalRow(row!)).toThrow(
			LegacyRowPoisonError,
		);
		store.quarantineLegacyCutoverRow({
			seq: row!.seq,
			leadId: "lead",
			reason: "invalid_epic_intake",
			now: at,
		});
		expect(
			store
				.listUndeliveredLeadInboxEvents({ leadId: "lead", projectName: "test" })
				.map((r) => r.event_id),
		).not.toContain("bad");
	});
	it("ACKs the exact canonical delivery once without completing intake work", () => {
		const directory = mkdtempSync(join(tmpdir(), "fly2557-mailbox-"));
		let queue = new MailboxQueue(join(directory, "comm.db"));
		try {
			const row = store.listUndeliveredLeadInboxEvents({
				leadId: "lead",
				projectName: "test",
			})[0];
			const envelope = leadEventEnvelopeFromJournalRow(row);
			const receipt = enqueueLeadEvent({
				queue,
				envelope,
				content: formatEpicIntake(envelope),
			});
			expect(
				enqueueLeadEvent({ queue, envelope, content: "new render" }).deliveryId,
			).toBe(receipt.deliveryId);
			queue.close();
			queue = new MailboxQueue(join(directory, "comm.db"));
			expect(
				enqueueLeadEvent({ queue, envelope, content: "after restart" })
					.deliveryId,
			).toBe(receipt.deliveryId);
			const now = "2099-09-14T20:00:00.000Z";
			queue.acquireOrRenewOwner({
				ownerEpoch: "test-owner",
				now,
				leaseTtlMs: 30000,
			});
			const batch = queue.claimLeadBatch({
				toAgent: "lead",
				msgClass: "model",
				ownerEpoch: "test-owner",
				batchId: "test-batch",
				now,
				claimTtlMs: 30000,
			});
			expect(batch).toHaveLength(1);
			expect(() =>
				queue.ackBatchByRecipient({
					batchId: "test-batch",
					fromAgent: "wrong-lead",
					now,
				}),
			).toThrow("recipient mismatch");
			queue.ackBatchByRecipient({
				batchId: "test-batch",
				fromAgent: "lead",
				now,
			});
			expect(queue.getById(receipt.deliveryId)?.state).toBe("ACKED");
			expect(queue.getById(receipt.deliveryId)?.acked_at).toBe(now);
			expect(
				queue.ackBatchByRecipient({
					batchId: "test-batch",
					fromAgent: "lead",
					now,
				}),
			).toBe("duplicate");
			expect(store.listEpicIntakes("test")[0].workState).toBe("pending");
		} finally {
			queue.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
