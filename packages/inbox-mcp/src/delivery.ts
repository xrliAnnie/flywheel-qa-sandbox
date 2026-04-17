/**
 * FLY-109 — push delivery + ack state machine.
 *
 * Extracted from index.ts so the core logic can be unit-tested without
 * booting the MCP server. The at-least-once semantics this implements:
 *
 *   inserted → delivered_at=NULL, read_at=NULL  (returned by getPendingPushInstructions)
 *   notify succeeds → markInstructionDelivered (hidden within retry window)
 *   retry window expires → re-surfaces, redelivered
 *   Lead calls flywheel_inbox_ack(message_id) → ackInstructionRead (hidden permanently)
 */
import type { CommDB } from "flywheel-comm/db";

export interface DeliveryMessage {
	id: string;
	from_agent: string;
	content: string;
	created_at: string;
}

export interface DeliveryResult {
	delivered: string[];
	failed: string[];
}

export type Notifier = (msg: DeliveryMessage) => Promise<void>;

/**
 * Fetch all pending push instructions and attempt to deliver each.
 * On notifier success: mark delivered_at.
 * On notifier failure: stop the batch (preserve FIFO ordering for retry)
 * and leave delivered_at NULL so the next poll retries immediately.
 */
export async function processPendingDeliveries(
	db: CommDB,
	toAgent: string,
	retryWindowSec: number,
	notify: Notifier,
): Promise<DeliveryResult> {
	const pending = db.getPendingPushInstructions(
		toAgent,
		retryWindowSec,
	) as DeliveryMessage[];
	const delivered: string[] = [];
	const failed: string[] = [];

	for (const msg of pending) {
		try {
			await notify(msg);
			db.markInstructionDelivered(msg.id);
			delivered.push(msg.id);
		} catch {
			failed.push(msg.id);
			break; // preserve FIFO — fail fast, retry on next poll cycle
		}
	}

	return { delivered, failed };
}

export type AckResult = { ok: true } | { ok: false; error: string };

/**
 * Idempotent ack — safe to call multiple times for the same id.
 * Returns structured error for unknown ids rather than throwing,
 * so the MCP tool handler can report it back to the Lead model.
 */
export function handleAck(db: CommDB, messageId: string): AckResult {
	const rawDb = (db as unknown as { db: { prepare: Function } }).db;
	const row = rawDb
		.prepare("SELECT id FROM messages WHERE id = ?")
		.get(messageId);
	if (!row) {
		return { ok: false, error: `unknown message_id: ${messageId}` };
	}
	db.ackInstructionRead(messageId);
	return { ok: true };
}
