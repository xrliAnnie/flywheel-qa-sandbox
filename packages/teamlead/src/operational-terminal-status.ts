export const OPERATIONAL_TERMINAL_STATUSES = new Set([
	"completed",
	"terminated",
	"failed",
	"blocked",
	"timeout",
	"canceled",
	"cancelled",
	"rejected",
	"deferred",
	"shelved",
	"approved",
]);

export const CMUX_LIVE_SESSION_STATUSES = new Set([
	"pending",
	"running",
	"ship_parked",
	"awaiting_review",
	"design_done",
	"approved_to_ship",
]);

/**
 * Receipt-wake settlement authority is intentionally narrower than the
 * operational terminal bucket. Approval/rejection/defer/shelve are workflow
 * outcomes that can still have a live runner mailbox and therefore must not
 * authorize source-side wake disposal.
 */
export const WAKE_TERMINAL_STATUSES = new Set([
	"completed",
	"terminated",
	"failed",
	"blocked",
	"timeout",
	"canceled",
	"cancelled",
]);

export function isOperationalTerminalStatus(
	status: string | null | undefined,
): boolean {
	return (
		typeof status === "string" && OPERATIONAL_TERMINAL_STATUSES.has(status)
	);
}

export function isWakeTerminalStatus(
	status: string | null | undefined,
): boolean {
	return typeof status === "string" && WAKE_TERMINAL_STATUSES.has(status);
}
