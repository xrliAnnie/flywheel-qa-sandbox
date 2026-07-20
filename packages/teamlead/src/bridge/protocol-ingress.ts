/** FLY-1373 legacy ACK receipt materialization and typed protocol effect. */

import { CommDB } from "flywheel-comm/db";
import type {
	LeadInboxQueue,
	LeadInboxRow,
} from "flywheel-comm/lead-inbox-queue";
import type { StateStore } from "../StateStore.js";
import {
	type DeliverySecretProvider,
	deriveLeadEventAckToken,
	tokenMatches,
} from "./lead-event-delivery.js";

interface AckReceiptPayload {
	event_seq: number;
	ack_token: string;
}

interface MaterializedAckReceipt extends AckReceiptPayload {
	receipt_id: string;
	from_agent: string;
}

export interface ProtocolIngressOptions {
	queue: LeadInboxQueue;
	dbPath: string;
	store: StateStore;
	secretProvider: DeliverySecretProvider;
}

function parseReceipt(content: string): AckReceiptPayload | null {
	try {
		const parsed = JSON.parse(content) as Partial<AckReceiptPayload>;
		return Number.isSafeInteger(parsed.event_seq) &&
			(parsed.event_seq ?? 0) > 0 &&
			typeof parsed.ack_token === "string" &&
			parsed.ack_token.length > 0
			? {
					event_seq: parsed.event_seq!,
					ack_token: parsed.ack_token,
				}
			: null;
	} catch {
		return null;
	}
}

export class ProtocolIngress {
	constructor(private readonly opts: ProtocolIngressOptions) {}

	materializePending(leadId: string): number {
		const db = new CommDB(this.opts.dbPath, false);
		let count = 0;
		try {
			for (const receipt of db.getPendingAckReceipts()) {
				const payload = parseReceipt(receipt.content);
				if (!payload) continue;
				const event = this.opts.store.getLeadEventBySeq(payload.event_seq);
				if (!event) continue;
				const owner = event.ack_owner_lead_id ?? event.lead_id;
				if (owner !== leadId) continue;
				this.opts.queue.enqueue({
					id: `ack:${leadId}:${receipt.id}`,
					toLead: leadId,
					source: `ack_receipt:${receipt.id}`,
					type: "ack_receipt",
					msgClass: "protocol",
					priority: 1,
					content: JSON.stringify({
						...payload,
						receipt_id: receipt.id,
						from_agent: receipt.from_agent,
					} satisfies MaterializedAckReceipt),
					refMessageId: receipt.id,
				});
				count++;
			}
		} finally {
			db.close();
		}
		return count;
	}

	async handle(row: LeadInboxRow): Promise<{ disposition: string }> {
		if (row.msg_class !== "protocol" || row.type !== "ack_receipt") {
			throw new Error(`unsupported protocol message type: ${row.type}`);
		}
		const payload = JSON.parse(row.content) as Partial<MaterializedAckReceipt>;
		if (
			!Number.isSafeInteger(payload.event_seq) ||
			(payload.event_seq ?? 0) <= 0 ||
			typeof payload.ack_token !== "string" ||
			typeof payload.receipt_id !== "string" ||
			typeof payload.from_agent !== "string"
		) {
			throw new Error("malformed ACK receipt protocol row");
		}
		const event = this.opts.store.getLeadEventBySeq(payload.event_seq!);
		if (!event) throw new Error("ACK receipt references a missing event");
		const owner = event.ack_owner_lead_id ?? event.lead_id;
		if (owner !== row.to_lead || payload.from_agent !== owner) {
			throw new Error("ACK sender does not own the event");
		}

		if (event.ack_retired_at || event.acked_at) {
			this.consumeReceipt(payload.receipt_id);
			return {
				disposition: event.ack_retired_at
					? "legacy_ack_retired_noop"
					: "legacy_ack_duplicate",
			};
		}
		if (!event.ack_required) {
			throw new Error("ACK receipt references a non-ACK event");
		}
		const expected = deriveLeadEventAckToken(
			this.opts.secretProvider.getActive(),
			{
				eventSeq: event.seq,
				ackOwnerLeadId: owner,
				ownerEpoch: event.ack_owner_epoch ?? 0,
			},
		);
		if (!tokenMatches(payload.ack_token, expected)) {
			throw new Error("ACK token verification failed");
		}
		if (
			!this.opts.store.markLeadEventAcked(event.seq, new Date().toISOString())
		) {
			const latest = this.opts.store.getLeadEventBySeq(event.seq);
			if (!latest?.acked_at && !latest?.ack_retired_at) {
				throw new Error("ACK effect lost its state fence");
			}
		}
		this.consumeReceipt(payload.receipt_id);
		return { disposition: "legacy_ack_applied" };
	}

	private consumeReceipt(receiptId: string): void {
		const db = new CommDB(this.opts.dbPath, false);
		try {
			db.markAckReceiptConsumed(receiptId);
		} finally {
			db.close();
		}
	}
}
