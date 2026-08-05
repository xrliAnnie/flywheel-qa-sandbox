/** FLY-1373 typed ACK receipt protocol effect. */

import type { MailboxRow } from "flywheel-comm/mailbox-queue";
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

export interface ProtocolIngressOptions {
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

	async handle(row: MailboxRow): Promise<{ disposition: string }> {
		if (row.msg_class !== "protocol" || row.type !== "ack_receipt") {
			throw new Error(`unsupported protocol message type: ${row.type}`);
		}
		const payload = parseReceipt(row.content);
		if (!payload) {
			throw new Error("malformed ACK receipt protocol row");
		}
		const event = this.opts.store.getLeadEventBySeq(payload.event_seq);
		if (!event) throw new Error("ACK receipt references a missing event");
		const owner = event.ack_owner_lead_id ?? event.lead_id;
		if (row.to_agent !== "bridge" || row.from_agent !== owner) {
			throw new Error("ACK sender does not own the event");
		}

		if (event.ack_retired_at || event.acked_at) {
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
		return { disposition: "legacy_ack_applied" };
	}
}
