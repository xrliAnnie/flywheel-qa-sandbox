import { homedir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { CommDB } from "flywheel-comm/db";
import { isThreeStagePhaseRole, resolvePhaseDispatch } from "flywheel-config";
import { ACTION_DEFINITIONS, closeRunnerTerminalView } from "flywheel-core";
import type { ActionResult, CipherWriter } from "flywheel-edge-worker";
import { parseDocTier } from "flywheel-edge-worker/dist/Blueprint.js";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import { DepartmentRegistry } from "../department-registry.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import {
	REVIEW_BINDING_UNBOUND,
	type Session,
	type StateStore,
} from "../StateStore.js";
import {
	type FounderApprovalCardAuthority,
	writeGateResponseAndRunPostWrite,
} from "./approval-signal/write-gate-response.js";
import { reviewHoldReason } from "./auto-qa-held.js";
import { resolveChatThreadId } from "./chat-thread-utils.js";
import { AUTO_CLOSE_STATES, closeRunner } from "./close-runner.js";
import { finalizeCommDbSession } from "./commdb-session-prune.js";
import type { EventFilter } from "./EventFilter.js";
import { buildSessionKey, type HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { matchesLead } from "./lead-scope.js";
import { finalizeRecoveredMerge } from "./merge-ship-gate.js";
import type { PhaseOrchestrator } from "./phase-orchestrator.js";
import { makeFinalizeThreeStagePhases } from "./post-ship-finalization.js";
import { reconcileGatewayRetry } from "./retry-dispatch-wal.js";
import type { IRetryDispatcher } from "./retry-dispatcher.js";
import { reapRunnerMcp } from "./runner-teardown.js";
import { sendRunnerWake } from "./runner-wake.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { waitForSession } from "./session-wait.js";
import {
	checkStartedEvidence,
	type StartedEvidence,
} from "./started-evidence.js";
import { resolveTerminalViewIdentity } from "./terminal-view-identity.js";
import {
	killCmuxLinkedSession,
	killTmuxWindow,
	lookupTmuxTarget,
} from "./tmux-lookup.js";
import { type BridgeConfig, sqliteDatetime } from "./types.js";

type ExecFn = (
	cmd: string,
	args: string[],
	cwd: string,
) => Promise<{ stdout: string }>;

// ExecFn kept for backward-compatible caller signatures
// (no longer used internally after FLY-58 — approve no longer merges PR)

/** @deprecated Use ACTION_DEFINITIONS from flywheel-core instead (GEO-158). */
export const ACTION_SOURCE_STATUS: Record<string, string[]> = {
	approve: ["awaiting_review"],
	reject: ["awaiting_review"],
	defer: ["awaiting_review", "blocked"],
	retry: ["failed", "blocked", "rejected"],
	shelve: ["awaiting_review", "blocked", "failed", "rejected", "deferred"],
};

/** @deprecated Use getActionTarget() from flywheel-core instead (GEO-158). */
export const ACTION_TARGET_STATUS: Record<string, string> = {
	reject: "rejected",
	defer: "deferred",
	retry: "running",
	shelve: "shelved",
};

/**
 * Resolve the per-project CommDB path. FLY-191: `FLYWHEEL_COMM_ROOT` override
 * (tests / non-standard installs); default matches flywheel-comm's
 * `resolveDbPath` convention. Module-scoped so both `approveExecution` (gate
 * unblock) and `handleTerminate` (FLY-228 gate resolution) share it.
 */
function commDbPathFor(projectName: string): string {
	const root =
		process.env.FLYWHEEL_COMM_ROOT?.trim() ||
		join(homedir(), ".flywheel", "comm");
	return join(root, projectName, "comm.db");
}

/** Send post-action hook notification via RuntimeRegistry (best-effort, fire-and-forget). */
function sendActionHook(
	store: StateStore,
	projects: ProjectEntry[],
	executionId: string,
	action: string,
	sourceStatus: string,
	targetStatus: string,
	reason?: string,
	eventFilter?: EventFilter,
	registry?: RuntimeRegistry,
	config?: BridgeConfig,
): void {
	if (!registry) return;
	const session = store.getSession(executionId);
	if (!session) return;
	try {
		const labels = store.getSessionLabels(executionId);
		const { runtime, lead } = registry.resolveWithLead(
			projects,
			session.project_name,
			labels,
		);
		const hookPayload: HookPayload = {
			event_type: "action_executed",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: targetStatus,
			chat_channel: lead.chatChannel,
			issue_labels: labels,
			session_role: session.session_role ?? "main",
			action,
			action_source_status: sourceStatus,
			action_target_status: targetStatus,
			action_reason: reason,
		};

		// FLY-91: Fill chat_thread_id for Lead thread routing
		if (config?.chatThreadsEnabled) {
			hookPayload.chat_thread_id = resolveChatThreadId(
				store,
				session.issue_id,
				lead.chatChannel,
			);
		}

		const doDeliver = async () => {
			// FLY-47 / FLY-163: Classify event — priority hints (chat-only).
			if (eventFilter) {
				const filterResult = eventFilter.classify(
					"action_executed",
					hookPayload,
				);
				hookPayload.filter_priority = filterResult.priority;
				hookPayload.notification_context = filterResult.reason;
			}

			// FLY-47: Always deliver ALL events to Lead
			const eventId = `action-${executionId}-${action}-${Date.now()}`;
			const sessionKey = buildSessionKey(session);
			const seq = store.appendLeadEvent(
				lead.agentId,
				eventId,
				"action_executed",
				JSON.stringify(hookPayload),
				sessionKey,
			);
			const envelope: LeadEventEnvelope = {
				seq,
				event: hookPayload,
				sessionKey,
				leadId: lead.agentId,
				timestamp: new Date().toISOString(),
			};
			await runtime.deliver(envelope);
			store.markLeadEventDelivered(seq);
		};
		doDeliver().catch((err) => {
			console.warn(
				`[sendActionHook] Notification pipeline failed for ${executionId}:`,
				(err as Error).message,
			);
		});
	} catch (err) {
		console.warn(
			`[actions] Unknown project "${session.project_name}" — skipping hook:`,
			(err as Error).message,
		);
	}
}

/**
 * FLY-58: Approve only transitions state to approved_to_ship.
 * No longer merges PR — Runner handles merge via /spin ship stage.
 * Responds to CommDB approve_to_ship gate to unblock Runner.
 */
export async function approveExecution(
	store: StateStore,
	projects: ProjectEntry[],
	executionId: string,
	identifier?: string,
	_execFn?: ExecFn,
	transitionOpts?: ApplyTransitionOpts,
	config?: BridgeConfig,
	cipherWriter?: CipherWriter,
	eventFilter?: EventFilter,
	/** FLY-163: positional slot kept (was forumTagUpdater); now ignored. */
	_unusedForumTagUpdater?: unknown,
	registry?: RuntimeRegistry,
	_onApproved?: (executionId: string, session: Session) => void,
	// FLY-907 (Step 4.1c): unified issue-display refresh, threaded into the
	// recovered-merge finalization (a completion path that bypasses both the
	// applyTransition hook and the DirectEventSink hook).
	refreshIssueDisplay?: (issueId: string) => Promise<void>,
	cardAuthority?: FounderApprovalCardAuthority,
): Promise<ActionResult> {
	const session = store.getSession(executionId);
	if (!session) {
		return {
			success: false,
			message: `No session found for execution_id ${executionId}`,
		};
	}

	if (session.status !== "awaiting_review") {
		return {
			success: false,
			message: `Cannot approve ${identifier ?? executionId}: status is "${session.status}", expected "awaiting_review"`,
		};
	}

	const project = projects.find((p) => p.projectName === session.project_name);
	if (!project) {
		return {
			success: false,
			message: `Unknown project: ${session.project_name}`,
		};
	}

	const ceoActionTimestamp = new Date().toISOString();

	// FLY-191 Phase 2 (Codex PR R1 HIGH-3): write the CommDB gate response
	// BEFORE the FSM transition. The old order flipped approved_to_ship first;
	// if the gate was missing/expired or the CommDB write failed, the session
	// was stranded: verify-approval fail-closes (no response), the review
	// timeout stops (status left awaiting_review no more), and approve can't
	// be retried (status gate above). Now: no response written → no
	// transition → the action FAILS retryably and the session stays
	// awaiting_review. Idempotent: a previously-written approval response
	// counts as written (so an FSM-rejected attempt can be retried).
	let gateUnblocked = false;
	try {
		const commDbPath = commDbPathFor(session.project_name);
		const db = new CommDB(commDbPath, false);
		try {
			// Bound question first (Codex PR R1 CRITICAL): the session's CURRENT
			// review request. ONLY true legacy sessions (binding column never
			// written — NULL) fall back to the latest pending gate. The
			// REVIEW_BINDING_UNBOUND sentinel (R2 HIGH-1) means a Phase-2
			// completion arrived WITHOUT a questionId: approving it would
			// strand the session (verify-approval can never pass) — refuse and
			// point at the recovery path instead.
			let targetQuestionId: string | undefined;
			const boundId = session.review_question_id?.trim();
			if (boundId === REVIEW_BINDING_UNBOUND) {
				return {
					success: false,
					message: `Cannot approve ${identifier ?? executionId}: the review request is missing its question binding (completion arrived without --question-id). Approving would strand the session — ask the runner to re-request review (gate --no-block, then complete --route needs_review --question-id <id>).`,
				};
			}
			if (boundId) {
				const bound = db.getMessageById(boundId);
				if (
					bound &&
					bound.type === "question" &&
					bound.checkpoint === "approve_to_ship" &&
					bound.from_agent === executionId
				) {
					targetQuestionId = bound.id;
				}
			} else {
				const pendingGate = db.getPendingGateByRunner(
					executionId,
					"approve_to_ship",
				);
				targetQuestionId = pendingGate?.id;
			}

			if (!targetQuestionId) {
				return {
					success: false,
					message: `Cannot approve ${identifier ?? executionId}: no ${boundId ? `valid bound review question (${boundId})` : "pending approve_to_ship gate"} in CommDB — nothing for the runner's verify-approval to honor. Session stays awaiting_review; investigate the runner's review request and retry.`,
				};
			}

			const write = await writeGateResponseAndRunPostWrite({
				db,
				store,
				questionId: targetQuestionId,
				executionId,
				source: "actions",
				cardAuthority,
				actor: "bridge",
				answer: JSON.stringify({ approved: true }),
				expectedCurrentReviewQuestionId: boundId || undefined,
				// Direct unit callers historically omit Bridge config. Production
				// action routes always pass it and therefore enforce the shared hold.
				holdReasonFor: config
					? (id) => {
							const held = store.getSession(id);
							// Dashboard approval is the explicit FLY-869 same-head recovery
							// surface. Mask only its merge marker, then still enforce every
							// downstream Codex/QA hold on the parked session.
							const withoutMergeBlock = held?.merge_block_reason
								? { ...held, merge_block_reason: undefined }
								: held;
							return reviewHoldReason(store, withoutMergeBlock);
						}
					: undefined,
			});
			if (
				write.disposition === "defer" ||
				write.disposition === "reject" ||
				(!write.written && write.disposition !== "already_applied")
			) {
				return {
					success: false,
					message: `Cannot approve ${identifier ?? executionId}: founder approval boundary refused the write (${write.reason ?? write.disposition ?? "unknown"}).`,
				};
			}
			gateUnblocked = true;
		} finally {
			db.close();
		}
	} catch (err) {
		console.error(
			`[actions] CommDB gate respond FAILED for ${executionId}: ${(err as Error).message}.`,
		);
		return {
			success: false,
			message: `Cannot approve ${identifier ?? executionId}: CommDB gate response write failed (${(err as Error).message}). Session stays awaiting_review; retry once CommDB is reachable.`,
		};
	}

	// FLY-58: Transition to approved_to_ship (not approved, not merge)
	let transitionRejected = false;
	if (transitionOpts) {
		const fsmResult = applyTransition(
			transitionOpts,
			session.execution_id,
			"approved_to_ship",
			{
				executionId: session.execution_id,
				issueId: session.issue_id,
				projectName: session.project_name,
				trigger: "approve",
			},
			{ last_activity_at: sqliteDatetime() },
		);
		if (!fsmResult.ok) {
			console.warn(
				`[actions] FSM rejected approve for ${executionId}: ${fsmResult.error}`,
			);
			transitionRejected = true;
		}
	} else {
		store.upsertSession({
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: "approved_to_ship",
			last_activity_at: sqliteDatetime(),
		});
	}

	if (transitionRejected) {
		return {
			success: false,
			message: `FSM rejected approve transition for ${identifier ?? executionId}`,
			alreadyResponded: true,
		};
	}

	// FLY-869 B-3 recovery (design R2 HIGH-5): if this session was parked with a
	// merge_block marker (an unapproved merge) bound to the current PR head, THIS
	// founder approval un-parks it — clear the marker so it is no longer held from
	// founder surfaces and can complete via the (now ship-eligible) finalization path.
	// FLY-869 B-3 recovery (Codex R1 #1 / R2 #2): a same-head founder approval on a parked
	// merged-but-unapproved session drives it to completed + Linear Done — but ONLY when it is
	// now fully ship-eligible; an unmet QA/Codex gate leaves the durable merge_block marker in
	// place (still held). No-op for a normal (non-parked) approval. Worktree cleanup is
	// intentionally omitted here (Codex R2 #3): a self-merged runner's worktree is already gone,
	// and the periodic worktree reaper covers any straggler — the approval handlers do not carry
	// the removeCleanWorktree closure.
	if (config) {
		const completed = await finalizeRecoveredMerge(
			store,
			config,
			projects,
			session.execution_id,
			undefined,
			undefined,
			refreshIssueDisplay,
			// FLY-907 Codex R1 MED-2: the recovered-merge path must finalize a
			// three-stage issue's parked phases like every other completion sink.
			transitionOpts
				? makeFinalizeThreeStagePhases(
						store,
						transitionOpts,
						refreshIssueDisplay,
					)
				: undefined,
		);
		if (completed) {
			console.log(
				`[actions] FLY-869 B-3 recovered merge finalized → completed for ${executionId}`,
			);
		}
	}

	// FLY-58: Always set session_stage to "ship" on approve.
	// Runner may have prematurely set stage to "completed" when its work finished
	// (e.g. PR created), but actual ship hasn't happened yet. Approve is a
	// deliberate lifecycle step that overrides any premature stage.
	store.patchSessionMetadata(session.execution_id, {
		session_stage: "ship",
		stage_updated_at: sqliteDatetime(),
	});

	sendActionHook(
		store,
		projects,
		executionId,
		"approve",
		"awaiting_review",
		"approved_to_ship",
		undefined,
		eventFilter,
		registry,
		config,
	);

	// CIPHER: record approve outcome
	if (cipherWriter) {
		try {
			await cipherWriter.recordOutcome({
				executionId,
				ceoAction: "approve",
				ceoActionTimestamp,
				sourceStatus: session.status,
			});
		} catch {
			console.error(`[CIPHER] recordOutcome failed for approve ${executionId}`);
		}
	}

	// FLY-191 Phase 2: the runner may be IDLE (gate --no-block), not polling —
	// wake it with a plain-text mailbox message AFTER the transition (so a
	// woken runner's verify-approval sees approved_to_ship). The wake is a
	// HINT only (forgeable transport); ship authority is verify-approval. For
	// a legacy blocking-gate runner the gate poll loop resolves from the
	// response written above; the extra mailbox message is harmless and
	// reinforces the verify-before-ship contract. Best-effort — failure is
	// recorded as runner_wake_failed telemetry inside sendRunnerWake.
	try {
		const db = new CommDB(commDbPathFor(session.project_name), false);
		try {
			await sendRunnerWake(store, db, executionId, session, "approval_wake");
		} finally {
			db.close();
		}
	} catch (err) {
		console.error(
			`[actions] approval wake skipped for ${executionId}: ${(err as Error).message}`,
		);
	}

	return {
		success: true,
		message: `Approved ${identifier ?? executionId} → approved_to_ship${gateUnblocked ? " (gate unblocked)" : " (WARNING: no pending gate — Runner may need manual unblock)"}`,
		alreadyResponded: true,
		gateUnblocked,
	};
}

export async function transitionSession(
	store: StateStore,
	action: string,
	executionId: string,
	reason?: string,
	transitionOpts?: ApplyTransitionOpts,
	config?: BridgeConfig,
	cipherWriter?: CipherWriter,
	projects?: ProjectEntry[],
	eventFilter?: EventFilter,
	/** FLY-163: positional slot kept (was forumTagUpdater); now ignored. */
	_unusedForumTagUpdater?: unknown,
	registry?: RuntimeRegistry,
): Promise<ActionResult> {
	const session = store.getSession(executionId);
	if (!session) {
		return {
			success: false,
			message: `No session found for execution_id ${executionId}`,
		};
	}

	const actionDef = ACTION_DEFINITIONS.find((d) => d.action === action);
	if (!actionDef) {
		return { success: false, message: `Unknown action: ${action}` };
	}
	const targetStatus = actionDef.targetState;

	if (transitionOpts) {
		// GEO-158: FSM-validated transition path
		const result = applyTransition(
			transitionOpts,
			session.execution_id,
			targetStatus,
			{
				executionId: session.execution_id,
				issueId: session.issue_id,
				projectName: session.project_name,
				trigger: action,
			},
			{ last_activity_at: sqliteDatetime(), last_error: reason ?? undefined },
		);
		if (!result.ok) {
			return {
				success: false,
				message: result.error ?? "Transition rejected by FSM",
			};
		}
	} else {
		// Legacy fallback (no FSM)
		if (!actionDef.fromStates.includes(session.status)) {
			return {
				success: false,
				message: `Cannot ${action} ${session.issue_identifier ?? executionId}: status is "${session.status}", expected one of: ${actionDef.fromStates.join(", ")}`,
			};
		}
		store.forceStatus(
			session.execution_id,
			targetStatus,
			sqliteDatetime(),
			reason,
		);
	}

	// CIPHER: record outcome for reject/defer from awaiting_review
	if (
		cipherWriter &&
		(action === "reject" || action === "defer") &&
		session.status === "awaiting_review"
	) {
		try {
			await cipherWriter.recordOutcome({
				executionId,
				ceoAction: action as "reject" | "defer",
				ceoActionTimestamp: new Date().toISOString(),
				sourceStatus: session.status,
			});
		} catch {
			console.error(`[CIPHER] recordOutcome failed for ${executionId}`);
		}
	}

	sendActionHook(
		store,
		projects ?? [],
		executionId,
		action,
		session.status,
		targetStatus,
		reason,
		eventFilter,
		registry,
		config,
	);

	// FLY-163: retry no longer un-archives a forum thread (forum removed).

	// FLY-116: when an action transitions session to an AUTO_CLOSE state
	// (rejected / deferred / shelved / terminated), also kill tmux + close
	// the macOS Terminal viewer tab. terminate has its own handler that
	// already does this; the transitionSession path covers reject/defer/shelve.
	if (
		AUTO_CLOSE_STATES.has(targetStatus) &&
		action !== "retry" &&
		action !== "terminate"
	) {
		closeRunner(
			{
				executionId,
				issueId: session.issue_id,
				projectName: session.project_name,
				reason: `transition_to_${targetStatus}`,
			},
			store,
		).catch((e: Error) =>
			console.warn(`[transition] closeRunner warn for ${action}: ${e.message}`),
		);
	}

	const id = session.issue_identifier ?? executionId;
	const pastTense: Record<string, string> = {
		reject: "rejected",
		defer: "deferred",
		retry: "retried",
		shelve: "shelved",
	};
	return {
		success: true,
		message: `${id} ${pastTense[action] ?? action} successfully`,
	};
}

/** GEO-168: Composite retry handler — eligibility check → dispatch → lineage → Linear comment. */
/** FLY-245 D2: gateway pre-bound dispatch context for a retry (plan §5.2.1).
 * `checkEvidence` is injectable for tests; production uses the real
 * started-evidence checker. */
export interface GatewayRetryDispatch {
	gatewayRequestId: string;
	successorExecutionId: string;
	checkEvidence?: (
		executionId: string,
		projectName: string,
	) => Promise<StartedEvidence>;
}

async function handleRetry(
	store: StateStore,
	retryDispatcher: IRetryDispatcher,
	executionId: string,
	reason?: string,
	config?: BridgeConfig,
	projects?: ProjectEntry[],
	eventFilter?: EventFilter,
	ceoContext?: string,
	registry?: RuntimeRegistry,
	gatewayDispatch?: GatewayRetryDispatch,
): Promise<ActionResult> {
	const session = store.getSession(executionId);
	if (!session) {
		return {
			success: false,
			message: `No session found for execution_id ${executionId}`,
		};
	}

	// FLY-245 D2 (plan §5.2.1): gateway-bound retries reconcile against the
	// durable intent WAL BEFORE eligibility — a replay of a request whose
	// successor already STARTED must converge on it (report success, repair
	// lineage) regardless of what the predecessor's status has since become;
	// the action already happened. First attempts commit the binding here
	// (before dispatch) and then flow through the normal eligibility checks.
	if (gatewayDispatch) {
		const verdict = await reconcileGatewayRetry(
			store,
			{
				gatewayRequestId: gatewayDispatch.gatewayRequestId,
				successorExecutionId: gatewayDispatch.successorExecutionId,
				predecessorExecutionId: executionId,
				projectName: session.project_name,
			},
			{ checkEvidence: gatewayDispatch.checkEvidence ?? checkStartedEvidence },
		);
		if (verdict.kind === "converged") {
			return {
				success: true,
				message: `Retry already started for ${session.issue_identifier ?? executionId}: successor ${verdict.successorExecutionId} is live (idempotent replay, no second runner)`,
			};
		}
		if (verdict.kind === "conflict") {
			return {
				success: false,
				message: `Gateway request ${gatewayDispatch.gatewayRequestId} is already bound to successor ${verdict.boundSuccessorExecutionId}; refusing a second binding`,
			};
		}
		if (verdict.kind === "fail_closed") {
			return {
				success: false,
				message: `Cannot prove whether the bound successor already started (${verdict.detail}); refusing to re-dispatch (fail-closed)`,
			};
		}
		// "proceed": intent WAL committed — dispatch below with the pre-bound id.
	}

	const actionDef = ACTION_DEFINITIONS.find((d) => d.action === "retry");
	if (!actionDef || !actionDef.fromStates.includes(session.status)) {
		return {
			success: false,
			message: `Cannot retry ${session.issue_identifier ?? executionId}: status is "${session.status}", expected one of: ${actionDef?.fromStates.join(", ") ?? "?"}`,
		};
	}

	// FLY-59: Per-role dedup — check inflight for same issue+role
	const sessionRole = session.session_role ?? "main";
	if (retryDispatcher.hasInflightForRole(session.issue_id, sessionRole)) {
		return {
			success: false,
			message: `Issue ${session.issue_identifier ?? session.issue_id} already has an execution in progress for role "${sessionRole}"`,
		};
	}

	// FLY-59: Check for active (running) session in StateStore — per role
	const active = store.getActiveSessions();
	const activeForIssue = active.find(
		(s) =>
			s.issue_id === session.issue_id &&
			(s.session_role ?? "main") === sessionRole,
	);
	if (activeForIssue) {
		return {
			success: false,
			message: `Issue ${session.issue_identifier ?? session.issue_id} already has an active session for role "${sessionRole}" (${activeForIssue.execution_id})`,
		};
	}

	const runAttempt = (session.run_attempt ?? 0) + 1;

	// GEO-206: Resolve leadId for retry
	let retryLeadId: string | undefined;
	if (projects) {
		try {
			const storedLabels = session.issue_labels
				? (JSON.parse(session.issue_labels) as string[])
				: [];
			const resolved = resolveLeadForIssue(
				projects,
				session.project_name,
				storedLabels,
			);
			retryLeadId = resolved.lead.agentId;
		} catch {
			retryLeadId = config?.defaultLeadAgentId;
		}
	}

	// FLY-116: cleanup old preserved Runner window/tab BEFORE dispatching new
	// execution. If status is failed/blocked it defaulted to crash_preserve;
	// retry indicates the user has decided to discard the dead window.
	// `forcePreserved: true` bypasses the crash_preserve gate.
	//
	// AWAIT (Codex Round 1 PR review #2): the new retry must not start until
	// the old tmux window + Terminal tab + linked viewer session are gone,
	// otherwise the next runner can collide with stale state during dispatch.
	// Cleanup errors are logged but do NOT block the retry.
	try {
		await closeRunner(
			{
				executionId,
				issueId: session.issue_id,
				projectName: session.project_name,
				leadId: retryLeadId,
				reason: "retry_force_close",
				forcePreserved: true,
			},
			store,
		);
	} catch (e) {
		console.warn(`[retry] old window cleanup warn: ${(e as Error).message}`);
	}

	// FLY-137 v1.27.2 (Codex Track A #5): retry must thread `issueLabels` +
	// `owningDept` so AgentDispatcher's dept-aware step 2a can re-select the same
	// dept-grouped agent. Without this, retry silently degrades to top-level
	// catch-all and may pick a different agent than the original execution.
	//
	// Strategy: reuse the stored Linear labels from `session.issue_labels` (same
	// source `resolveLeadForIssue` already uses for leadId resolution above) and
	// re-resolve owningDept via DepartmentRegistry. Linear-refresh-on-retry is
	// deferred per plan v1.27.2 §Data path wiring — stored labels are sufficient
	// for the dept-aware dispatcher step 2a re-selection.
	let retryIssueLabels: string[] | undefined;
	let retryOwningDept: string | "multiple" | undefined;
	if (projects) {
		try {
			const storedLabels = session.issue_labels
				? (JSON.parse(session.issue_labels) as string[])
				: [];
			retryIssueLabels = storedLabels.map((l) => l.toLowerCase());
			const registry = new DepartmentRegistry(projects);
			retryOwningDept = registry.getDepartmentForIssue(
				session.project_name,
				retryIssueLabels,
			);
		} catch (err) {
			console.warn(
				`[retry] Failed to resolve issueLabels/owningDept from stored session: ${(err as Error).message}. ` +
					`AgentDispatcher will fall through to top-level catch-all.`,
			);
		}
	}

	// FLY-137 Phase 5: codex-skip re-snapshot on retry. If LINEAR_API_KEY
	// is set, re-fetch labels so a fresh `codex-skip` label addition takes
	// effect for the retry; otherwise fall back to the stored value with
	// a warning. Annie's mental model: "label the issue codex-skip, retry
	// the Runner" — degrade gracefully on Linear unreachable.
	let retryCodexSkip = !!session.codex_skip;
	if (process.env.LINEAR_API_KEY) {
		try {
			const { LinearClient } = await import("@linear/sdk");
			const linear = new LinearClient({
				apiKey: process.env.LINEAR_API_KEY,
			});
			const issue = await linear.issue(session.issue_id);
			const labels = await issue.labels();
			const labelNames = (labels.nodes ?? []).map((l) =>
				(l.name ?? "").toLowerCase(),
			);
			retryCodexSkip = labelNames.includes("codex-skip");
			if (retryCodexSkip !== !!session.codex_skip) {
				console.log(
					`[retry] codex-skip changed for ${session.issue_id}: stored=${!!session.codex_skip} fresh=${retryCodexSkip}`,
				);
			}
			// Persist the refreshed labels too so subsequent retries see
			// the latest snapshot (matches the start-time semantics).
			retryIssueLabels = labelNames;
		} catch (err) {
			console.warn(
				`[retry] Linear label refresh failed; using stored codex_skip=${!!session.codex_skip}: ${(err as Error).message}`,
			);
		}
	} else {
		console.warn(
			`[retry] LINEAR_API_KEY not set; using stored codex_skip=${!!session.codex_skip}`,
		);
	}

	// FLY-887 R2 (Codex R1 #2): PHASE-row retries stay under the phase table.
	// Discriminator = the durable `chat_thread_role` three-stage marker
	// (auto-QA / single-session rows are 'main' → untouched, which is exactly
	// the "don't touch auto-QA" boundary). For a phase row:
	//   - the dispatch {model, vendor, effort} is resolvePhaseDispatch(role)
	//     UNCONDITIONALLY — never the persisted `dispatch_model` (a pre-fix
	//     phase row may have persisted a sorter pin or NULL; replaying it would
	//     put the phase back on Sonnet, or a codex phase back on claude);
	//   - `ignoreRunnerLabelSelection: true` is threaded through the retry
	//     dispatcher (previously hardcoded undefined there) so a refreshed
	//     `sonnet`/vendor label cannot bypass the table either.
	const phaseRole = isThreeStagePhaseRole(session.chat_thread_role)
		? session.chat_thread_role
		: undefined;
	const phaseDispatch = phaseRole ? resolvePhaseDispatch(phaseRole) : undefined;

	// R2 MED-6: the dispatch call and the POST-dispatch bookkeeping are split into
	// TWO try blocks. A throw from `dispatch()` itself is PRE-start (admission
	// deferred / inflight conflict / no runtime / durable claim) — nothing has
	// started, so a clean failure (→ HTTP 4xx → gateway `not_dispatched`) is
	// correct. But once `dispatch()` RETURNS, the Runner is starting and the
	// successor execId is bound; a subsequent StateStore/bookkeeping error must
	// NOT be reported as a clean failure (the gateway would read the 4xx as
	// "never dispatched" and allow a SECOND successor). So post-dispatch errors
	// are logged but STILL report success with the bound successor id.
	let result: { newExecutionId: string; oldExecutionId: string };
	try {
		result = await retryDispatcher.dispatch({
			oldExecutionId: executionId,
			issueId: session.issue_id,
			issueIdentifier: session.issue_identifier,
			issueTitle: session.issue_title,
			projectName: session.project_name,
			reason,
			previousError: session.last_error,
			previousDecisionRoute: session.decision_route,
			previousReasoning: ceoContext ?? session.decision_reasoning,
			runAttempt,
			leadId: retryLeadId,
			// FLY-1224 (R2 #3): sessionRole follows the SAME durable phase
			// discriminator as the dispatch table — an old/polluted row can carry
			// chat_thread_role=implement while session_role drifted to main;
			// re-deriving only the vendor would start the codex runner in a
			// non-phase identity. Non-phase rows keep the persisted role verbatim.
			sessionRole: phaseRole ?? sessionRole,
			// FLY-1224 (R1 #1, settles FLY-840): a PHASE-row retry keeps its
			// shared-branch identity — without this the retried implement rebuilds
			// an independent branch instead of branch B, making the codex-retry /
			// kill-switch recovery path unsafe. FLY-840's worry was "propagating
			// the marker on EVERY retry changes retry branch behavior"; the
			// phase-row-scoped propagation is exactly the behavior a phase row
			// should have had (FLY-887 R2 same shape). Side effect (intentional,
			// test-locked): runnerDisplayName now labels the retry's cmux window
			// with the phase name. Non-phase retries: undefined (byte-compatible).
			shareParentBranch: phaseRole ? true : undefined,
			// FLY-137 v1.27.2: dept-aware dispatch context for retry
			issueLabels: retryIssueLabels,
			owningDept: retryOwningDept,
			// FLY-137 Phase 5: refreshed (or stored-fallback) codex-skip
			// snapshot. Persisted on the new session row below so the
			// event-route stage_changed handler picks it up at design_review.
			codexSkip: retryCodexSkip,
			// FLY-137 v1.27.2: thread stored Lead override (if any) so a
			// previously-overridden Runner stays on the same agent across
			// retries.
			agentName: session.agent_name,
			// FLY-205: REUSE the predecessor's doc tier — never silently upgrade
			// a plan_only/none run back to full on retry. Missing value
			// (pre-FLY-205 session) → undefined → Blueprint defaults to "full".
			// issue_url keeps the doc header identical between start and retry.
			docTier: parseDocTier(session.doc_tier),
			issueUrl: session.issue_url,
			// FLY-728 Part C: REUSE the predecessor's persisted dispatch model — the
			// param the Lead-sorter chose at the original dispatch, NOT the resolved
			// runner_model (which conflates label/project/account sources). So a
			// removed label or a changed project default is NOT reintroduced; only a
			// genuine sorter/dispatch choice survives. NULL (no dispatch param) →
			// undefined → the retry re-resolves from current labels/project/account.
			// FLY-887 R2: EXCEPT phase rows — their {model, vendor, effort} comes
			// from the phase table unconditionally (see phaseDispatch above).
			dispatchModel: phaseDispatch
				? phaseDispatch.model
				: (session.dispatch_model ?? undefined),
			// FLY-1224: phase rows re-derive vendor + effort from the table (never
			// persisted — the table is the single source); non-phase → undefined.
			dispatchVendor: phaseDispatch?.vendor,
			dispatchEffort: phaseDispatch?.effort,
			// FLY-887 R2: phase rows bypass the label layer on retry too.
			ignoreRunnerLabelSelection: phaseRole ? true : undefined,
			// FLY-245 D2: gateway pre-bound successor id (plan §5.2.1) — the
			// dispatcher uses it instead of a fresh randomUUID so recovery can
			// reconcile by the durably-bound key. Absent for legacy retries.
			successorExecutionId: gatewayDispatch?.successorExecutionId,
		});
	} catch (err) {
		// PRE-dispatch failure — provably nothing started. Safe to terminalize.
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, message: `Retry dispatch failed: ${msg}` };
	}

	// ── Post-dispatch: the Runner is starting; the successor is bound. Any error
	//    from here is best-effort bookkeeping and must NOT flip the result to a
	//    "not dispatched" failure (R2 MED-6). ───────────────────────────────────
	try {
		// Link predecessor → successor
		store.setRetrySuccessor(executionId, result.newExecutionId);
		// FLY-245 D2: blueprint.run() kicked off — flip the WAL to 'dispatched'
		// (informational; recovery still trusts only started evidence).
		if (gatewayDispatch) {
			store.markRetryDispatchDispatched(gatewayDispatch.gatewayRequestId);
		}

		// FLY-137 Phase 5: persist codex_skip + agent_name + agent_match_method
		// on the NEW session row so event-route stage_changed reads the right
		// values for the retried Runner (instead of inheriting from the old row).
		// FLY-205 (Codex code R1 HIGH-2): the dispatcher returns as soon as
		// blueprint.run() is kicked off; the successor row is created later by
		// emitStarted(). A bare getSession() guard here races row creation and
		// can silently skip the patch in production — wait (bounded) instead.
		const newSession = await waitForSession(store, result.newExecutionId);
		if (newSession) {
			store.patchSessionMetadata(result.newExecutionId, {
				codex_skip: retryCodexSkip ? 1 : 0,
				...(session.agent_name
					? {
							agent_name: session.agent_name,
							agent_match_method: session.agent_match_method ?? "override",
						}
					: {}),
				// FLY-205 (Codex design R2 #1): persist tier + URL on the retry
				// SUCCESSOR row too — without this, a second retry would read an
				// empty doc_tier and drift back to "full".
				doc_tier: parseDocTier(session.doc_tier) ?? "full",
				...(session.issue_url ? { issue_url: session.issue_url } : {}),
				// FLY-728 (Codex design R2): carry the sorter's dispatch_model onto the
				// SUCCESSOR row too, or a retry-of-retry reads an empty value and the
				// sorter-chosen model is lost (mirrors doc_tier continuity).
				...(session.dispatch_model
					? { dispatch_model: session.dispatch_model }
					: {}),
			});
		} else {
			console.warn(
				`[retry] Successor session ${result.newExecutionId} not registered within wait window — ` +
					`doc_tier/codex_skip metadata NOT persisted (retry-of-retry may re-default).`,
			);
		}

		// FLY-163: forum thread unarchive removed (forum gone).

		// Post Linear comment (best-effort)
		postRetryComment(
			session.issue_id,
			executionId,
			result.newExecutionId,
			runAttempt,
			reason,
		).catch(() => {});

		// Send hook notification
		sendActionHook(
			store,
			projects ?? [],
			result.newExecutionId,
			"retry",
			session.status,
			"running",
			reason,
			eventFilter,
			registry,
			config,
		);
	} catch (err) {
		// The dispatch ALREADY started — never report not-dispatched. Log + go on.
		console.error(
			`[retry] post-dispatch bookkeeping failed for successor ${result.newExecutionId} ` +
				`(the Runner is already starting — NOT reporting as not-dispatched): ${(err as Error).message}`,
		);
	}

	return {
		success: true,
		message: `${session.issue_identifier ?? executionId} retry dispatched → ${result.newExecutionId} (attempt #${runAttempt})`,
	};
}

/** Post a comment on the Linear issue noting the retry (best-effort). */
async function postRetryComment(
	issueId: string,
	oldExecutionId: string,
	newExecutionId: string,
	attempt: number,
	reason?: string,
): Promise<void> {
	const apiKey = process.env.LINEAR_API_KEY;
	if (!apiKey) return;
	try {
		const { LinearClient } = await import("@linear/sdk");
		const client = new LinearClient({ apiKey });
		const body = [
			`**Retry dispatched** (attempt #${attempt})`,
			`- Previous execution: \`${oldExecutionId}\``,
			`- New execution: \`${newExecutionId}\``,
			reason ? `- Reason: ${reason}` : null,
		]
			.filter(Boolean)
			.join("\n");
		await client.createComment({ issueId, body });
	} catch {
		// Non-critical — silently ignore
	}
}

/** GEO-187/FLY-44: Terminate a session by transitioning to terminated and
 * tearing down its tmux + Terminal viewer.
 *
 * FLY-228: TRANSITION-FIRST. The FSM transition runs BEFORE any tmux kill, so a
 * concurrent state change that makes the transition illegal fails with the FSM
 * (and tmux) untouched — no "tmux dead + FSM still active" zombie. Cleanup is
 * then best-effort but OBSERVABLE: if the tmux kill genuinely fails, the action
 * returns `success:false` + `cleanupPending:true` (the FSM row is already
 * terminal — admission is unblocked — but the process may still be alive, so we
 * never report unqualified success). `reason` (when provided) is recorded in the
 * transition + hook audit; absent → the legacy "Terminated by CEO".
 */
export async function handleTerminate(
	store: StateStore,
	executionId: string,
	transitionOpts?: ApplyTransitionOpts,
	config?: BridgeConfig,
	projects?: ProjectEntry[],
	eventFilter?: EventFilter,
	registry?: RuntimeRegistry,
	reason?: string,
): Promise<ActionResult> {
	const session = store.getSession(executionId);
	if (!session) {
		return {
			success: false,
			message: `No session found for execution_id ${executionId}`,
		};
	}

	const actionDef = ACTION_DEFINITIONS.find((d) => d.action === "terminate");
	if (!actionDef || !actionDef.fromStates.includes(session.status)) {
		return {
			success: false,
			message: `Cannot terminate ${session.issue_identifier ?? executionId}: status is "${session.status}", expected one of: ${actionDef?.fromStates.join(", ") ?? "running"}`,
		};
	}

	const priorStatus = session.status;
	// FLY-228 (Codex code-review LOW-4): cap the reason at 500 chars HERE so
	// EVERY caller (not just the MCP abandon client) gets the same bound on the
	// persisted last_error / hook audit content.
	const auditReason = (reason?.trim() || "Terminated by CEO").slice(0, 500);

	// 1) TRANSITION FIRST (race-safe): if a concurrent change made this illegal,
	// fail here with the FSM + tmux untouched.
	if (transitionOpts) {
		const result = applyTransition(
			transitionOpts,
			session.execution_id,
			"terminated",
			{
				executionId: session.execution_id,
				issueId: session.issue_id,
				projectName: session.project_name,
				trigger: "terminate",
			},
			{ last_activity_at: sqliteDatetime(), last_error: auditReason },
		);
		if (!result.ok) {
			return {
				success: false,
				message: result.error ?? "Transition rejected by FSM",
			};
		}
	} else {
		store.forceStatus(
			session.execution_id,
			"terminated",
			sqliteDatetime(),
			auditReason,
		);
	}

	// 2) Cleanup (OBSERVABLE partial-failure): kill tmux via CommDB (source of
	// truth, not StateStore.tmux_session — see tmux-lookup.ts) + close viewer.
	// Codex code-review MED-3: a CommDB read error (corruption/lock) is NOT the
	// same as "already gone" — we can't verify tmux liveness, so it must surface
	// as cleanup-pending rather than a false success.
	let cleanupError: string | undefined;
	let physicalGone = false;
	const lookup = session.project_name
		? lookupTmuxTarget(executionId, session.project_name)
		: ({ kind: "gone" } as const);
	if (lookup.kind === "found") {
		// FLY-1185 §2.5: reap MCP-family descendants BEFORE any kill (pane pid
		// only resolvable while the window lives). Reap-only, best-effort.
		await reapRunnerMcp(lookup.target.tmuxWindow).catch(() => undefined);
		// FLY-638: tear down the per-runner cmux LINKED session BEFORE the window
		// kill (display-message needs the window alive). Best-effort.
		await killCmuxLinkedSession(lookup.target.tmuxWindow).catch((e: Error) =>
			console.warn(`[terminate] cmux session close warn: ${e.message}`),
		);
		const killResult = await killTmuxWindow(lookup.target.tmuxWindow);
		if (killResult.killed) {
			physicalGone = true;
			// FLY-116: also close per-runner Terminal viewer tab + linked viewer.
			const identity = resolveTerminalViewIdentity(session, lookup.target);
			if (identity) {
				await closeRunnerTerminalView({
					baseSessionName: identity.sessionName,
					projectName: identity.projectName,
					executionId: identity.executionId,
					windowId: identity.windowId,
					sessionRole: identity.sessionRole,
				}).catch((e: Error) =>
					console.warn(`[terminate] terminal close warn: ${e.message}`),
				);
			}
		} else if (killResult.error) {
			cleanupError = killResult.error;
		}
	} else if (lookup.kind === "error") {
		// Could not read CommDB → cannot confirm the tmux window is gone.
		cleanupError = `tmux target lookup failed: ${lookup.error}`;
	} else {
		physicalGone = true;
	}
	if (physicalGone && session.project_name) {
		const finalized = finalizeCommDbSession(executionId, session.project_name);
		store.recordCommDbFinalizeOutcome({
			executionId,
			issueId: session.issue_id,
			projectName: session.project_name,
			ok: finalized.ok,
			error: finalized.error,
		});
		if (!finalized.ok) {
			cleanupError = `commdb finalize failed: ${finalized.error ?? "unknown"}`;
		}
	}
	if (cleanupError) {
		console.error(
			`[terminate] cleanup failed for ${executionId} (FSM already terminated): ${cleanupError}`,
		);
		store.insertEvent({
			event_id: `terminate-cleanup-failed-${executionId}`,
			execution_id: executionId,
			issue_id: session.issue_id,
			project_name: session.project_name,
			event_type: "lead_terminate_cleanup_failed",
			source: "bridge.terminate",
			payload: {
				tmuxError: cleanupError,
				previousStatus: priorStatus,
				reason: auditReason,
			},
		});
	}

	// 3) Hook (fires regardless — the FSM transition is the authoritative outcome).
	sendActionHook(
		store,
		projects ?? [],
		executionId,
		"terminate",
		priorStatus,
		"terminated",
		auditReason,
		eventFilter,
		registry,
		config,
	);

	const id = session.issue_identifier ?? executionId;
	if (cleanupError) {
		return {
			success: false,
			cleanupPending: true,
			message: `${id} transitioned to terminated, but tmux cleanup failed: ${cleanupError}. The FSM row is terminal (no longer blocks admission); re-run close_runner to reap the tmux window.`,
		};
	}
	return {
		success: true,
		message: `${id} terminated successfully`,
	};
}

/** GEO-259: Check lead scope for a session. Returns error response or null (in-scope). */
function checkLeadScope(
	session: {
		execution_id: string;
		project_name: string;
		issue_labels?: string;
	},
	leadId: string | undefined,
	projects: ProjectEntry[],
	action: string,
): { status: number; body: object } | null {
	if (!leadId) return null;
	try {
		if (
			!matchesLead(
				session as import("../StateStore.js").Session,
				leadId,
				projects,
			)
		) {
			return {
				status: 403,
				body: {
					success: false,
					message: `Session ${session.execution_id} is outside lead "${leadId}" scope`,
					action,
				},
			};
		}
	} catch (err) {
		console.warn(
			`[actions] Cannot verify lead scope for ${session.execution_id}: ${(err as Error).message}`,
		);
		return {
			status: 403,
			body: {
				success: false,
				message: `Cannot verify lead scope for session ${session.execution_id}`,
				action,
			},
		};
	}
	return null;
}

export function createActionRouter(
	store: StateStore,
	projects: ProjectEntry[],
	transitionOpts?: ApplyTransitionOpts,
	config?: BridgeConfig,
	retryDispatcher?: IRetryDispatcher,
	cipherWriter?: CipherWriter,
	eventFilter?: EventFilter,
	/** FLY-163: positional slot kept (was forumTagUpdater); now ignored. */
	_unusedForumTagUpdater?: unknown,
	registry?: RuntimeRegistry,
	onApproved?: (executionId: string, session: Session) => void,
	// FLY-907: unified issue-display refresh holder (late-bound; read at
	// request time). Threaded into approveExecution's recovered-merge path.
	issueDisplayRefresh?: {
		current?: { refresh(issueId: string): Promise<void> };
	},
	// FLY-1050: late-bound three-stage PhaseOrchestrator holder (same pattern
	// as issueDisplayRefresh). A terminate of a three-stage QA row re-drives
	// the implement→QA handoff (respawn) + the scoped belt reconcile —
	// terminate previously notified the orchestrator of NOTHING (the FLY-967
	// strand). plugin.ts must pass it at BOTH createActionRouter call sites
	// (/actions dashboard alias + /api/actions — the FLY-175 dual-mount).
	phaseOrchestrator?: { current?: PhaseOrchestrator },
	cardAuthority?: FounderApprovalCardAuthority,
): Router {
	const router = Router();

	router.post("/:action", async (req, res) => {
		const action = req.params.action;

		// GEO-259: Extract leadId for scope check (optional, backwards-compatible)
		const { leadId } = req.body ?? {};

		switch (action) {
			case "approve": {
				const { execution_id, identifier } = req.body ?? {};
				if (!execution_id || typeof execution_id !== "string") {
					res.status(400).json({ error: "execution_id is required" });
					return;
				}
				{
					const sess = store.getSession(execution_id);
					if (sess) {
						const scopeErr = checkLeadScope(sess, leadId, projects, action);
						if (scopeErr) {
							res.status(scopeErr.status).json(scopeErr.body);
							return;
						}
					}
				}
				const result = await approveExecution(
					store,
					projects,
					execution_id,
					identifier,
					undefined,
					transitionOpts,
					config,
					cipherWriter,
					eventFilter,
					undefined, // _unusedForumTagUpdater (FLY-163)
					registry,
					onApproved,
					// FLY-907: recovered-merge finalization display refresh.
					issueDisplayRefresh?.current
						? (issueId) =>
								issueDisplayRefresh.current?.refresh(issueId) ??
								Promise.resolve()
						: undefined,
					cardAuthority,
				);
				if (result.success) {
					res.json({
						success: true,
						message: result.message,
						action: "approve",
						identifier,
						gateUnblocked: result.gateUnblocked,
					});
				} else {
					res.status(400).json({
						success: false,
						message: result.message,
						action: "approve",
					});
				}
				return;
			}
			case "terminate": {
				const { execution_id: eid, reason: terminateReason } = req.body ?? {};
				if (!eid || typeof eid !== "string") {
					res.status(400).json({ error: "execution_id is required" });
					return;
				}
				// FLY-1050: pre-read hoisted out of the scope-check block — the
				// post-terminate hook below needs the ORIGINAL row (chat_thread_role /
				// issue_id / project_name), not a post-transition re-read.
				const sess = store.getSession(eid);
				if (sess) {
					const scopeErr = checkLeadScope(sess, leadId, projects, action);
					if (scopeErr) {
						res.status(scopeErr.status).json(scopeErr.body);
						return;
					}
				}
				const terminateResult = await handleTerminate(
					store,
					eid,
					transitionOpts,
					config,
					projects,
					eventFilter,
					registry,
					// FLY-228: optional audit reason (e.g. close_runner --abandon).
					typeof terminateReason === "string" ? terminateReason : undefined,
				);
				// FLY-1050: a terminated three-stage QA row may have stranded its
				// implement at awaiting_review — fire the scoped QA-loss re-drive,
				// then the scoped belt reconcile (terminate previously did NEITHER).
				// The guard MUST include cleanupPending (Codex R1 #2): that shape is
				// success:false + cleanupPending:true, but the FSM row is already
				// terminal either way — a residual live tmux is caught downstream by
				// the ghostGuard (spawn) and the liveness probe (belt). Never-throw,
				// fire-and-forget (mirrors plugin.ts holder conventions).
				if (
					(terminateResult.success || terminateResult.cleanupPending) &&
					sess?.project_name &&
					(sess.chat_thread_role ?? "main") === "qa"
				) {
					const issueId = sess.issue_id;
					const projectName = sess.project_name;
					void phaseOrchestrator?.current
						?.reconcileQaLoss({ issueId, terminalExecId: eid })
						.then(() =>
							phaseOrchestrator?.current?.reconcileTurnBelt({
								issueId,
								projectName,
								terminalExecId: eid,
							}),
						)
						.catch((err) =>
							console.warn(
								`[terminate] FLY-1050 qa-loss reconcile failed for ${eid}: ${(err as Error).message}`,
							),
						);
				}
				if (terminateResult.success) {
					res.json({
						success: true,
						message: terminateResult.message,
						action: "terminate",
					});
				} else {
					res.status(400).json({
						success: false,
						message: terminateResult.message,
						action: "terminate",
						// FLY-228: signal FSM-terminated-but-tmux-cleanup-pending so the
						// caller (close_runner --abandon) can distinguish it from a hard
						// "could not terminate" failure.
						...(terminateResult.cleanupPending ? { cleanupPending: true } : {}),
					});
				}
				return;
			}
			case "retry": {
				const {
					execution_id: eid,
					reason,
					context,
					gateway_request_id: gwRequestId,
					successor_execution_id: gwSuccessorId,
				} = req.body ?? {};
				if (!eid || typeof eid !== "string") {
					res.status(400).json({ error: "execution_id is required" });
					return;
				}
				// FLY-245 D2 boundary validation (plan §5.2.1): the gateway
				// pre-bound dispatch fields travel together and are format-checked
				// at the system boundary. Both-or-neither; sane charsets only.
				const hasGwReq =
					gwRequestId !== undefined &&
					gwRequestId !== null &&
					gwRequestId !== "";
				const hasGwSucc =
					gwSuccessorId !== undefined &&
					gwSuccessorId !== null &&
					gwSuccessorId !== "";
				if (hasGwReq !== hasGwSucc) {
					res.status(400).json({
						error:
							"gateway_request_id and successor_execution_id must be provided together",
					});
					return;
				}
				if (
					hasGwReq &&
					(typeof gwRequestId !== "string" ||
						!/^[A-Za-z0-9_.:-]{6,128}$/.test(gwRequestId) ||
						typeof gwSuccessorId !== "string" ||
						!/^[A-Za-z0-9-]{8,64}$/.test(gwSuccessorId))
				) {
					res.status(400).json({
						error: "malformed gateway_request_id or successor_execution_id",
					});
					return;
				}
				{
					const sess = store.getSession(eid);
					if (sess) {
						const scopeErr = checkLeadScope(sess, leadId, projects, action);
						if (scopeErr) {
							res.status(scopeErr.status).json(scopeErr.body);
							return;
						}
					}
				}
				if (retryDispatcher) {
					const retryResult = await handleRetry(
						store,
						retryDispatcher,
						eid,
						reason,
						config,
						projects,
						eventFilter,
						typeof context === "string" ? context : undefined,
						registry,
						hasGwReq
							? {
									gatewayRequestId: gwRequestId as string,
									successorExecutionId: gwSuccessorId as string,
								}
							: undefined,
					);
					if (retryResult.success) {
						res.json({
							success: true,
							message: retryResult.message,
							action: "retry",
						});
					} else {
						res.status(400).json({
							success: false,
							message: retryResult.message,
							action: "retry",
						});
					}
				} else {
					// Fallback: legacy transition (no actual re-dispatch)
					const actionResult = await transitionSession(
						store,
						action,
						eid,
						reason,
						transitionOpts,
						config,
						cipherWriter,
						projects,
						eventFilter,
						undefined, // _unusedForumTagUpdater (FLY-163)
						registry,
					);
					if (actionResult.success) {
						res.json({ success: true, message: actionResult.message, action });
					} else {
						res
							.status(400)
							.json({ success: false, message: actionResult.message, action });
					}
				}
				return;
			}
			case "reject":
			case "defer":
			case "shelve": {
				const { execution_id: eid, reason } = req.body ?? {};
				if (!eid || typeof eid !== "string") {
					res.status(400).json({ error: "execution_id is required" });
					return;
				}
				{
					const sess = store.getSession(eid);
					if (sess) {
						const scopeErr = checkLeadScope(sess, leadId, projects, action);
						if (scopeErr) {
							res.status(scopeErr.status).json(scopeErr.body);
							return;
						}
					}
				}
				const actionResult = await transitionSession(
					store,
					action,
					eid,
					reason,
					transitionOpts,
					config,
					cipherWriter,
					projects,
					eventFilter,
					undefined, // _unusedForumTagUpdater (FLY-163)
					registry,
				);
				if (actionResult.success) {
					res.json({ success: true, message: actionResult.message, action });
				} else {
					res
						.status(400)
						.json({ success: false, message: actionResult.message, action });
				}
				return;
			}
			default:
				res.status(400).json({ error: `Unknown action: ${action}` });
				return;
		}
	});

	return router;
}
