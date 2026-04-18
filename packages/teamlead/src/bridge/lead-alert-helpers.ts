/**
 * FLY-83: helpers that glue the Bridge-side watchdog/notifier to the
 * shell-owned alert infrastructure.
 *
 * - `createClaimsReader`: reads `~/.flywheel/alerts/claims.db` (written by
 *   `scripts/lead-alert.sh`) and returns the set of eventIds claimed in the
 *   last hour. Cross-process dedup lives here: if shell already claimed an
 *   eventId, Bridge skips the Discord POST.
 * - `createBlockedMarkerReader`: lists marker files under
 *   `~/.flywheel/blocked/`. Presence means claude-lead.sh supervisor has
 *   paused this Lead; watchdog goes Silent until Annie clears the marker.
 * - `defaultLeadPaneCapture`: `tmux capture-pane` against a resolved
 *   `@windowId` for LeadWatchdog's external observation loop.
 */

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ClaimsReader } from "../LeadAlertNotifier.js";
import type { CaptureFn } from "../LeadWatchdog.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CLAIMS_DB =
	process.env.FLYWHEEL_CLAIMS_DB ??
	join(homedir(), ".flywheel", "alerts", "claims.db");
const DEFAULT_BLOCKED_DIR =
	process.env.FLYWHEEL_BLOCKED_DIR ?? join(homedir(), ".flywheel", "blocked");
const DEFAULT_TMUX_SESSION = process.env.FLYWHEEL_TMUX_SESSION ?? "flywheel";

const CLAIMS_LOOKBACK_SECONDS = 3600;

/**
 * Returns a ClaimsReader that reads eventIds claimed in the last hour from
 * `claims.db`. Missing DB / missing table → empty Set (caller treats as not
 * claimed and proceeds with Bridge-side dedup via StateStore).
 */
export function createClaimsReader(
	dbPath: string = DEFAULT_CLAIMS_DB,
): ClaimsReader {
	return async () => {
		const set = new Set<string>();
		try {
			const { stdout } = await execFileAsync(
				"sqlite3",
				[
					dbPath,
					`SELECT event_id FROM alert_claims WHERE claimed_at > strftime('%s','now') - ${CLAIMS_LOOKBACK_SECONDS};`,
				],
				{ encoding: "utf-8", timeout: 3000 },
			);
			for (const line of stdout.split("\n")) {
				const trimmed = line.trim();
				if (trimmed) set.add(trimmed);
			}
		} catch {
			// File not yet created, table missing, or sqlite3 unavailable.
			// Fall through — empty Set preserves availability over strict dedup.
		}
		return set;
	};
}

/**
 * Returns a reader that enumerates marker files (e.g.
 * `cos-lead.login_expired.flag`) for the given leadId. The returned strings
 * are the *kind* portion (`login_expired`), matching AlertEventType names
 * written by `claude-lead.sh`.
 */
export function createBlockedMarkerReader(
	dirPath: string = DEFAULT_BLOCKED_DIR,
): (leadId: string) => Promise<string[]> {
	return async (leadId) => {
		try {
			const entries = await readdir(dirPath);
			const prefix = `${leadId}.`;
			const suffix = ".flag";
			const kinds: string[] = [];
			for (const entry of entries) {
				if (entry.startsWith(prefix) && entry.endsWith(suffix)) {
					kinds.push(entry.slice(prefix.length, entry.length - suffix.length));
				}
			}
			return kinds;
		} catch {
			return [];
		}
	};
}

/**
 * Default capture function for LeadWatchdog: shell-free `tmux capture-pane`
 * keyed by a resolved `@window_id` (from `LeadWindowLocator`). Window IDs
 * are globally unique in tmux, so the session prefix is omitted; if a user
 * overrides the session via env, it's preserved for callers that want
 * name-based targeting.
 */
export function defaultLeadPaneCapture(
	session: string = DEFAULT_TMUX_SESSION,
): CaptureFn {
	return async (windowId, lines) => {
		const target = windowId.startsWith("@")
			? windowId
			: `${session}:${windowId}`;
		const { stdout } = await execFileAsync(
			"tmux",
			["capture-pane", "-t", target, "-p", "-S", `-${lines}`],
			{ encoding: "utf-8", timeout: 5000 },
		);
		return stdout;
	};
}
