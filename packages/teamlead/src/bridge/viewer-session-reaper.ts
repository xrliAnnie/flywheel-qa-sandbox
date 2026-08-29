/**
 * FLY-754: one-shot Bridge startup sweep for leaked `viewer-<execId>` tmux
 * sessions.
 *
 * Background: the FLY-116 Terminal.app viewer creates a per-runner linked
 * tmux session `viewer-<execId>` before spawning the Terminal tab. On cmux
 * hosts the tab consistently failed to materialize and the sessions leaked on
 * every dispatch (36 zombies observed in production). FLY-754 kills the
 * generation source (openTmuxViewer no longer runs on cmux); this sweep
 * migrates the existing backlog and backstops any residual leak from the
 * terminal-app path.
 *
 * Kill rules — ALL must hold (conservative, race-free):
 *   - session name is `viewer-<execId>`
 *   - 0 attached clients (someone watching → never touch)
 *   - StateStore row is in a final outcome state (approved_to_ship excluded —
 *     that Runner is alive and still has to ship), OR there is no row AND the
 *     viewer's tmux session group is one of THIS Bridge's own base sessions
 *     (`runner-<project>`). Foreign groups (e.g. QA slot Bridges sharing the
 *     tmux server) are never touched.
 *
 * Killing a viewer session is safe for the runner itself: it is a grouped
 * session (a view handle) — the runner window + scrollback live in the base
 * session and are unaffected.
 *
 * MUST run AFTER the FLY-172 complete-marker boot drain and the FLY-324
 * done-but-running boot sweep (Codex design review R1): a session that is
 * still `running` at boot but about to be reconciled to an outcome would
 * otherwise be skipped and leak until the next restart.
 */

import { execFile } from "node:child_process";
import { sanitizeTmuxName } from "flywheel-core";
import { OUTCOME_STATUSES, type StateStore } from "../StateStore.js";

const VIEWER_PREFIX = "viewer-";
const TMUX_LS_TIMEOUT_MS = 5_000;
const TMUX_KILL_TIMEOUT_MS = 3_000;

/**
 * Outcome states whose viewer session is safe to reap. approved_to_ship is an
 * outcome in OUTCOME_STATUSES but the Runner is still alive (it ships next),
 * so it is excluded — close_runner tears its viewer down later.
 */
const KILL_STATUSES = new Set<string>(OUTCOME_STATUSES);
KILL_STATUSES.delete("approved_to_ship");

export interface ViewerReapResult {
	scanned: number;
	killed: number;
	skippedAttached: number;
	skippedActive: number;
	skippedForeign: number;
	errors: string[];
}

/**
 * Derive the set of base tmux session names owned by this Bridge — MUST stay
 * byte-identical with run-infra.ts (`sanitizeTmuxName("runner-" + name)`),
 * which is why plugin.ts passes raw project names instead of building names
 * itself (Codex design review R1 #3).
 */
export function deriveOwnedBaseSessions(projectNames: string[]): Set<string> {
	return new Set(projectNames.map((n) => sanitizeTmuxName(`runner-${n}`)));
}

function execFilePromise(
	cmd: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
			if (err) reject(err);
			else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
		});
	});
}

/**
 * One-shot scan + kill of leaked viewer sessions. Best-effort: failures are
 * collected in `errors`, never thrown. A missing tmux server / binary is
 * benign (nothing to reap).
 */
export async function reapViewerSessions(
	store: StateStore,
	ownedBaseSessions: Set<string>,
): Promise<ViewerReapResult> {
	const result: ViewerReapResult = {
		scanned: 0,
		killed: 0,
		skippedAttached: 0,
		skippedActive: 0,
		skippedForeign: 0,
		errors: [],
	};

	let out: string;
	try {
		({ stdout: out } = await execFilePromise(
			"tmux",
			["ls", "-F", "#{session_name}|#{session_group}|#{session_attached}"],
			TMUX_LS_TIMEOUT_MS,
		));
	} catch {
		// tmux not installed / no server running — nothing to reap.
		return result;
	}

	for (const line of out.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith(VIEWER_PREFIX)) continue;
		const parts = trimmed.split("|");
		if (parts.length < 3) continue;
		const [sessionName, group, attachedRaw] = parts;
		if (!sessionName) continue;
		result.scanned++;

		const executionId = sessionName.slice(VIEWER_PREFIX.length);
		const attached = Number.parseInt(attachedRaw ?? "0", 10) || 0;

		if (attached > 0) {
			result.skippedAttached++;
			continue;
		}

		const session = store.getSession(executionId);
		let reason: string;
		if (session) {
			if (!KILL_STATUSES.has(session.status)) {
				// Live Runner (running/pending/awaiting_review/approved_to_ship) —
				// its viewer is torn down by close_runner later.
				result.skippedActive++;
				continue;
			}
			reason = `outcome:${session.status}`;
		} else if (group && ownedBaseSessions.has(group)) {
			// True orphan from our own fleet (row pruned / pre-registration lost).
			reason = "orphan:no-row";
		} else {
			// Unknown exec on a foreign (or unknown) base session — likely another
			// Bridge's (QA slot). Never touch.
			result.skippedForeign++;
			continue;
		}

		try {
			await execFilePromise(
				"tmux",
				["kill-session", "-t", `=${sessionName}`],
				TMUX_KILL_TIMEOUT_MS,
			);
			result.killed++;
			store.insertEvent({
				event_id: `viewer-reaper-${executionId}-${Date.now()}`,
				execution_id: executionId,
				issue_id: session?.issue_id ?? "unknown",
				project_name: session?.project_name ?? "unknown",
				event_type: "viewer_session_reaped",
				source: "bridge.viewer-session-reaper",
				payload: {
					sessionName,
					group,
					sessionStatus: session?.status,
					reason,
				},
			});
		} catch (e) {
			result.errors.push(`${sessionName}: ${(e as Error).message}`);
		}
	}

	return result;
}
