import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { CommDB } from "flywheel-comm/db";
import {
	decodePonytailConditionForRetry,
	isWorkflowPhaseRole,
} from "flywheel-config";
import { ACTION_DEFINITIONS, closeRunnerTerminalView } from "flywheel-core";
import type { ActionResult, CipherWriter } from "flywheel-edge-worker";
import {
	parseDocTier,
	type WorkflowIssueDeliveryInput,
} from "flywheel-edge-worker/dist/Blueprint.js";
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
import { resolveNodeDispatchAtLaunch } from "../workflow-dispatch-resolution.js";
import {
	nodeRequiresFounderReview,
	parseWorkflowRunSnapshot,
	resolveWorkflowDecisionContract,
	workflowGateEntryPromptCapabilities,
	workflowNodeAgentContent,
} from "../workflow-run-snapshot.js";
import { credentialWindowForNode } from "../workflow-submission-expiry.js";
import type { GateAuthorityView } from "./approval-signal/gate-authority-view.js";
import {
	type FounderApprovalCardAuthority,
	writeGateResponseAndRunPostWrite,
} from "./approval-signal/write-gate-response.js";
import { reviewHoldReason } from "./auto-qa-held.js";
import { resolveChatThreadId } from "./chat-thread-utils.js";
import {
	AUTO_CLOSE_STATES,
	closeRunner,
	type RunCloseAuthority,
} from "./close-runner.js";
import { reapCodexDaemonForSession } from "./codex-daemon-teardown.js";
import { finalizeCommDbSession } from "./commdb-session-prune.js";
import type { EventFilter } from "./EventFilter.js";
import {
	getGeneralizedLaunchDelivery,
	probeGeneralizedLaunchLiveness,
	waitForGeneralizedLaunchDelivery,
} from "./generalized-launch-recovery.js";
import { buildSessionKey, type HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { matchesLead } from "./lead-scope.js";
import type { MaterializedHeadAuthority } from "./materialized-head-authority.js";
import { finalizeRecoveredMerge } from "./merge-ship-gate.js";
import { makeFinalizeWorkflowPhaseRoles } from "./post-ship-finalization.js";
import { reconcileGatewayRetry } from "./retry-dispatch-wal.js";
import type {
	GeneralizedExecutionDispatch,
	IRetryDispatcher,
} from "./retry-dispatcher.js";
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
import type { TurnBeltReconciler } from "./turn-belt-reconcile.js";
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
		const { lead } = registry.resolveWithLead(
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
				eventId,
				event: hookPayload,
				sessionKey,
				leadId: lead.agentId,
				timestamp: new Date().toISOString(),
			};
			const result = await registry.dispatchLeadEvent(envelope);
			if (result.delivered) store.markLeadEventDelivered(seq);
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
	materializedHeadAuthority?: MaterializedHeadAuthority,
	gateAuthorityView?: GateAuthorityView,
): Promise<ActionResult> {
	const session = store.getSession(executionId);
	const engineAuthority = gateAuthorityView?.resolveForExecution?.(executionId);
	if (!session && !engineAuthority) {
		return {
			success: false,
			message: `No session found for execution_id ${executionId}`,
		};
	}

	if (!engineAuthority && session?.status !== "awaiting_review") {
		return {
			success: false,
			message: `Cannot approve ${identifier ?? executionId}: status is "${session?.status ?? "unknown"}", expected "awaiting_review"`,
		};
	}

	const projectName = engineAuthority?.projectName ?? session!.project_name;
	const project = projects.find((p) => p.projectName === projectName);
	if (!project) {
		return {
			success: false,
			message: `Unknown project: ${projectName}`,
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
		const commDbPath = commDbPathFor(projectName);
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
			const boundId =
				engineAuthority?.questionId ?? session?.review_question_id?.trim();
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
				gateAuthorityView,
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
	if (engineAuthority) {
		return {
			success: true,
			message: `Approved ${identifier ?? executionId} → automated land activated (gate unblocked)`,
			alreadyResponded: true,
			gateUnblocked,
		};
	}
	if (!session) {
		return {
			success: false,
			message: `No session found for execution_id ${executionId}`,
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
			// DAG workflow issue's parked phases like every other completion sink.
			transitionOpts
				? makeFinalizeWorkflowPhaseRoles(
						store,
						transitionOpts,
						refreshIssueDisplay,
					)
				: undefined,
			materializedHeadAuthority,
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

	// FLY-1404: admission belongs to the design-node completion semantic, not
	// to a particular workflow topology. Resolve it BEFORE closeRunner: a
	// missing Lead must not destroy the preserved design context and only then
	// discover that nobody can consume the founder HTML report.
	const phaseRole = isWorkflowPhaseRole(session.chat_thread_role)
		? session.chat_thread_role
		: undefined;
	const preflightGeneralizedBinding =
		store.getGeneralizedWorkflowNodeForExecution(executionId)?.binding;
	let generalizedDesignNode = false;
	if (preflightGeneralizedBinding) {
		const run = store.getWorkflowRun(preflightGeneralizedBinding.run_id);
		if (!run?.snapshot) {
			return {
				success: false,
				message: "Retry dispatch failed: generalized workflow snapshot missing",
			};
		}
		try {
			const snapshot = parseWorkflowRunSnapshot(run.snapshot);
			const node = snapshot.resolved.nodes.find(
				(candidate) => candidate.id === preflightGeneralizedBinding.node_id,
			);
			generalizedDesignNode =
				node?.capabilities.completion_route === "phase_design_complete";
		} catch (error) {
			return {
				success: false,
				message: `Retry dispatch failed: ${(error as Error).message}`,
			};
		}
	}
	if (
		(phaseRole === "design" || generalizedDesignNode) &&
		(typeof retryLeadId !== "string" || !retryLeadId.trim())
	) {
		return {
			success: false,
			message:
				"Retry dispatch failed: design-node completion requires a resolved Lead for founder HTML delivery; preserved runner left intact",
		};
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
	let retryLabelsReadable = false;
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
			retryLabelsReadable = true;
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
	const ponytailRetryPlan = decodePonytailConditionForRetry(
		session.ponytail_condition,
	);
	const ponytailRetry = {
		...(ponytailRetryPlan?.kind === "frozen" && {
			frozen: ponytailRetryPlan.requested,
		}),
		freshSignal: retryLabelsReadable
			? {
					labelStatus: "readable" as const,
					labels: retryIssueLabels ?? [],
				}
			: { labelStatus: "unreadable" as const },
	};

	let generalizedExecution: GeneralizedExecutionDispatch | undefined;
	let adoptedGeneralizedExecutionId: string | undefined;
	let generalizedLaunchReleaseFence:
		| {
				executionId: string;
				ownerId: string;
				generation: number;
				markerPath: string;
		  }
		| undefined;
	const predecessorBinding = preflightGeneralizedBinding;
	if (predecessorBinding) {
		const run = store.getWorkflowRun(predecessorBinding.run_id);
		if (!run?.snapshot) {
			return {
				success: false,
				message: "Retry dispatch failed: generalized workflow snapshot missing",
			};
		}
		let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
		try {
			snapshot = parseWorkflowRunSnapshot(run.snapshot);
		} catch (error) {
			return {
				success: false,
				message: `Retry dispatch failed: ${(error as Error).message}`,
			};
		}
		const node = snapshot.resolved.nodes.find(
			(candidate) => candidate.id === predecessorBinding.node_id,
		);
		const agentContent = node ? workflowNodeAgentContent(node) : undefined;
		if (!node?.dispatch || !agentContent) {
			return {
				success: false,
				message:
					"Retry dispatch failed: generalized node is not an executable generic node",
			};
		}
		const successorExecutionId =
			gatewayDispatch?.successorExecutionId ?? randomUUID();
		const now = new Date();
		const credentialWindow = credentialWindowForNode(snapshot, node.id, now);
		const decisionContract = resolveWorkflowDecisionContract(snapshot, node.id);
		const dispatchResolution = resolveNodeDispatchAtLaunch(store, {
			runId: predecessorBinding.run_id,
			nodeId: predecessorBinding.node_id,
		});
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: predecessorBinding.run_id,
			nodeId: predecessorBinding.node_id,
			executionId: successorExecutionId,
			attempt: predecessorBinding.attempt + 1,
			expiresAt: credentialWindow.expiresAt,
			absoluteDeadlineAt: credentialWindow.absoluteDeadlineAt,
			now: now.toISOString(),
			dispatchResolution,
		});
		if (!admitted.ok) {
			return {
				success: false,
				message: `Retry dispatch failed: generalized admission ${admitted.reason}`,
			};
		}
		const runtime = store.getWorkflowExecutionRuntime(successorExecutionId);
		if (!runtime) {
			return {
				success: false,
				message: "Retry dispatch failed: generalized runtime dispatch missing",
			};
		}
		const runtimeDispatch = {
			vendor: runtime.vendor as "claude" | "codex",
			model: runtime.model,
			...(runtime.effort
				? {
						effort: runtime.effort as
							| "low"
							| "medium"
							| "high"
							| "xhigh"
							| "max",
					}
				: {}),
		};
		const launchOwnerId = randomUUID();
		const launchMarkerPath = join(
			process.env.HOME ?? homedir(),
			".flywheel",
			"state",
			"launch-commits",
			successorExecutionId,
		);
		const launch = store.recoverOrAcquireWorkflowLaunch({
			executionId: successorExecutionId,
			ownerId: launchOwnerId,
			now: now.toISOString(),
			leaseExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
			markerPath: launchMarkerPath,
		});
		if (
			launch.status === "hold" ||
			launch.status === "busy" ||
			launch.status === "cancelled"
		) {
			return {
				success: false,
				message:
					launch.status === "hold"
						? `Retry dispatch held: generalized launch ${launch.reason}`
						: launch.status === "cancelled"
							? `Retry dispatch held: generalized launch generation ${launch.generation} was cancelled`
							: `Retry dispatch held: generalized owner generation ${launch.generation} is active`,
			};
		}
		let outputCredential = admitted.outputCredential;
		let submissionCredential = admitted.submissionCredential;
		let launchGateToken: string | undefined;
		let launchGeneration: number | undefined;
		let launchDeliveryAuthority:
			| { generation: number; attempt: number }
			| undefined;
		let commitWorkflowLaunch:
			| (() => { ok: boolean; reason?: string })
			| undefined;
		if (launch.status === "committed") {
			const liveness = store.getSession(successorExecutionId)
				? "alive"
				: await probeGeneralizedLaunchLiveness(
						successorExecutionId,
						session.project_name,
					);
			if (liveness === "unknown") {
				return {
					success: false,
					message:
						"Retry dispatch held: committed generalized launch liveness is unknown",
				};
			}
			if (liveness === "alive") {
				adoptedGeneralizedExecutionId = successorExecutionId;
			} else {
				if (node.capabilities.produces_output) {
					return {
						success: false,
						message:
							"Retry dispatch held: committed output credential cannot be reconstructed for delivery repair",
					};
				}
				const repairNow = new Date();
				const repair = store.claimWorkflowLaunchDeliveryRepair({
					executionId: successorExecutionId,
					repairOwner: launchOwnerId,
					now: repairNow.toISOString(),
					leaseExpiresAt: new Date(
						repairNow.getTime() + 15 * 60_000,
					).toISOString(),
				});
				if (repair.status !== "claimed") {
					return {
						success: false,
						message:
							repair.status === "busy"
								? `Retry dispatch held: delivery repair attempt ${repair.attempt} is active`
								: repair.status === "cancelled"
									? `Retry dispatch held: delivery repair generation ${repair.generation} was cancelled`
									: `Retry dispatch held: delivery repair ${repair.reason}`,
					};
				}
				launchGateToken = repair.token;
				launchGeneration = repair.generation;
				launchDeliveryAuthority = {
					generation: repair.generation,
					attempt: repair.attempt,
				};
				commitWorkflowLaunch = () =>
					store.commitWorkflowLaunchDeliveryRepair({
						executionId: successorExecutionId,
						repairOwner: launchOwnerId,
						generation: repair.generation,
						attempt: repair.attempt,
						markerPath: launchMarkerPath,
						now: new Date().toISOString(),
					});
			}
		} else {
			generalizedLaunchReleaseFence = {
				executionId: successorExecutionId,
				ownerId: launchOwnerId,
				generation: launch.generation,
				markerPath: launchMarkerPath,
			};
			const rotationNow = new Date();
			const rotationWindow = credentialWindowForNode(
				snapshot,
				node.id,
				rotationNow,
			);
			if (node.capabilities.produces_output && !outputCredential) {
				const rotated = store.rotateGeneralizedWorkflowOutputCredential({
					executionId: successorExecutionId,
					ownerId: launchOwnerId,
					generation: launch.generation,
					now: rotationNow.toISOString(),
					expiresAt: rotationWindow.expiresAt,
					absoluteDeadlineAt: rotationWindow.absoluteDeadlineAt,
				});
				if (!rotated.ok) {
					return {
						success: false,
						message: `Retry dispatch held: generalized credential rotation ${rotated.reason}`,
					};
				}
				outputCredential = rotated.outputCredential;
			}
			if (decisionContract && !submissionCredential) {
				const rotated = store.rotateGeneralizedWorkflowSubmissionCredential({
					executionId: successorExecutionId,
					ownerId: launchOwnerId,
					generation: launch.generation,
					now: rotationNow.toISOString(),
					expiresAt: rotationWindow.expiresAt,
					absoluteDeadlineAt: rotationWindow.absoluteDeadlineAt,
				});
				if (!rotated.ok) {
					return {
						success: false,
						message: `Retry dispatch held: generalized submission credential rotation ${rotated.reason}`,
					};
				}
				submissionCredential = rotated.submissionCredential;
			}
			const renewalNow = new Date();
			const renewed = store.renewWorkflowLaunchOwner({
				executionId: successorExecutionId,
				ownerId: launchOwnerId,
				generation: launch.generation,
				now: renewalNow.toISOString(),
				leaseExpiresAt: new Date(
					renewalNow.getTime() + 15 * 60_000,
				).toISOString(),
			});
			if (!renewed.ok) {
				return {
					success: false,
					message: `Retry dispatch held: generalized launch renewal ${renewed.reason}`,
				};
			}
			launchGateToken = launch.token;
			launchGeneration = launch.generation;
			launchDeliveryAuthority = {
				generation: launch.generation,
				attempt: launch.deliveryAttempt,
			};
			commitWorkflowLaunch = () =>
				store.fencedCommitWorkflowLaunch({
					executionId: successorExecutionId,
					ownerId: launchOwnerId,
					generation: launch.generation,
					deliveryAttempt: launch.deliveryAttempt,
					markerPath: launchMarkerPath,
					now: new Date().toISOString(),
				});
		}
		if (!adoptedGeneralizedExecutionId) {
			const deliveryAuthority = launchDeliveryAuthority;
			const prepareWorkflowIssueDelivery = deliveryAuthority
				? (input: WorkflowIssueDeliveryInput) => {
						const { anchorCommit, ...candidate } = input;
						const prepared = store.prepareWorkflowIssueDelivery({
							executionId: successorExecutionId,
							activationId: admitted.activationId,
							ownerId: launchOwnerId,
							ownerGeneration: deliveryAuthority.generation,
							deliveryAttempt: deliveryAuthority.attempt,
							anchorCommit,
							candidate,
							now: new Date().toISOString(),
						});
						if (!prepared.ok) throw new Error(prepared.reason);
					}
				: undefined;
			generalizedExecution = {
				engineOwned: run.engine_owned === 1,
				executionId: successorExecutionId,
				activationId: admitted.activationId,
				runId: predecessorBinding.run_id,
				nodeId: predecessorBinding.node_id,
				attempt: predecessorBinding.attempt + 1,
				snapshotDigest: snapshot.snapshot_digest,
				gateCarrierEpoch: run.gate_carrier_epoch,
				dispatch: runtimeDispatch,
				capabilities: {
					...node.capabilities,
					founder_review_required: nodeRequiresFounderReview(snapshot, node.id),
					...workflowGateEntryPromptCapabilities(snapshot, node.id),
				},
				agentContent,
				outputCredential,
				submissionCredential,
				idempotencyKey: `retry:${executionId}:${successorExecutionId}`,
				launchGateToken,
				launchGeneration,
				commitWorkflowLaunch,
				...(prepareWorkflowIssueDelivery && {
					prepareWorkflowIssueDelivery,
				}),
				projectTurn: (turn) => store.recordWorkflowActivationTurn(turn),
			};
		}
	}

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
	if (adoptedGeneralizedExecutionId) {
		result = {
			newExecutionId: adoptedGeneralizedExecutionId,
			oldExecutionId: executionId,
		};
	} else {
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
				...(phaseRole && session.design_backend
					? { designBackend: session.design_backend }
					: {}),
				// FLY-1356: forced-arm continuation on retry (via==="override" only;
				// sticky/hash ride the dispatcher's stamp lookup — R1#4).
				...(session.skill_framework_mode_via === "override" &&
					session.skill_framework_mode && {
						skillFrameworkMode: session.skill_framework_mode,
					}),
				ponytailRetry,
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
				dispatchModel: session.dispatch_model ?? undefined,
				// FLY-245 D2: gateway pre-bound successor id (plan §5.2.1) — the
				// dispatcher uses it instead of a fresh randomUUID so recovery can
				// reconcile by the durably-bound key. Absent for legacy retries.
				successorExecutionId:
					generalizedExecution?.executionId ??
					gatewayDispatch?.successorExecutionId,
				generalizedExecution,
			});
		} catch (err) {
			// PRE-dispatch failure — provably nothing started. Safe to terminalize.
			const msg = err instanceof Error ? err.message : String(err);
			if (generalizedLaunchReleaseFence) {
				const released = store.releaseFailedWorkflowLaunch({
					...generalizedLaunchReleaseFence,
					now: new Date().toISOString(),
					reason: `dispatcher_start_failed:${msg}`,
					physicalEvidence: "absent",
				});
				if (!released.ok) {
					console.error(
						`[retry] generalized launch release failed for ${generalizedLaunchReleaseFence.executionId}: ${released.reason}`,
					);
				}
			}
			return { success: false, message: `Retry dispatch failed: ${msg}` };
		}
	}
	// ── Post-dispatch: the Runner is starting; the successor is bound. Any error
	//    from here is best-effort bookkeeping and must NOT flip the result to a
	//    "not dispatched" failure (R2 MED-6). ───────────────────────────────────
	try {
		store.setRetrySuccessor(executionId, result.newExecutionId);
	} catch (err) {
		console.error(
			`[retry] post-dispatch lineage write failed for successor ${result.newExecutionId} ` +
				`(the Runner is already starting): ${(err as Error).message}`,
		);
	}
	if (gatewayDispatch) {
		try {
			store.markRetryDispatchDispatched(gatewayDispatch.gatewayRequestId);
		} catch (err) {
			console.error(
				`[retry] post-dispatch WAL write failed for successor ${result.newExecutionId} ` +
					`(the Runner is already starting): ${(err as Error).message}`,
			);
		}
	}

	let launchPending = false;
	if (predecessorBinding) {
		try {
			let delivered = await waitForGeneralizedLaunchDelivery(
				store,
				result.newExecutionId,
			);
			// Close the same wait-boundary race as /api/runs/start.
			delivered ??= getGeneralizedLaunchDelivery(store, result.newExecutionId);
			launchPending = !delivered;
		} catch (err) {
			launchPending = true;
			console.error(
				`[retry] generalized launch delivery check failed for successor ${result.newExecutionId} ` +
					`(reporting accepted-pending): ${(err as Error).message}`,
			);
		}
	}

	try {
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

	if (launchPending) {
		return {
			success: true,
			pending: true,
			message: `${session.issue_identifier ?? executionId} retry accepted → ${result.newExecutionId}; generalized launch delivery confirmation is pending`,
		};
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
	runCloseAuthority?: RunCloseAuthority,
): Promise<ActionResult> {
	const session = store.getSession(executionId);
	if (!session) {
		return {
			success: false,
			message: `No session found for execution_id ${executionId}`,
		};
	}
	if (
		session.status === "terminated" &&
		runCloseAuthority?.mode === "abandon"
	) {
		const intent = store.getWorkflowOperatorCloseIntent(executionId);
		if (intent?.stage === "committed" && intent.mode === "abandon") {
			try {
				const cascade = store.cascadeRunTerminationOnCarrierClose({
					executionId,
					mode: "abandon",
					principal: runCloseAuthority.principal,
					now: new Date().toISOString(),
				});
				if (cascade.ok && !cascade.idempotentReplay) {
					store.ensureTerminalWorkflowRunCollection({
						runId: cascade.runId,
						now: new Date().toISOString(),
					});
				}
				return {
					success: true,
					message: `${session.issue_identifier ?? executionId} already terminated`,
				};
			} catch (error) {
				return {
					success: false,
					message: `Run close cascade failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
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
	if (runCloseAuthority) {
		const prepared = store.prepareWorkflowOperatorCloseIntent({
			executionId,
			mode: runCloseAuthority.mode,
			reason: auditReason,
			now: new Date().toISOString(),
		});
		if (!prepared.ok) {
			return { success: false, message: prepared.reason };
		}
	}

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
			if (runCloseAuthority) {
				store.finalizeWorkflowOperatorCloseIntent({
					executionId,
					stage: "failed",
					now: new Date().toISOString(),
				});
			}
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

	// 2) Cleanup (OBSERVABLE partial-failure): reap the detached Codex group,
	// then kill tmux via CommDB (source of
	// truth, not StateStore.tmux_session — see tmux-lookup.ts) + close viewer.
	// Codex code-review MED-3: a CommDB read error (corruption/lock) is NOT the
	// same as "already gone" — we can't verify tmux liveness, so it must surface
	// as cleanup-pending rather than a false success.
	let cleanupError: string | undefined;
	let physicalGone = false;
	await reapCodexDaemonForSession(store, session, "bridge.terminate");
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
			audit: {
				retiredGateCount: finalized.retiredGateCount,
				retiredAskCount: finalized.retiredAskCount,
				source: "bridge.actions",
			},
		});
		if (!finalized.ok) {
			cleanupError = `commdb finalize failed: ${finalized.error ?? "unknown"}`;
		}
	}
	if (runCloseAuthority) {
		const intentStage = cleanupError ? "failed" : "committed";
		const finalized = store.finalizeWorkflowOperatorCloseIntent({
			executionId,
			stage: intentStage,
			now: new Date().toISOString(),
		});
		if (!finalized.ok) {
			cleanupError = `close intent finalization failed: ${finalized.reason}`;
		} else if (intentStage === "committed") {
			try {
				const cascade = store.cascadeRunTerminationOnCarrierClose({
					executionId,
					mode: runCloseAuthority.mode,
					principal: runCloseAuthority.principal,
					now: new Date().toISOString(),
				});
				if (cascade.ok && !cascade.idempotentReplay) {
					store.ensureTerminalWorkflowRunCollection({
						runId: cascade.runId,
						now: new Date().toISOString(),
					});
				}
			} catch (error) {
				console.warn(
					`[terminate] run close cascade deferred for ${executionId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
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
	turnBeltReconciler?: { current?: TurnBeltReconciler },
	cardAuthority?: FounderApprovalCardAuthority,
	materializedHeadAuthority?: MaterializedHeadAuthority,
	gateAuthorityView?: GateAuthorityView,
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
				if (typeof leadId === "string" && leadId.trim()) {
					res.status(403).json({
						success: false,
						error: "lead_ack_rejected",
						message:
							"Lead-attributed approval cannot resolve a founder-bound gate",
						action: "approve",
					});
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
					materializedHeadAuthority,
					gateAuthorityView,
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
					{
						mode: "abandon",
						principal:
							typeof leadId === "string" && leadId.trim()
								? leadId.trim()
								: "founder",
					},
				);
				if (
					(terminateResult.success || terminateResult.cleanupPending) &&
					sess?.project_name &&
					isWorkflowPhaseRole(sess.session_role)
				) {
					const issueId = sess.issue_id;
					const projectName = sess.project_name;
					void turnBeltReconciler?.current
						?.reconcileTurnBelt({
							issueId,
							projectName,
							terminalExecId: eid,
						})
						.catch((err) =>
							console.warn(
								`[terminate] TURN reconcile failed for ${eid}: ${(err as Error).message}`,
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
						res.status(retryResult.pending ? 202 : 200).json({
							success: true,
							...(retryResult.pending ? { pending: true } : {}),
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
