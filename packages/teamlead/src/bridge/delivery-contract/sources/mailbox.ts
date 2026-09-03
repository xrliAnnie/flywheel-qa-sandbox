import type { RunnerDeliveryProjectionRow } from "flywheel-comm/db";
import { isWakeTerminalStatus } from "../../../operational-terminal-status.js";
import { DEFAULT_MAILBOX_QUEUE_CONFIG } from "../../mailbox-queue-config.js";
import type { DeliveryTerminal } from "../types.js";

export interface MailboxDeliveryObservation {
	terminal: DeliveryTerminal | null;
	shapeId: "mailbox_inflight_slots_exhausted" | null;
	shapeSince: string | null;
}

export function observeRunnerMailboxDelivery(
	row: RunnerDeliveryProjectionRow,
): MailboxDeliveryObservation {
	if (row.superseded_by !== null) {
		return { terminal: "superseded", shapeId: null, shapeSince: null };
	}
	if (
		row.state === "DEAD" ||
		(row.acked_at === null && isWakeTerminalStatus(row.recipient_status))
	) {
		return { terminal: "undeliverable", shapeId: null, shapeSince: null };
	}
	const oldestInflightAt = Date.parse(row.oldest_inflight_delivered_at ?? "");
	if (
		row.state === "QUEUED" &&
		row.inflight_batch_count >=
			DEFAULT_MAILBOX_QUEUE_CONFIG.inflightMaxBatches &&
		Number.isFinite(oldestInflightAt)
	) {
		return {
			terminal: null,
			shapeId: "mailbox_inflight_slots_exhausted",
			shapeSince: new Date(oldestInflightAt).toISOString(),
		};
	}
	return { terminal: null, shapeId: null, shapeSince: null };
}
