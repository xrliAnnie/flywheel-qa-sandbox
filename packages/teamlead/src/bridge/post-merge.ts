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
import type { Session, StateStore } from "../StateStore.js";
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
	probeRunnerProcessLiveness,
	resolveCmuxAttachTarget,
	type TmuxTarget,
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

export interface CleanupTmuxTargetInput {
	target: TmuxTarget;
	session: Session | undefined;
	strict?: {
		expectedExecutionId: string;
		authorityCheck: () => Promise<boolean>;
	};
}

export interface CleanupTmuxTargetResult {
	tmuxClosed: boolean;
	physicalGone: boolean;
	errors: string[];
	strictFailure?: "window_identity_mismatch" | "authority_lost";
}

export interface CleanupTmuxTargetDeps {
	resolveIdentity?: typeof resolveCmuxAttachTarget;
	probe?: typeof probeRunnerProcessLiveness;
	reapMcp?: (
		tmuxWindow: string,
		deps?: { authorityCheck?: () => Promise<boolean> },
	) => Promise<{ authorityLost?: boolean }>;
	killLinked?: typeof killCmuxLinkedSession;
	killWindow?: typeof killTmuxWindow;
	closeTerminal?: typeof closeRunnerTerminalView;
}

export async function cleanupTmuxTarget(
	input: CleanupTmuxTargetInput,
	deps: CleanupTmuxTargetDeps = {},
): Promise<CleanupTmuxTargetResult> {
	const errors: string[] = [];
	const reapMcp = deps.reapMcp ?? reapRunnerMcp;
	const killLinked = deps.killLinked ?? killCmuxLinkedSession;
	const killWindow = deps.killWindow ?? killTmuxWindow;
	const closeTerminal = deps.closeTerminal ?? closeRunnerTerminalView;

	const strictState = async (): Promise<"proven" | "gone" | "mismatch"> => {
		if (!input.strict) return "proven";
		const resolveIdentity = deps.resolveIdentity ?? resolveCmuxAttachTarget;
		const probe = deps.probe ?? probeRunnerProcessLiveness;
		const identity = await resolveIdentity(input.target.tmuxWindow, {
			expectedExecutionId: input.strict.expectedExecutionId,
		});
		if (identity.kind !== "unresolved") return "proven";
		try {
			const liveness = await probe(input.target.tmuxWindow);
			if (liveness === "absent" || liveness === "dead_pin") return "gone";
		} catch {
			// A failed probe is uncertainty, never authority for a destructive effect.
		}
		return "mismatch";
	};
	const refuse = (
		strictFailure: "window_identity_mismatch" | "authority_lost",
	): CleanupTmuxTargetResult => ({
		tmuxClosed: false,
		physicalGone: false,
		errors: [...errors, strictFailure],
		strictFailure,
	});
	const gone = (): CleanupTmuxTargetResult => ({
		tmuxClosed: true,
		physicalGone: true,
		errors,
	});

	if (input.strict) {
		const state = await strictState();
		if (state === "gone") return gone();
		if (state === "mismatch") return refuse("window_identity_mismatch");
		if (!(await input.strict.authorityCheck())) return refuse("authority_lost");
	}

	const mcp = await reapMcp(
		input.target.tmuxWindow,
		input.strict ? { authorityCheck: input.strict.authorityCheck } : undefined,
	).catch((): { authorityLost?: boolean } => ({}));
	if (mcp.authorityLost) return refuse("authority_lost");

	if (input.strict) {
		const state = await strictState();
		if (state === "gone") return gone();
		if (state === "mismatch") return refuse("window_identity_mismatch");
		if (!(await input.strict.authorityCheck())) return refuse("authority_lost");
	}

	await killLinked(input.target.tmuxWindow).catch((error: Error) =>
		errors.push(`cmux: ${error.message}`),
	);

	if (input.strict) {
		const state = await strictState();
		if (state === "gone") return gone();
		if (state === "mismatch") return refuse("window_identity_mismatch");
		if (!(await input.strict.authorityCheck())) return refuse("authority_lost");
	}

	const killResult = await killWindow(input.target.tmuxWindow);
	if (killResult.error) errors.push(`tmux: ${killResult.error}`);
	if (input.session && killResult.killed) {
		const identity = resolveTerminalViewIdentity(input.session, input.target);
		if (identity) {
			const closeRes = await closeTerminal({
				baseSessionName: identity.sessionName,
				projectName: identity.projectName,
				executionId: identity.executionId,
				windowId: identity.windowId,
				sessionRole: identity.sessionRole,
			}).catch(
				(error: Error) =>
					({
						closedTab: false,
						killedViewerSession: false,
						error: error.message,
					}) as const,
			);
			if (closeRes.error) errors.push(`terminal: ${closeRes.error}`);
		}
	}
	return {
		tmuxClosed: killResult.killed,
		physicalGone: killResult.killed,
		errors,
	};
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
				const direct = await cleanupTmuxTarget({ target, session });
				result.tmuxClosed = direct.tmuxClosed;
				physicalGone = direct.physicalGone;
				result.errors.push(...direct.errors);
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
			audit: {
				retiredGateCount: finalized.retiredGateCount,
				retiredAskCount: finalized.retiredAskCount,
				source: "bridge.post-merge",
			},
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
