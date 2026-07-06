/**
 * Shared constants used across Cyrus packages
 */

/**
 * Default proxy URL for Cyrus hosted services
 */
export const DEFAULT_PROXY_URL = "https://flywheel-proxy.ceedar.workers.dev";

/**
 * Default directory name for git worktrees
 */
export const DEFAULT_WORKTREES_DIR = "worktrees";

/**
 * Default base branch for new repositories
 */
export const DEFAULT_BASE_BRANCH = "main";

/**
 * Default config filename
 */
export const DEFAULT_CONFIG_FILENAME = "config.json";

/**
 * Marker directory for SessionEnd hook completion files.
 * Shared between TmuxRunner (watches), DagDispatcher (manages lifecycle),
 * and flywheel-session-end.sh (writes marker files).
 */
export const FLYWHEEL_MARKER_DIR =
	process.env.FLYWHEEL_MARKER_DIR ?? "/tmp/flywheel/sessions";
