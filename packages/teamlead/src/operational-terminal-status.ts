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

export function isOperationalTerminalStatus(
	status: string | null | undefined,
): boolean {
	return (
		typeof status === "string" && OPERATIONAL_TERMINAL_STATUSES.has(status)
	);
}
