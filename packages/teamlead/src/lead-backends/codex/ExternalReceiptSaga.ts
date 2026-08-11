import type { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";

export interface ExternalReceiptMessage {
	messageId: string;
	channelId: string;
	content: string;
	createdAt: string;
}

export interface ExternalReceiptJournalLookup {
	getByIdempotencyKey(key: string): { id: string } | undefined;
}

export interface ExternalReceiptSagaOptions {
	leadId: string;
	queue: MailboxQueue;
	journal: ExternalReceiptJournalLookup;
	now?: () => string;
}

export interface ExternalReceiptReconcileResult {
	delivered: number;
	aborted: number;
	quarantined: number;
	deferred: number;
}

/**
 * FLY-1392 v2 cross-store saga. comm.db records intent before the Codex Lead
 * journal accepts; accepted-new and accepted-duplicate then converge the same
 * external row to delivered. Pending rows are never queue-carried or chased.
 */
export class ExternalReceiptSaga {
	private readonly now: () => string;

	constructor(private readonly options: ExternalReceiptSagaOptions) {
		this.now = options.now ?? (() => new Date().toISOString());
	}

	begin(message: ExternalReceiptMessage): void {
		this.options.queue.enqueue({
			id: this.receiptId(message.messageId),
			fromAgent: "discord-cross-department",
			toAgent: this.options.leadId,
			recipientKind: "lead",
			sourceKind: "discord_cross_department",
			sourceRef: message.messageId,
			type: "external_delivery",
			msgClass: "model",
			priority: 1,
			content: message.content,
			refId: message.messageId,
			createdAt: message.createdAt,
			carrier: "external",
			senderRef: encodeSenderRef(),
		});
	}

	complete(messageId: string): void {
		if (
			!this.options.queue.markExternalDelivered(
				this.receiptId(messageId),
				this.now(),
			)
		) {
			throw new Error(`external receipt completion failed for ${messageId}`);
		}
	}

	handle(messageId: string, journalEntryId: string): void {
		const accepted = this.options.journal.getByIdempotencyKey(messageId);
		if (!accepted) {
			throw new Error(
				`external receipt journal mapping is unavailable for ${messageId}`,
			);
		}
		if (accepted.id !== journalEntryId) {
			throw new Error(
				`external receipt journal mapping mismatch for ${messageId}: ${accepted.id}`,
			);
		}
	}

	reconcile(input: {
		olderThan: string;
		absenceProvenThroughMessageId: string;
		limit?: number;
	}): ExternalReceiptReconcileResult {
		const result: ExternalReceiptReconcileResult = {
			delivered: 0,
			aborted: 0,
			quarantined: 0,
			deferred: 0,
		};
		const rows = this.options.queue.listExternalPending({
			toAgent: this.options.leadId,
			idPrefix: `xdept:${this.options.leadId}:`,
			createdBefore: input.olderThan,
			...(input.limit === undefined ? {} : { limit: input.limit }),
		});
		for (const row of rows) {
			const messageId = row.ref_id;
			if (!messageId) {
				this.options.queue.markDead(
					row.id,
					this.now(),
					"external receipt is missing the journal idempotency key",
				);
				result.quarantined += 1;
				continue;
			}
			let accepted: { id: string } | undefined;
			try {
				accepted = this.options.journal.getByIdempotencyKey(messageId);
			} catch (error) {
				this.options.queue.markDead(
					row.id,
					this.now(),
					`journal unavailable: ${(error as Error).message}`,
				);
				result.quarantined += 1;
				continue;
			}
			if (accepted) {
				this.complete(messageId);
				result.delivered += 1;
				continue;
			}
			let provenAbsent = false;
			try {
				provenAbsent =
					BigInt(messageId) <= BigInt(input.absenceProvenThroughMessageId);
			} catch {
				provenAbsent = false;
			}
			if (provenAbsent) {
				this.options.queue.markDead(
					row.id,
					this.now(),
					"journal_absent_after_watermark",
				);
				result.aborted += 1;
				continue;
			}
			result.deferred += 1;
		}
		return result;
	}

	private receiptId(messageId: string): string {
		return `xdept:${this.options.leadId}:${messageId}`;
	}
}
