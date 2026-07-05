/**
 * FLY-116: Pure helpers for Terminal.app viewer tab identity.
 *
 * Title format: flywheel:runner:<sessionName>:<projectName>:<executionId>:<windowId>[:<sessionRole>]
 *
 * - sessionName: full base tmux session (e.g. "runner-flywheel", "retry-geoforge3d") — NOT
 *                reconstructed from project name; reaper parses it from the title.
 * - projectName: project key in StateStore / commDB.
 * - executionId: per-runner UUID; survives retry as a new value.
 * - windowId:    tmux window id within the base session (e.g. "@42").
 * - sessionRole: optional, from StateStore.session_role (engineer/qa/designer).
 *
 * No external dependencies — safe to import from anywhere in the workspace.
 */

export interface ViewTitleParts {
	sessionName: string;
	projectName: string;
	executionId: string;
	windowId: string;
	sessionRole?: string;
}

/**
 * Format a unique Terminal.app custom title for the runner viewer tab.
 */
export function formatViewTitle(p: ViewTitleParts): string {
	const role = p.sessionRole ? `:${p.sessionRole}` : "";
	return `flywheel:runner:${p.sessionName}:${p.projectName}:${p.executionId}:${p.windowId}${role}`;
}

/**
 * Parse a Terminal tab custom title back into its parts. Returns null if the
 * title doesn't match the flywheel:runner: prefix and structure.
 *
 * Component constraints (matched by the regex below):
 *   - sessionName / projectName / executionId: any non-empty run of non-colon chars
 *   - windowId: must start with "@" then any non-colon chars (tmux window id format)
 *   - sessionRole: optional trailing segment after the windowId (any chars allowed,
 *                  including colons, since sessionRole is the last field)
 */
export function parseViewTitle(title: string): ViewTitleParts | null {
	const m = title.match(
		/^flywheel:runner:([^:]+):([^:]+):([^:]+):(@[^:]+)(?::(.+))?$/,
	);
	if (!m) return null;
	const sessionName = m[1];
	const projectName = m[2];
	const executionId = m[3];
	const windowId = m[4];
	if (!sessionName || !projectName || !executionId || !windowId) return null;
	return {
		sessionName,
		projectName,
		executionId,
		windowId,
		sessionRole: m[5],
	};
}
