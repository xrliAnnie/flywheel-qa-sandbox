import { createHash } from "node:crypto";
import {
	type CodexDaemonReapResult,
	type CodexExecutionOwnershipRegistry,
	type CodexStopReason,
	type CodexStopResult,
	reapCodexDaemonForExecution,
} from "flywheel-claude-runner";
import type { Session, StateStore } from "../StateStore.js";
import type { CodexTerminalCloseAttemptRecorder } from "./codex-terminal-close-ledger.js";

export interface CodexDaemonTeardownDeps {
	gracefulOnly?: boolean;
	beforeSignal?: () => boolean;
	reap?: typeof reapCodexDaemonForExecution;
	/**
	 * FLY-2903: ask the in-process goal runtime to stop before the reap, so a
	 * deliberate kill is never resumed as a mid-goal crash (FLY-2814).
	 */
	stopOwner?: {
		registry: Pick<CodexExecutionOwnershipRegistry, "requestStop">;
		reason: CodexStopReason;
		timeoutMs?: number;
	};
	/** FLY-2903: record the attempt; the sweep gives the verified verdict. */
	closeLedger?: CodexTerminalCloseAttemptRecorder;
}

export type CodexDaemonTeardownResult =
	| { outcome: "not_codex" }
	| (CodexDaemonReapResult & { ownerStop?: CodexStopResult });

/** FLY-2903 Bridge-wide wiring for every terminal-path caller. */
export interface CodexTerminalTeardownWiring {
	owners?: Pick<CodexExecutionOwnershipRegistry, "requestStop">;
	closeLedger?: CodexTerminalCloseAttemptRecorder;
}

export function terminalTeardownDeps(
	wiring: CodexTerminalTeardownWiring | undefined,
	reason: CodexStopReason | null,
): Pick<CodexDaemonTeardownDeps, "stopOwner" | "closeLedger"> {
	return {
		...(wiring?.owners && reason
			? { stopOwner: { registry: wiring.owners, reason } }
			: {}),
		...(wiring?.closeLedger ? { closeLedger: wiring.closeLedger } : {}),
	};
}

let registeredTerminalTeardown: CodexTerminalTeardownWiring | undefined;

/**
 * FLY-2903: registered once at the Bridge composition root (same pattern as
 * `registerLifecycleCloseGuard`). Absent (tests / non-Bridge callers) → the
 * terminal paths keep their legacy reap-only behavior byte for byte.
 */
export function registerCodexTerminalTeardown(
	wiring: CodexTerminalTeardownWiring,
): () => void {
	registeredTerminalTeardown = wiring;
	return () => {
		if (registeredTerminalTeardown === wiring) {
			registeredTerminalTeardown = undefined;
		}
	};
}

/** Deps for a terminal-path caller; `null` records the attempt without a stop. */
export function codexTerminalTeardownDeps(
	reason: CodexStopReason | null,
): Pick<CodexDaemonTeardownDeps, "stopOwner" | "closeLedger"> {
	return terminalTeardownDeps(registeredTerminalTeardown, reason);
}

async function stopOwnerBeforeReap(
	executionId: string,
	stopOwner: NonNullable<CodexDaemonTeardownDeps["stopOwner"]>,
): Promise<CodexStopResult | undefined> {
	try {
		return await stopOwner.registry.requestStop(
			executionId,
			stopOwner.reason,
			stopOwner.timeoutMs !== undefined
				? { timeoutMs: stopOwner.timeoutMs }
				: {},
		);
	} catch (error) {
		console.warn(
			`[codex-daemon-teardown] ${executionId}: stop request failed (reap continues): ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

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
	const ownerStop = deps.stopOwner
		? await stopOwnerBeforeReap(session.execution_id, deps.stopOwner)
		: undefined;
	let result: CodexDaemonReapResult;
	let reapFailure: CodexDaemonReapFailure | undefined;
	try {
		result = await (deps.reap ?? reapCodexDaemonForExecution)(
			session.execution_id,
			{
				...(deps.gracefulOnly !== undefined
					? { gracefulOnly: deps.gracefulOnly }
					: {}),
				...(deps.beforeSignal ? { beforeSignal: deps.beforeSignal } : {}),
			},
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
	if (deps.closeLedger) {
		try {
			deps.closeLedger.recordCloseAttempt({
				executionId: session.execution_id,
				source,
				...(ownerStop ? { ownerStop } : {}),
				reap: result.outcome,
			});
		} catch (error) {
			console.warn(
				`[codex-daemon-teardown] ${session.execution_id}: close ledger write failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return ownerStop ? { ...result, ownerStop } : result;
}
