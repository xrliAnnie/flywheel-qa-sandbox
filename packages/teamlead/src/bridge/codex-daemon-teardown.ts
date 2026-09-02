import { createHash } from "node:crypto";
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

interface CodexDaemonReapFailure {
	kind: "system_error" | "exception" | "non_error_throw";
	code?: string;
	name?: string;
	message: string;
}

function classifyReapFailure(error: unknown): CodexDaemonReapFailure {
	const message = error instanceof Error ? error.message : String(error);
	const code =
		typeof (error as NodeJS.ErrnoException | null)?.code === "string"
			? (error as NodeJS.ErrnoException).code
			: undefined;
	if (code) return { kind: "system_error", code, message };
	if (error instanceof Error) {
		return { kind: "exception", name: error.name, message };
	}
	return { kind: "non_error_throw", message };
}

function reapFailureKey(failure: CodexDaemonReapFailure): string {
	return createHash("sha256")
		.update(JSON.stringify(failure))
		.digest("hex")
		.slice(0, 12);
}

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
	let reapFailure: CodexDaemonReapFailure | undefined;
	try {
		result = await (deps.reap ?? reapCodexDaemonForExecution)(
			session.execution_id,
		);
	} catch (error) {
		reapFailure = classifyReapFailure(error);
		result = { outcome: "unverifiable", socketPath: "unknown" };
		console.warn(
			`[codex-daemon-teardown] ${session.execution_id}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const failed =
		result.outcome === "residual" || result.outcome === "unverifiable";
	const failureKey = reapFailure ? `-${reapFailureKey(reapFailure)}` : "";
	store.insertEvent({
		event_id: `exec-host-processes-${source}-${session.execution_id}-${result.outcome}${failureKey}`,
		execution_id: session.execution_id,
		issue_id: session.issue_id,
		project_name: session.project_name,
		event_type: failed
			? "exec_host_processes_residual"
			: "exec_host_processes_reaped",
		source,
		payload: {
			...result,
			...(reapFailure ? { reapFailure } : {}),
		},
	});
	if (failed) {
		store.insertEvent({
			event_id: `codex-daemon-cleanup-failed-${source}-${session.execution_id}${failureKey}`,
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
				...(reapFailure ? { reapFailure } : {}),
			},
		});
	}
	return result;
}
