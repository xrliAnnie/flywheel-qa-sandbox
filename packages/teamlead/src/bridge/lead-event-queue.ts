/** FLY-1373 canonical StateStore lead-event → comm.db queue producer. */

import type { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import type { DurableQueueReceipt } from "./runtime-registry.js";

export function canonicalLeadEventDeliveryId(
	envelope: LeadEventEnvelope,
): string {
	const eventId = envelope.eventId?.trim() || `seq:${envelope.seq}`;
	return `lead_event:${envelope.leadId}:${eventId}`;
}

export function enqueueLeadEvent(args: {
	queue: LeadInboxQueue;
	envelope: LeadEventEnvelope;
	content: string;
}): DurableQueueReceipt {
	const { envelope } = args;
	const deliveryId = canonicalLeadEventDeliveryId(envelope);
	const executionId = envelope.event.execution_id ?? "no-exec";
	const row = args.queue.enqueue({
		id: deliveryId,
		toLead: envelope.leadId,
		source: `lead_event:${envelope.seq}`,
		type: envelope.event.event_type,
		msgClass: "model",
		priority: envelope.priority ?? 2,
		content: args.content,
		legacyAlias:
			envelope.deliveryAttemptId !== undefined
				? `${envelope.leadId}-${envelope.deliveryAttemptId}`
				: `${envelope.leadId}-${envelope.seq}-${executionId}`,
		createdAt: envelope.timestamp,
	});
	return { queued: true, deliveryId: row.id, seq: envelope.seq };
}
