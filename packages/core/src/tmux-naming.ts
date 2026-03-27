/**
 * Shared tmux naming utilities (GEO-269).
 *
 * Used by Blueprint, TmuxAdapter, and run-issue.ts to ensure consistent
 * session/window naming across the Flywheel pipeline.
 */

/** Strip priority tags [P0], [P1], etc. and normalize dashes */
export function cleanIssueTitle(title: string): string {
	return title
		.replace(/\[P\d+\]\s*/gi, "")
		.replace(/\s*—\s*/g, "-")
		.trim();
}

/** Sanitize string for tmux session/window name */
export function sanitizeTmuxName(name: string, maxLen = 50): string {
	return name
		.replace(/[^a-zA-Z0-9-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/-$/, "")
		.slice(0, maxLen);
}

/** Build tmux session name: sanitized "{issueId}-{cleanTitle}" */
export function buildSessionName(issueId: string, title: string): string {
	return sanitizeTmuxName(`${issueId}-${cleanIssueTitle(title)}`);
}

/**
 * Build tmux window label: "{issueId}-{runner}-{cleanTitle}"
 *
 * Returns an unsanitized label — TmuxAdapter.sanitizeWindowName()
 * applies final sanitization before tmux new-window.
 */
export function buildWindowLabel(
	issueId: string,
	runner: string,
	title: string,
): string {
	return `${issueId}-${runner}-${cleanIssueTitle(title)}`;
}
