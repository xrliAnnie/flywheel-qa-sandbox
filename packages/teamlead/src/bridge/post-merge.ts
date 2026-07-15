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

import { closeRunnerTerminalView } from "flywheel-core";
import type { StateStore } from "../StateStore.js";
import {
	isResidentCodexPhase,
	prepareCodexPhaseShutdown,
} from "./codex-phase-shutdown.js";
import { finalizeCommDbSession } from "./commdb-session-prune.js";
import { reapRunnerMcp } from "./runner-teardown.js";
import { resolveTerminalViewIdentity } from "./terminal-view-identity.js";
import {
	getTmuxTargetFromCommDb,
	killCmuxLinkedSession,
	killTmuxWindow,
} from "./tmux-lookup.js";

// ── Types ───────────────────────────────────────────────

export interface PostMergeOpts {
	executionId: string;
	issueId: string;
	projectName: string;
}

export interface PostMergeResult {
	tmuxClosed: boolean;
	commDbFinalized: boolean;
	retiredGateCount: number;
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
		commDbFinalized: false,
		retiredGateCount: 0,
		errors: [],
	};
	let physicalGone = false;

	// Close Runner tmux session AND macOS Terminal viewer tab (FLY-116)
	try {
		const session = store.getSession(opts.executionId);
		let phaseControllerHandled = false;
		if (isResidentCodexPhase(session)) {
			const shutdown = await prepareCodexPhaseShutdown({
				executionId: opts.executionId,
				projectName: opts.projectName,
				getSession: () => store.getSession(opts.executionId),
			});
			if (shutdown.kind === "blocked") {
				result.errors.push(`phase-shutdown: ${shutdown.error}`);
				phaseControllerHandled = true;
			} else if (shutdown.kind === "graceful") {
				// The request-bound adapter ack is written only after daemon drain,
				// credential scrub, and founder-TUI removal. No second tmux kill.
				result.tmuxClosed = true;
				physicalGone = true;
				phaseControllerHandled = true;
			}
		}

		// A graceful controller close is complete; a blocked live/indeterminate
		// controller is deliberately preserved. Only other outcomes reach legacy
		// direct cleanup.
		if (!phaseControllerHandled) {
			const target = getTmuxTargetFromCommDb(
				opts.executionId,
				opts.projectName,
			);
			if (target) {
				// FLY-1185 §2.5: reap MCP-family descendants BEFORE any kill (pane
				// pid only resolvable while the window lives). Reap-only, best-effort.
				await reapRunnerMcp(target.tmuxWindow).catch(() => undefined);
				// FLY-638: tear down the per-runner cmux LINKED session BEFORE the
				// window kill (display-message needs the window alive). Best-effort.
				await killCmuxLinkedSession(target.tmuxWindow).catch((e: Error) =>
					result.errors.push(`cmux: ${e.message}`),
				);
				const killResult = await killTmuxWindow(target.tmuxWindow);
				result.tmuxClosed = killResult.killed;
				physicalGone = killResult.killed;
				if (killResult.error) {
					result.errors.push(`tmux: ${killResult.error}`);
				}
				// FLY-116: close per-runner Terminal viewer tab + linked viewer session
				if (session && killResult.killed) {
					const identity = resolveTerminalViewIdentity(session, target);
					if (identity) {
						const closeRes = await closeRunnerTerminalView({
							baseSessionName: identity.sessionName,
							projectName: identity.projectName,
							executionId: identity.executionId,
							windowId: identity.windowId,
							sessionRole: identity.sessionRole,
						}).catch(
							(e: Error) =>
								({
									closedTab: false,
									killedViewerSession: false,
									error: e.message,
								}) as const,
						);
						if (closeRes.error) {
							result.errors.push(`terminal: ${closeRes.error}`);
						}
					}
				}
			} else {
				physicalGone = true;
			}
		}
		// No target → tmux was never registered or CommDB missing. Not an error.
	} catch (err) {
		result.errors.push(`tmux: ${(err as Error).message}`);
	}

	// FLY-1238: an absent target and a successful kill both prove the physical
	// runner is gone. Retire its unresolved founder gates in the same transaction
	// that deletes the CommDB session; a failure keeps this cleanup partial.
	if (physicalGone) {
		const finalized = finalizeCommDbSession(opts.executionId, opts.projectName);
		store.recordCommDbFinalizeOutcome({
			executionId: opts.executionId,
			issueId: opts.issueId,
			projectName: opts.projectName,
			ok: finalized.ok,
			error: finalized.error,
		});
		result.commDbFinalized = finalized.ok;
		result.retiredGateCount = finalized.retiredGateCount;
		if (!finalized.ok) {
			result.errors.push(`commdb finalize: ${finalized.error ?? "unknown"}`);
		}
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
			commDbFinalized: result.commDbFinalized,
			retiredGateCount: result.retiredGateCount,
			errors: result.errors.length > 0 ? result.errors : undefined,
		},
	});

	return result;
}
