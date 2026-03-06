import {
	ReactionsEngine,
	ApproveHandler,
	RejectHandler,
	DeferHandler,
} from "flywheel-edge-worker";
import type { ActionHandler, ActionResult, SlackAction } from "flywheel-edge-worker";
import type { ProjectEntry } from "./ProjectConfig.js";
import type { StateStore } from "./StateStore.js";

type ExecFn = (
	cmd: string,
	args: string[],
	cwd: string,
) => Promise<{ stdout: string }>;

/**
 * Project-aware ApproveHandler that resolves projectRoot from the session.
 */
export class ProjectAwareApproveHandler implements ActionHandler {
	constructor(
		private projects: ProjectEntry[],
		private store: StateStore,
		private execFn: ExecFn,
	) {}

	async execute(action: SlackAction): Promise<ActionResult> {
		// Look up session — prefer executionId from button value, fallback to issueId
		const session = action.executionId
			? this.store.getSession(action.executionId)
			: this.store.getLatestActionableSession(action.issueId);

		if (!session) {
			return { success: false, message: `No session found for ${action.issueId}` };
		}

		const project = this.projects.find((p) => p.projectName === session.project_name);
		if (!project) {
			return { success: false, message: `No project config for ${session.project_name}` };
		}

		const handler = new ApproveHandler(this.execFn, project.projectRoot, project.projectRepo);
		return handler.execute(action);
	}
}

/** Stub handler for actions not yet implemented (retry, shelve). */
const stubHandler: ActionHandler = {
	async execute(action: SlackAction): Promise<ActionResult> {
		return {
			success: true,
			message: `Action '${action.action}' acknowledged for ${action.issueId} (stub — not yet implemented)`,
		};
	},
};

/**
 * Create a ReactionsEngine with project-aware handlers.
 */
export function createReactionsEngine(
	projects: ProjectEntry[],
	store: StateStore,
	execFn?: ExecFn,
): ReactionsEngine {
	const exec: ExecFn = execFn ?? (async (cmd, args, cwd) => {
		const { execFileSync } = await import("node:child_process");
		const result = execFileSync(cmd, args, { cwd, encoding: "utf-8" });
		return { stdout: result };
	});

	return new ReactionsEngine({
		approve: new ProjectAwareApproveHandler(projects, store, exec),
		reject: new RejectHandler(),
		defer: new DeferHandler(),
		retry: stubHandler,
		shelve: stubHandler,
	});
}
