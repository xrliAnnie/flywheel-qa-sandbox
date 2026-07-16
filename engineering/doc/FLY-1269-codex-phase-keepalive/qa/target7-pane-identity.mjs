/**
 * FLY-1269 — tmux pane IDENTITY probe for the 529 terminal observer.
 *
 * Extracted from target7-terminal-observer.mjs (whose top-level poll loop makes
 * it unimportable) so the identity rule is unit-testable and lives in exactly
 * one place.
 *
 * Why this exists: the observer used to ask
 *   `tmux display-message -p -t "<session>:=<window_id>" "#{window_id}"`
 * and compare the printed id. That is NOT an identity check. For an unknown or
 * DELETED target tmux resolves `-t` against the CURRENT window and still exits
 * 0 — so a deleted window printed some other live window's id and was read as
 * ALIVE. That false-alive is what kept the A7 teardown check from ever holding.
 *
 * `tmux list-panes -a` takes no `-t`, so there is no target to mis-resolve and
 * no fallback to be fooled by: a window absent from the snapshot is absent.
 */

export const PANE_FORMAT =
	"#{session_name}\t#{window_id}\t#{window_name}\t#{pane_id}";

/** Parse `list-panes -a -F PANE_FORMAT` stdout into identity tuples. */
export function parsePaneSnapshot(stdout) {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [sessionName, windowId, windowName, paneId] = line.split("\t");
			return { sessionName, windowId, windowName, paneId };
		});
}

/**
 * Normalize a spawnSync result into: identity tuples, `[]` when the server
 * provably holds no panes, or `null` when liveness is UNKNOWN.
 */
export function paneSnapshotFromResult(result) {
	if (result.status === 0) return parsePaneSnapshot(result.stdout ?? "");
	// ONLY "no server running" proves the server holds zero panes (tmux emits it
	// for ECONNREFUSED). It is required so a fully torn down server does not read
	// as "still live" forever.
	//
	// "error connecting to" must NOT be treated as proof: tmux emits it for every
	// OTHER connection failure too (e.g. Permission denied), where the server —
	// and its panes — may be very much alive. Treating that as an empty server
	// would read every window as dead = a false PASS. This mirrors the production
	// probe, which classifies EACCES as indeterminate (tmux-lookup.ts).
	if (/no server running/i.test(result.stderr ?? "")) {
		return [];
	}
	return null; // never claim an absence we cannot prove
}

/**
 * Is `windowId` present in `sessionName` per this snapshot?
 * `panes === null` (unknown) → TRUE: fail closed, so an unreadable tmux can
 * never let the observer declare a false PASS on a still-live phase.
 *
 * A missing `sessionName` THROWS rather than silently matching nothing: an
 * omitted arg would make every window read dead — a false PASS, the exact
 * failure this module exists to prevent. Fail loud, never quietly "absent".
 */
export function windowLive(windowId, panes, sessionName) {
	if (!sessionName) {
		throw new Error(
			"windowLive: sessionName is required (omitting it would read every window as dead → false PASS)",
		);
	}
	if (panes === null) return true;
	return panes.some(
		(pane) => pane.sessionName === sessionName && pane.windowId === windowId,
	);
}

/**
 * Liveness for MANY windows against one snapshot — the shape the observer
 * actually needs, so its call site cannot get `windowLive`'s arity wrong (an
 * omitted `sessionName` there read every window as dead → false PASS).
 */
export function windowLivenessMap(windowIds, panes, sessionName) {
	return Object.fromEntries(
		windowIds.map((id) => [id, windowLive(id, panes, sessionName)]),
	);
}
