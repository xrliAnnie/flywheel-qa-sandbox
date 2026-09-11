export const OUTCOME_STATUSES = [
	"completed",
	"approved",
	"approved_to_ship",
	"blocked",
	"failed",
	"rejected",
	"deferred",
	"shelved",
	"terminated",
] as const;

// Terminal states — monotonic progression: once terminal, cannot go back to running
// Note: approved_to_ship is NOT terminal — Runner still needs to ship
export const TERMINAL_STATUSES = new Set<string>([
	...OUTCOME_STATUSES,
	"awaiting_review",
]);
// approved_to_ship is an outcome but not terminal (Runner will transition to completed)
TERMINAL_STATUSES.delete("approved_to_ship");

/** Mailbox delivery keeps resident awaiting-review runners reachable. */
export function isMailboxTerminalStatus(status: string): boolean {
	return TERMINAL_STATUSES.has(status) && status !== "awaiting_review";
}
