const VALID_ACTIONS = new Set([
	"approve",
	"reject",
	"defer",
	"retry",
	"shelve",
]);

// Issue IDs: TEAM-123, MY_PROJ-42, e2e-test-1, etc.
// Alphanumeric + hyphens/underscores, ending with a hyphen + digits
const ISSUE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*-\d+$/;

/**
 * Parse a flywheel action_id string into action + issueId.
 * Format: flywheel_{action}_{issueId}
 * Handles multi-word actions like "view_pr" and issue IDs with underscores.
 * Validates issueId matches Linear issue format (TEAM-123).
 */
export function parseActionId(
	actionId: string,
): { action: string; issueId: string } | null {
	const prefix = "flywheel_";
	if (!actionId.startsWith(prefix)) return null;
	const rest = actionId.slice(prefix.length);

	for (const action of VALID_ACTIONS) {
		if (rest.startsWith(`${action}_`)) {
			const issueId = rest.slice(action.length + 1);
			if (issueId && ISSUE_ID_PATTERN.test(issueId)) {
				return { action, issueId };
			}
		}
	}

	// Handle view_pr (two-word action)
	if (rest.startsWith("view_pr_")) {
		const issueId = rest.slice("view_pr_".length);
		if (issueId && ISSUE_ID_PATTERN.test(issueId)) {
			return { action: "view_pr", issueId };
		}
	}

	return null;
}
