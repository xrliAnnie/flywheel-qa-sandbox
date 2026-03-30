/**
 * GEO-280: Post-merge cleanup — fire-and-forget tmux cleanup after approve.
 *
 * Bridge-side responsibility: close Runner tmux session + audit event.
 * Other cleanup (worktree, doc archive, MEMORY.md) is Runner/Orchestrator responsibility
 * via /spin Archive stage and cleanup-agent.sh.
 *
 * Triggered by the `onApproved` callback in approveExecution().
 * Never throws — all errors are captured in the result and audit event.
 */

import type { StateStore } from "../StateStore.js";
import { getTmuxTargetFromCommDb, killTmuxSession } from "./tmux-lookup.js";

// ── Types ───────────────────────────────────────────────

export interface PostMergeOpts {
	executionId: string;
	issueId: string;
	projectName: string;
}

export interface PostMergeResult {
	tmuxClosed: boolean;
	errors: string[];
}

// ── Main entry point ────────────────────────────────────

/**
 * Post-merge cleanup. Called fire-and-forget after approve succeeds.
 * Never throws — all errors captured in result.errors and audit event.
 */
export async function postMergeCleanup(
	opts: PostMergeOpts,
	store: StateStore,
): Promise<PostMergeResult> {
	const result: PostMergeResult = {
		tmuxClosed: false,
		errors: [],
	};

	// Close Runner tmux session
	try {
		const target = getTmuxTargetFromCommDb(opts.executionId, opts.projectName);
		if (target) {
			const killResult = await killTmuxSession(target.sessionName);
			result.tmuxClosed = killResult.killed;
			if (killResult.error) {
				result.errors.push(`tmux: ${killResult.error}`);
			}
		}
		// No target → tmux was never registered or CommDB missing. Not an error.
	} catch (err) {
		result.errors.push(`tmux: ${(err as Error).message}`);
	}

	// Audit event
	const eventType =
		result.errors.length > 0 ? "post_merge_partial" : "post_merge_completed";
	store.insertEvent({
		event_id: `post-merge-${opts.executionId}-${Date.now()}`,
		execution_id: opts.executionId,
		issue_id: opts.issueId,
		project_name: opts.projectName,
		event_type: eventType,
		source: "bridge.post-merge",
		payload: {
			tmuxClosed: result.tmuxClosed,
			errors: result.errors.length > 0 ? result.errors : undefined,
		},
	});

	return result;
}
