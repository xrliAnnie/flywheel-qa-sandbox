/**
 * FLY-109 — push delivery + ack state machine.
 *
 * Extracted from index.ts so the core logic can be unit-tested without
 * booting the MCP server. The at-least-once semantics this implements:
 *
 *   inserted → notified_at=NULL, read_at=NULL  (returned by getPendingPushInstructions)
 *   pre-notify CAS → short legacy-push transport claim
 *   notify succeeds → attempt-fenced notified_at receipt (delivered_at stays NULL)
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

export interface PendingDeliveryOptions {
	/** Flow 2 owns all Lead content while the queue is enabled. */
	queueEnabled?: boolean;
	/** Immutable timestamp for one poll pass; injectable for deterministic tests. */
	now?: string;
	transportClaimTtlMs?: number;
}

/**
 * Fetch all pending push instructions and attempt to deliver each.
 * On notifier success: record transport evidence in notified_at.
 * On notifier failure: stop the batch (preserve FIFO ordering for retry)
 * and release the fenced claim without notified_at so the next poll retries.
 */
export async function processPendingDeliveries(
	db: CommDB,
	toAgent: string,
	retryWindowSec: number,
	notify: Notifier,
	options: PendingDeliveryOptions = {},
): Promise<DeliveryResult> {
	const delivered: string[] = [];
	const failed: string[] = [];
	if (options.queueEnabled) return { delivered, failed };
	const now = options.now ?? new Date().toISOString();
	const retryCutoff = new Date(
		Date.parse(now) - retryWindowSec * 1_000,
	).toISOString();
	const pending = db.getPendingPushInstructions(
		toAgent,
		retryCutoff,
		now,
	) as DeliveryMessage[];

	for (const msg of pending) {
		const fence = db.tryClaimInstructionForPush({
			id: msg.id,
			toAgent,
			now,
			retryCutoff,
			transportClaimTtlMs: options.transportClaimTtlMs ?? 30_000,
		});
		if (!fence) continue;
		try {
			await notify(msg);
			db.recordInstructionNotified(msg.id, fence, now);
			delivered.push(msg.id);
		} catch {
			db.releaseInstructionPushClaim(msg.id, fence);
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
 *
 * Authz: ack is bound to the calling Lead's `toAgent`. A Lead cannot ack
 * another Lead's message — unknown ids from the caller's perspective return
 * the same structured error as a truly nonexistent id (no enumeration leak).
 */
export function handleAck(
	db: CommDB,
	messageId: string,
	toAgent: string,
): AckResult {
	const row = db.getMessageById(messageId);
	if (!row || row.to_agent !== toAgent || row.type !== "instruction") {
		return { ok: false, error: `unknown message_id: ${messageId}` };
	}
	db.ackInstructionRead(messageId);
	return { ok: true };
}

export type EventAckResult =
	| { ok: true; eventSeq: number }
	| { ok: false; error: string };

export type BatchAckResult =
	| { ok: true; batchId: string }
	| { ok: false; error: string };

/** Enqueue the same durable protocol row for both Lead backends. */
export function handleBatchAck(
	db: CommDB,
	input: { leadId: string; batchId: string },
): BatchAckResult {
	const batchId = input.batchId.trim();
	if (!batchId) return { ok: false, error: "batch_id is required" };
	db.insertBatchAckReceipt(input.leadId, batchId);
	return { ok: true, batchId };
}

/**
 * FLY-1279: enqueue a bearer-capability receipt for a logical Lead event.
 *
 * The MCP process is already scoped to one CommDB. The project field prevents
 * an accidental cross-project acknowledgement when a model has several Lead
 * inboxes available; authorization itself remains the per-event bearer token.
 * The result intentionally omits the token so it cannot leak through tool
 * output or logs.
 */
export function handleEventAck(
	db: CommDB,
	input: {
		leadId: string;
		eventSeq: number;
		ackToken: string;
		project: string;
		expectedProject?: string;
	},
): EventAckResult {
	if (
		input.expectedProject &&
		input.project.trim() !== input.expectedProject.trim()
	) {
		return {
			ok: false,
			error: `project mismatch: expected ${input.expectedProject}`,
		};
	}
	if (!Number.isSafeInteger(input.eventSeq) || input.eventSeq <= 0) {
		return { ok: false, error: "event_seq must be a positive safe integer" };
	}
	if (!input.ackToken.trim()) {
		return { ok: false, error: "token is required" };
	}

	db.insertAckReceipt(input.leadId, input.eventSeq, input.ackToken.trim());
	return { ok: true, eventSeq: input.eventSeq };
}
