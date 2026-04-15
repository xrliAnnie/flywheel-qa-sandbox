/**
 * Post-merge tmux cleanup — tmux session close + audit event.
 *
 * Responsibility boundary (FLY-102 Round 3):
 *   - Bridge-side: close Runner tmux session + write audit event.
 *   - NOT here: worktree remove, docs archive, MEMORY update.
 *     Those stay with Runner / Orchestrator (future: executor lifecycle contract).
 *
 * Call sites:
 *   - DirectEventSink.emitCompleted (production session_completed path)
 *     via runPostShipFinalization orchestrator
 *   - event-route.ts postApproveShip branch (PR-merged webhook)
 *     via runPostShipFinalization orchestrator
 *   - actions.ts _onApproved callback is DEAD CODE — not relied on.
 *
 * Idempotent: killTmuxWindow returns success when window already gone.
 * Never throws — all errors are captured in the result and audit event.
 */

import type { StateStore } from "../StateStore.js";
import { getTmuxTargetFromCommDb, killTmuxWindow } from "./tmux-lookup.js";

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
export async function postMergeTmuxCleanup(
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
			const killResult = await killTmuxWindow(target.tmuxWindow);
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
