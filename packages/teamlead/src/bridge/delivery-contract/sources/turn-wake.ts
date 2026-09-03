import type { RunnerTurnWakeProjectionRow } from "flywheel-comm/db";
import { isWakeTerminalStatus } from "../../../operational-terminal-status.js";
import type { DeliveryTerminal } from "../types.js";

export interface TurnWakeDeliveryObservation {
	terminal: DeliveryTerminal | null;
	shapeId: "three_stage_turn_stuck" | null;
	shapeSince: string | null;
}

export function observeRunnerTurnWakeDelivery(
	row: RunnerTurnWakeProjectionRow,
): TurnWakeDeliveryObservation {
	if (row.state === "cancelled") {
		return { terminal: "cancelled", shapeId: null, shapeSince: null };
	}
	if (row.acked_at === null && isWakeTerminalStatus(row.recipient_status)) {
		return { terminal: "undeliverable", shapeId: null, shapeSince: null };
	}
	if (
		row.state === "sent" &&
		row.acked_at === null &&
		row.push_count >= 2 &&
		row.first_push_at !== null
	) {
		return {
			terminal: null,
			shapeId: "three_stage_turn_stuck",
			shapeSince: new Date(row.first_push_at).toISOString(),
		};
	}
	return { terminal: null, shapeId: null, shapeSince: null };
}
