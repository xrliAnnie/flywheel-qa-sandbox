import type { DeliveryFamily, DeliveryStage } from "./types.js";

export const STAGE_DEADLINES_MS = {
	minted: 600_000,
	granted: 300_000,
	sent: 900_000,
	received: 1_800_000,
} as const satisfies Partial<Record<DeliveryStage, number>>;

export const SEVERE_MULTIPLIER = 3;
export const MAX_REROUTES_PER_ROOT = 2;
export const MAILBOX_SLOT_FREEZE_AFTER_MS = 30 * 60_000;
export const TURN_WAKE_FREEZE_AFTER_MS = 20 * 60_000;
export const UNDELIVERABLE_GRACE_MS = STAGE_DEADLINES_MS.sent;
export const DELIVERY_MAINTENANCE_PAGE_SIZE = 64;

export const RECEIPT_CONSUMPTION_DEADLINE_FAMILIES = new Set<DeliveryFamily>([
	"launch",
	"carrier",
	"rework",
]);
