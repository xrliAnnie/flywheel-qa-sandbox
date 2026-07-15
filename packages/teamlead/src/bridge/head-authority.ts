import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StateStore } from "../StateStore.js";

const execFileP = promisify(execFile);

export interface WorkflowHeadAuthority {
	executionId: string;
	prHeadSha: string;
	worktreePath: string;
}

/**
 * Resolve the only trusted workflow head: git HEAD in the execution's
 * persisted worktree. Callers may compare a supplied SHA, but never promote it
 * to authority.
 */
export async function resolveWorkflowHeadAuthority(
	store: Pick<StateStore, "getSession">,
	executionId: string,
): Promise<WorkflowHeadAuthority> {
	const session = store.getSession(executionId);
	if (!session) throw new Error("execution_not_found");
	const worktreePath = session.worktree_path?.trim();
	if (!worktreePath) throw new Error("worktree_not_found");
	try {
		const { stdout } = await execFileP(
			"git",
			["-C", worktreePath, "rev-parse", "HEAD"],
			{ encoding: "utf8", timeout: 5_000 },
		);
		const prHeadSha = stdout.trim().toLowerCase();
		if (!/^[0-9a-f]{40}$/.test(prHeadSha)) {
			throw new Error("invalid_git_head");
		}
		return { executionId, prHeadSha, worktreePath };
	} catch (error) {
		if (error instanceof Error && error.message === "invalid_git_head") {
			throw error;
		}
		throw new Error("git_head_unavailable");
	}
}
