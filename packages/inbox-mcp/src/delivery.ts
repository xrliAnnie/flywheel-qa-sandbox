import type { CommDB } from "flywheel-comm/db";

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
