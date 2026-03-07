import { Router } from "express";
import { ApproveHandler } from "flywheel-edge-worker";
import type { ActionResult } from "flywheel-edge-worker";
import type { StateStore } from "../StateStore.js";
import type { ProjectEntry } from "../ProjectConfig.js";

type ExecFn = (
	cmd: string,
	args: string[],
	cwd: string,
) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = async (cmd, args, cwd) => {
	const { execFileSync } = await import("node:child_process");
	const result = execFileSync(cmd, args, { cwd, encoding: "utf-8" });
	return { stdout: result };
};

function sqliteDatetime(): string {
	return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export async function approveExecution(
	store: StateStore,
	projects: ProjectEntry[],
	executionId: string,
	identifier?: string,
	execFn?: ExecFn,
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

	return result;
}

export function createActionRouter(
	store: StateStore,
	projects: ProjectEntry[],
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
				const result = await approveExecution(store, projects, execution_id, identifier);
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
			case "shelve":
				res.status(501).json({ error: `${action} not implemented in Phase 1` });
				return;
			default:
				res.status(400).json({ error: `Unknown action: ${action}` });
				return;
		}
	});

	return router;
}
