import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import { ACTION_DEFINITIONS } from "flywheel-core";
import type { ActionResult, CipherWriter } from "flywheel-edge-worker";
import { ApproveHandler } from "flywheel-edge-worker";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import type { EventFilter } from "./EventFilter.js";
import type { ForumTagUpdater } from "./ForumTagUpdater.js";
import { buildSessionKey, type HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { matchesLead } from "./lead-scope.js";
import type { IRetryDispatcher } from "./retry-dispatcher.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { STAGE_ORDER } from "./stage-utils.js";
import { getTmuxTargetFromCommDb, killTmuxSession } from "./tmux-lookup.js";
import { type BridgeConfig, sqliteDatetime } from "./types.js";

type ExecFn = (
	cmd: string,
	args: string[],
	cwd: string,
) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

const defaultExec: ExecFn = async (cmd, args, cwd) => {
	const result = await execFileAsync(cmd, args, { cwd, encoding: "utf-8" });
	return { stdout: result.stdout };
};

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
	forumTagUpdater?: ForumTagUpdater,
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
		const existingThread = store.getThreadByIssue(session.issue_id);
		const forumChannel = existingThread?.channel ?? lead.forumChannel;
		const hookPayload: HookPayload = {
			event_type: "action_executed",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: targetStatus,
			thread_id: session.thread_id,
			forum_channel: forumChannel,
			chat_channel: lead.chatChannel,
			issue_labels: labels,
			action,
			action_source_status: sourceStatus,
			action_target_status: targetStatus,
			action_reason: reason,
		};

		const doDeliver = async () => {
			if (eventFilter) {
				const filterResult = eventFilter.classify(
					"action_executed",
					hookPayload,
				);

				let tagResult: HookPayload["forum_tag_update_result"];
				if (forumTagUpdater) {
					tagResult = await forumTagUpdater.updateTag({
						threadId: session.thread_id,
						status: targetStatus,
						eventType: "action_executed",
						action,
						discordBotToken: lead.botToken ?? config?.discordBotToken,
						statusTagMap: lead.statusTagMap,
					});
				}

				if (filterResult.action === "notify_agent") {
					hookPayload.filter_priority = filterResult.priority;
					hookPayload.notification_context = filterResult.reason;
					hookPayload.forum_tag_update_result = tagResult;
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
				}
			} else {
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
			}
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

export async function approveExecution(
	store: StateStore,
	projects: ProjectEntry[],
	executionId: string,
	identifier?: string,
	execFn?: ExecFn,
	transitionOpts?: ApplyTransitionOpts,
	config?: BridgeConfig,
	cipherWriter?: CipherWriter,
	eventFilter?: EventFilter,
	forumTagUpdater?: ForumTagUpdater,
	registry?: RuntimeRegistry,
	onApproved?: (executionId: string, session: Session) => void,
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

	// Capture timestamp before execute() so CIPHER doesn't include merge latency
	const ceoActionTimestamp = new Date().toISOString();
	const handler = new ApproveHandler(
		execFn ?? defaultExec,
		project.projectRoot,
		project.projectRepo,
	);
	const result = await handler.execute({
		actionId: `flywheel_approve_${session.issue_id}`,
		issueId: session.issue_id,
		action: "approve",
		userId: "openclaw-agent",
		responseUrl: "",
		messageTs: Date.now().toString(),
		executionId: session.execution_id,
	});

	if (result.success) {
		let transitionRejected = false;
		if (transitionOpts) {
			const fsmResult = applyTransition(
				transitionOpts,
				session.execution_id,
				"approved",
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
				status: "approved",
				last_activity_at: sqliteDatetime(),
			});
		}

		if (!transitionRejected) {
			// GEO-292: Auto-set session_stage to "ship" on approve (only advance)
			const currentSession = store.getSession(session.execution_id);
			const currentOrder =
				STAGE_ORDER[currentSession?.session_stage ?? ""] ?? -1;
			if ((STAGE_ORDER.ship ?? 9) > currentOrder) {
				store.patchSessionMetadata(session.execution_id, {
					session_stage: "ship",
					stage_updated_at: sqliteDatetime(),
				});
			}

			sendActionHook(
				store,
				projects,
				executionId,
				"approve",
				"awaiting_review",
				"approved",
				undefined,
				eventFilter,
				forumTagUpdater,
				registry,
				config,
			);

			// CIPHER: record approve outcome
			if (cipherWriter && session.status === "awaiting_review") {
				try {
					await cipherWriter.recordOutcome({
						executionId,
						ceoAction: "approve",
						ceoActionTimestamp,
						sourceStatus: session.status,
					});
				} catch {
					console.error(
						`[CIPHER] recordOutcome failed for approve ${executionId}`,
					);
				}
			}

			// GEO-280: Post-merge cleanup (fire-and-forget, error-isolated)
			if (onApproved) {
				void Promise.resolve()
					.then(() => onApproved(executionId, session))
					.catch((err) => {
						console.error(
							`[post-merge] onApproved callback error for ${executionId}:`,
							(err as Error).message,
						);
					});
			}
		}
	}

	return result;
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
	forumTagUpdater?: ForumTagUpdater,
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
		forumTagUpdater,
		registry,
		config,
	);

	if (action === "retry") {
		const thread = store.getThreadByIssue(session.issue_id);
		if (thread?.thread_id) {
			store.clearArchived(thread.thread_id);
		}
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
async function handleRetry(
	store: StateStore,
	retryDispatcher: IRetryDispatcher,
	executionId: string,
	reason?: string,
	config?: BridgeConfig,
	projects?: ProjectEntry[],
	eventFilter?: EventFilter,
	forumTagUpdater?: ForumTagUpdater,
	ceoContext?: string,
	registry?: RuntimeRegistry,
): Promise<ActionResult> {
	const session = store.getSession(executionId);
	if (!session) {
		return {
			success: false,
			message: `No session found for execution_id ${executionId}`,
		};
	}

	const actionDef = ACTION_DEFINITIONS.find((d) => d.action === "retry");
	if (!actionDef || !actionDef.fromStates.includes(session.status)) {
		return {
			success: false,
			message: `Cannot retry ${session.issue_identifier ?? executionId}: status is "${session.status}", expected one of: ${actionDef?.fromStates.join(", ") ?? "?"}`,
		};
	}

	// Check for inflight execution on same issue
	const inflight = retryDispatcher.getInflightIssues();
	if (inflight.has(session.issue_id)) {
		return {
			success: false,
			message: `Issue ${session.issue_identifier ?? session.issue_id} already has an execution in progress`,
		};
	}

	// Check for active (running) session in StateStore
	const active = store.getActiveSessions();
	const activeForIssue = active.find((s) => s.issue_id === session.issue_id);
	if (activeForIssue) {
		return {
			success: false,
			message: `Issue ${session.issue_identifier ?? session.issue_id} already has an active session (${activeForIssue.execution_id})`,
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

	try {
		const result = await retryDispatcher.dispatch({
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
		});

		// Link predecessor → successor
		store.setRetrySuccessor(executionId, result.newExecutionId);

		// Unarchive thread
		const thread = store.getThreadByIssue(session.issue_id);
		if (thread?.thread_id) {
			store.clearArchived(thread.thread_id);
		}

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
			forumTagUpdater,
			registry,
			config,
		);

		return {
			success: true,
			message: `${session.issue_identifier ?? executionId} retry dispatched → ${result.newExecutionId} (attempt #${runAttempt})`,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, message: `Retry dispatch failed: ${msg}` };
	}
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

/** GEO-187: Terminate a running session by killing its tmux session. */
async function handleTerminate(
	store: StateStore,
	executionId: string,
	transitionOpts?: ApplyTransitionOpts,
	config?: BridgeConfig,
	projects?: ProjectEntry[],
	eventFilter?: EventFilter,
	forumTagUpdater?: ForumTagUpdater,
	registry?: RuntimeRegistry,
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

	// Kill tmux session via CommDB (source of truth, not StateStore.tmux_session
	// which is unreliably populated in production — see tmux-lookup.ts)
	const tmuxTarget = session.project_name
		? getTmuxTargetFromCommDb(executionId, session.project_name)
		: undefined;
	if (tmuxTarget) {
		const killResult = await killTmuxSession(tmuxTarget.sessionName);
		if (!killResult.killed && killResult.error) {
			console.error(
				`[terminate] tmux kill failed for ${tmuxTarget.sessionName}: ${killResult.error}`,
			);
			return {
				success: false,
				message: `Failed to kill tmux session ${tmuxTarget.sessionName}: ${killResult.error}`,
			};
		}
	}

	// Transition to terminated
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
			{ last_activity_at: sqliteDatetime(), last_error: "Terminated by CEO" },
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
			"Terminated by CEO",
		);
	}

	sendActionHook(
		store,
		projects ?? [],
		executionId,
		"terminate",
		session.status,
		"terminated",
		"Terminated by CEO",
		eventFilter,
		forumTagUpdater,
		registry,
		config,
	);

	const id = session.issue_identifier ?? executionId;
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
	forumTagUpdater?: ForumTagUpdater,
	registry?: RuntimeRegistry,
	onApproved?: (executionId: string, session: Session) => void,
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
					forumTagUpdater,
					registry,
					onApproved,
				);
				if (result.success) {
					res.json({
						success: true,
						message: result.message,
						action: "approve",
						identifier,
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
				const { execution_id: eid } = req.body ?? {};
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
				const terminateResult = await handleTerminate(
					store,
					eid,
					transitionOpts,
					config,
					projects,
					eventFilter,
					forumTagUpdater,
					registry,
				);
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
					});
				}
				return;
			}
			case "retry": {
				const { execution_id: eid, reason, context } = req.body ?? {};
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
				if (retryDispatcher) {
					const retryResult = await handleRetry(
						store,
						retryDispatcher,
						eid,
						reason,
						config,
						projects,
						eventFilter,
						forumTagUpdater,
						typeof context === "string" ? context : undefined,
						registry,
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
						forumTagUpdater,
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
					forumTagUpdater,
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
