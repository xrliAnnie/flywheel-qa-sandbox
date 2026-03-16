import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import { ApproveHandler } from "flywheel-edge-worker";
import type { ActionResult } from "flywheel-edge-worker";
import { ACTION_DEFINITIONS } from "flywheel-core";
import type { StateStore } from "../StateStore.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { applyTransition, type ApplyTransitionOpts } from "../applyTransition.js";
import { sqliteDatetime, type BridgeConfig } from "./types.js";
import { buildSessionKey, buildHookBody, notifyAgent, type HookPayload } from "./hook-payload.js";

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

/** Send post-action hook notification (best-effort, fire-and-forget). */
function sendActionHook(
	store: StateStore,
	config: BridgeConfig | undefined,
	executionId: string,
	action: string,
	sourceStatus: string,
	targetStatus: string,
	reason?: string,
): void {
	if (!config?.gatewayUrl || !config?.hooksToken) return;
	const session = store.getSession(executionId);
	if (!session) return;
	const hookPayload: HookPayload = {
		event_type: "action_executed",
		execution_id: session.execution_id,
		issue_id: session.issue_id,
		issue_identifier: session.issue_identifier,
		issue_title: session.issue_title,
		project_name: session.project_name,
		status: targetStatus,
		thread_id: session.thread_id,
		channel: config.notificationChannel,
		action,
		action_source_status: sourceStatus,
		action_target_status: targetStatus,
		action_reason: reason,
	};
	const body = buildHookBody("product-lead", hookPayload, buildSessionKey(session));
	notifyAgent(config.gatewayUrl, config.hooksToken, body).catch(() => {});
}

export async function approveExecution(
	store: StateStore,
	projects: ProjectEntry[],
	executionId: string,
	identifier?: string,
	execFn?: ExecFn,
	transitionOpts?: ApplyTransitionOpts,
	config?: BridgeConfig,
): Promise<ActionResult> {
	const session = store.getSession(executionId);
	if (!session) {
		return { success: false, message: `No session found for execution_id ${executionId}` };
	}

	if (session.status !== "awaiting_review") {
		return {
			success: false,
			message: `Cannot approve ${identifier ?? executionId}: status is "${session.status}", expected "awaiting_review"`,
		};
	}

	const project = projects.find((p) => p.projectName === session.project_name);
	if (!project) {
		return { success: false, message: `Unknown project: ${session.project_name}` };
	}

	const handler = new ApproveHandler(execFn ?? defaultExec, project.projectRoot, project.projectRepo);
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
		if (transitionOpts) {
			applyTransition(
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
		sendActionHook(store, config, executionId, "approve", "awaiting_review", "approved");
	}

	return result;
}

export function transitionSession(
	store: StateStore,
	action: string,
	executionId: string,
	reason?: string,
	transitionOpts?: ApplyTransitionOpts,
	config?: BridgeConfig,
): ActionResult {
	const session = store.getSession(executionId);
	if (!session) {
		return { success: false, message: `No session found for execution_id ${executionId}` };
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
			return { success: false, message: result.error ?? "Transition rejected by FSM" };
		}
	} else {
		// Legacy fallback (no FSM)
		if (!actionDef.fromStates.includes(session.status)) {
			return {
				success: false,
				message: `Cannot ${action} ${session.issue_identifier ?? executionId}: status is "${session.status}", expected one of: ${actionDef.fromStates.join(", ")}`,
			};
		}
		store.forceStatus(session.execution_id, targetStatus, sqliteDatetime(), reason);
	}

	sendActionHook(store, config, executionId, action, session.status, targetStatus, reason);

	const id = session.issue_identifier ?? executionId;
	const pastTense: Record<string, string> = {
		reject: "rejected", defer: "deferred", retry: "retried", shelve: "shelved",
	};
	return { success: true, message: `${id} ${pastTense[action] ?? action} successfully` };
}

export function createActionRouter(
	store: StateStore,
	projects: ProjectEntry[],
	transitionOpts?: ApplyTransitionOpts,
	config?: BridgeConfig,
): Router {
	const router = Router();

	router.post("/:action", async (req, res) => {
		const action = req.params.action;

		switch (action) {
			case "approve": {
				const { execution_id, identifier } = req.body ?? {};
				if (!execution_id || typeof execution_id !== "string") {
					res.status(400).json({ error: "execution_id is required" });
					return;
				}
				const result = await approveExecution(store, projects, execution_id, identifier, undefined, transitionOpts, config);
				if (result.success) {
					res.json({ success: true, message: result.message, action: "approve", identifier });
				} else {
					res.status(400).json({ success: false, message: result.message, action: "approve" });
				}
				return;
			}
			case "reject":
			case "defer":
			case "retry":
			case "shelve": {
				const { execution_id: eid, reason } = req.body ?? {};
				if (!eid || typeof eid !== "string") {
					res.status(400).json({ error: "execution_id is required" });
					return;
				}
				const actionResult = transitionSession(store, action, eid, reason, transitionOpts, config);
				if (actionResult.success) {
					res.json({ success: true, message: actionResult.message, action });
				} else {
					res.status(400).json({ success: false, message: actionResult.message, action });
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
