import {
	type CodexDaemonReapResult,
	reapCodexDaemonForExecution,
} from "flywheel-claude-runner";
import type { Session, StateStore } from "../StateStore.js";

export interface CodexDaemonTeardownDeps {
	reap?: typeof reapCodexDaemonForExecution;
}

export type CodexDaemonTeardownResult =
	| { outcome: "not_codex" }
	| CodexDaemonReapResult;

/** Shared Bridge teardown seam for the detached Codex daemon. Residue is
 * recorded through the existing Lead-visible cleanup-failure event, while the
 * caller continues tmux and CommDB teardown so one leak cannot strand all
 * remaining resources. */
export async function reapCodexDaemonForSession(
	store: StateStore,
	session: Pick<
		Session,
		"execution_id" | "issue_id" | "project_name" | "adapter_type"
	>,
	source: string,
	deps: CodexDaemonTeardownDeps = {},
): Promise<CodexDaemonTeardownResult> {
	if (session.adapter_type !== "codex-tmux") return { outcome: "not_codex" };
	let result: CodexDaemonReapResult;
	try {
		result = await (deps.reap ?? reapCodexDaemonForExecution)(
			session.execution_id,
		);
	} catch (error) {
		result = { outcome: "unverifiable", socketPath: "unknown" };
		console.warn(
			`[codex-daemon-teardown] ${session.execution_id}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const failed =
		result.outcome === "residual" || result.outcome === "unverifiable";
	store.insertEvent({
		event_id: `exec-host-processes-${source}-${session.execution_id}-${result.outcome}`,
		execution_id: session.execution_id,
		issue_id: session.issue_id,
		project_name: session.project_name,
		event_type: failed
			? "exec_host_processes_residual"
			: "exec_host_processes_reaped",
		source,
		payload: result,
	});
	if (failed) {
		store.insertEvent({
			event_id: `codex-daemon-cleanup-failed-${source}-${session.execution_id}`,
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			project_name: session.project_name,
			event_type: "lead_close_runner_failed",
			source: "bridge.codex-daemon-teardown",
			payload: {
				cleanupPending: true,
				reason: `codex_daemon_${result.outcome}`,
				origin: source,
				...result,
			},
		});
	}
	return result;
}
