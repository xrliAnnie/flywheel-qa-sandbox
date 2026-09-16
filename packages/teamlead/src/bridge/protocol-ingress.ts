/** FLY-1373 typed ACK receipt protocol effect. */

import {
	type MailboxQueue,
	type MailboxRow,
	parseBatchAck,
} from "flywheel-comm/mailbox-queue";
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
	queue: MailboxQueue;
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
		if (row.msg_class !== "protocol") {
			throw new Error(`unsupported protocol message type: ${row.type}`);
		}
		if (row.type === "ack_batch") {
			if (row.to_agent !== "bridge") {
				throw new Error("batch ACK must target bridge");
			}
			const batchId = parseBatchAck(row.content);
			if (!batchId) throw new Error("malformed batch ACK protocol row");
			const ack = this.opts.queue.ackBatchByRecipient({
				batchId,
				fromAgent: row.from_agent,
				now: new Date().toISOString(),
			});
			// Replay duplicates too: a crash may have committed the mailbox ACK
			// before the StateStore mirror. The original receipt timestamp is stable.
			if (ack === "applied" || ack === "duplicate") {
				for (const member of this.opts.queue.listAckedBatchLeadEvents(
					batchId,
				)) {
					if (
						member.to_agent !== row.from_agent ||
						member.type !== "summary_absorption_round" ||
						!member.acked_at
					)
						continue;
					const seq = Number(member.source_ref);
					if (
						!Number.isSafeInteger(seq) ||
						seq <= 0 ||
						String(seq) !== member.source_ref
					)
						continue;
					const event = this.opts.store.getLeadEventBySeq(seq);
					if (
						!event ||
						event.lead_id !== row.from_agent ||
						member.delivery_id !==
							`lead_event:${event.lead_id}:${event.event_id}`
					)
						continue;
					this.opts.store.markSummaryAbsorptionAcked(
						seq,
						row.from_agent,
						member.acked_at,
					);
				}
			}

			return {
				disposition:
					ack === "applied"
						? "batch_ack_applied"
						: ack === "duplicate"
							? "batch_ack_duplicate"
							: "batch_ack_late_noop",
			};
		}
		if (row.type !== "ack_receipt") {
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
