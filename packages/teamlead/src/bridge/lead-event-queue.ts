/** FLY-1373 canonical StateStore lead-event → comm.db queue producer. */

import type { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import type { DurableQueueReceipt } from "./runtime-registry.js";

export function canonicalLeadEventDeliveryId(
	envelope: LeadEventEnvelope,
): string {
	const eventId = envelope.eventId?.trim() || `seq:${envelope.seq}`;
	return `lead_event:${envelope.leadId}:${eventId}`;
}

export function enqueueLeadEvent(args: {
	queue: MailboxQueue;
	envelope: LeadEventEnvelope;
	content: string;
}): DurableQueueReceipt {
	const { envelope } = args;
	const deliveryId = canonicalLeadEventDeliveryId(envelope);
	const materialized = args.queue.getById(deliveryId);
	if (!materialized) {
		const settlement = args.queue.inspectDeliveryState(deliveryId);
		if (settlement.kind === "archived_terminal") {
			return {
				queued: true,
				deliveryId,
				seq: envelope.seq,
				outcome: "archived",
			};
		}
	}
	const materializedContent = materialized?.content ?? args.content;
	const result = args.queue.enqueue({
		id: deliveryId,
		fromAgent: "bridge",
		toAgent: envelope.leadId,
		recipientKind: "lead",
		sourceKind: "lead_event",
		sourceRef: String(envelope.seq),
		type: envelope.event.event_type,
		msgClass: "model",
		priority: envelope.priority ?? 2,
		content: materializedContent,
		createdAt: envelope.timestamp,
		senderRef: encodeSenderRef(),
	});
	return {
		queued: true,
		deliveryId,
		seq: envelope.seq,
		outcome: result.outcome === "active" ? "active" : result.outcome,
	};
}
