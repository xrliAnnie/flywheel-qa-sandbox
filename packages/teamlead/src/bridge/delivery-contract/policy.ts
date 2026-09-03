import type { DeliveryFamily, DeliveryStage } from "./types.js";

export const STAGE_DEADLINES_MS = {
	minted: 600_000,
	granted: 300_000,
	sent: 900_000,
	received: 1_800_000,
} as const satisfies Partial<Record<DeliveryStage, number>>;

export const SEVERE_MULTIPLIER = 3;

export const RECEIPT_CONSUMPTION_DEADLINE_FAMILIES = new Set<DeliveryFamily>([
	"launch",
	"carrier",
]);
