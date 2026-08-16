/**
 * FLY-685: close-request marker for cmux workspace-pin removal.
 *
 * Problem: when `close_runner` (bridge/close-runner.ts) finishes a runner it
 * kills the tmux window + the FLY-638 `cmux-<window_name>` linked session, but
 * it runs in the Bridge (no cmux socket) so it cannot close the cmux WORKSPACE
 * pin (the left-sidebar tab). That is owned by the cmux-sync watcher
 * (`scripts/flywheel-cmux-sync.sh`). The watcher's only anchor-independent
 * backstop is the FLY-293 orphan-pin reaper, which carries a 5-minute grace —
 * so a closed runner's tab lingers up to ~5 min and the founder clears it by
 * hand.
 *
 * This module writes an explicit, authoritative "this runner is done — close
 * its pin NOW" signal: the runner's tmux `window_name` (which is also the cmux
 * workspace TITLE) appended to a line-based marker file. The watcher drains it
 * every ~15s tick and closes the matching pin through the SAME FLY-293
 * revalidating chokepoint (no grace, but it still re-verifies the window +
 * linked session are gone — so a same-title restarted runner is never
 * mis-closed).
 *
 * Contract: best-effort. It MUST NOT throw and MUST NOT block or fail the
 * close — any failure just falls back to the existing FLY-293 reaper. The file
 * path is `FLYWHEEL_CMUX_CLOSE_REQUEST_FILE`
 * (default `/tmp/flywheel-cmux-close-requested`); the watcher reads the same env.
 */

import { appendFileSync } from "node:fs";

/** Default marker path — MUST match `CLOSE_REQUEST_FILE` in flywheel-cmux-sync.sh. */
const DEFAULT_CLOSE_REQUEST_FILE = "/tmp/flywheel-cmux-close-requested";

/** Upper bound on a marker line. Real runner window names are short
 *  (`{LinearId}-claude-{slug}`); anything longer is not a legitimate title and
 *  is rejected so a corrupt/oversized value can never bloat the marker file. */
const MAX_WINDOW_NAME_LEN = 200;

/**
 * Append `windowName` to the cmux close-request marker file so the watcher
 * closes the matching workspace pin on its next tick.
 *
 * Best-effort and defensive:
 * - Rejects empty / whitespace-only / overlong names, and any name containing a
 *   newline or tab (the marker file is line-based; those would corrupt it —
 *   mirrors the watcher's own defensive input handling).
 * - Never throws: an unwritable path / disk error is swallowed (the FLY-293
 *   reaper remains the backstop).
 */
export function requestCmuxPinClose(windowName: string): void {
	const name = typeof windowName === "string" ? windowName.trim() : "";
	if (
		name.length === 0 ||
		name.length > MAX_WINDOW_NAME_LEN ||
		/[\n\r\t]/.test(name)
	) {
		return;
	}

	const file =
		process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE?.trim() ||
		DEFAULT_CLOSE_REQUEST_FILE;

	try {
		appendFileSync(file, `${name}\n`);
	} catch (err) {
		console.warn(
			`[cmux-close-request] marker write failed for "${name}": ${(err as Error).message}`,
		);
	}
}
