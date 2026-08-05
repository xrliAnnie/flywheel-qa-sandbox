import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalLeadEventDeliveryId,
	enqueueLeadEvent,
} from "../lead-event-queue.js";
import type { LeadEventEnvelope } from "../lead-runtime.js";

const queues: MailboxQueue[] = [];
afterEach(() => {
	for (const queue of queues.splice(0)) queue.close();
});

function queue() {
	const value = new MailboxQueue(
		join(mkdtempSync(join(tmpdir(), "fly1373-event-queue-")), "comm.db"),
	);
	queues.push(value);
	return value;
}

function envelope(leadId: string): LeadEventEnvelope {
	return {
		seq: leadId === "lead-a" ? 1 : 2,
		eventId: "shared-event",
		event: {
			event_type: "session_completed",
			execution_id: "exec-1",
		},
		sessionKey: "exec-1",
		leadId,
		timestamp: "2026-07-19T12:00:00.000Z",
	};
}

describe("lead-event queue producer", () => {
	it("namespaces the same event id by Lead and enqueues each once", () => {
		const q = queue();
		const a = enqueueLeadEvent({
			queue: q,
			envelope: envelope("lead-a"),
			content: "A",
		});
		const b = enqueueLeadEvent({
			queue: q,
			envelope: envelope("lead-b"),
			content: "B",
		});
		expect(a.deliveryId).toBe("lead_event:lead-a:shared-event");
		expect(b.deliveryId).toBe("lead_event:lead-b:shared-event");
		expect(q.countDeliverable()).toBe(2);
		expect(
			enqueueLeadEvent({
				queue: q,
				envelope: envelope("lead-a"),
				content: "A",
			}),
		).toEqual(a);
	});

	it("falls back to durable seq for a legacy envelope without eventId", () => {
		const legacy = { ...envelope("lead-a"), eventId: undefined };
		expect(canonicalLeadEventDeliveryId(legacy)).toBe(
			"lead_event:lead-a:seq:1",
		);
	});

	it("uses producer priority and defaults an unknown event to P2", () => {
		const q = queue();
		const explicit = enqueueLeadEvent({
			queue: q,
			envelope: { ...envelope("lead-a"), priority: 3 },
			content: "explicit",
		});
		const fallback = enqueueLeadEvent({
			queue: q,
			envelope: {
				...envelope("lead-b"),
				eventId: "future-event",
				event: { event_type: "invented_later" },
			},
			content: "fallback",
		});
		expect(q.getById(explicit.deliveryId)?.priority).toBe(3);
		expect(q.getById(fallback.deliveryId)?.priority).toBe(2);
	});
});
