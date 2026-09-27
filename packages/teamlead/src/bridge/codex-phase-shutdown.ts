/**
 * FLY-1269: cooperative issue-terminal shutdown for resident Codex phases.
 *
 * A live phase controller owns the daemon and founder TUI. Killing its body
 * while it is draining can orphan work or let Bridge
 * remove the shared worktree underneath an active process. This helper gives
 * that controller one bounded request/ack window. Direct cleanup remains the
 * backstop only when the shared execution-body observation proves death;
 * window state is UI cleanup evidence only and uncertainty fails closed.
 */

import { randomUUID } from "node:crypto";
import { CommDB } from "flywheel-comm/db";
import type { Session } from "../StateStore.js";
import { resolveCommDbPath } from "./commdb-session-prune.js";
import {
	DEFAULT_ACK_TIMEOUT_MS,
	DEFAULT_CONTROLLER_LEASE_MAX_AGE_MS,
	isFreshControllerHeartbeat,
	isWorkflowManagedSession,
	type RunnerShutdownDb,
} from "./runner-shutdown-evidence.js";

export {
	DEFAULT_ACK_TIMEOUT_MS,
	DEFAULT_CONTROLLER_LEASE_MAX_AGE_MS,
	isFreshControllerHeartbeat,
	parseControllerHeartbeatMs,
	type RunnerShutdownDb,
} from "./runner-shutdown-evidence.js";

const DEFAULT_POLL_INTERVAL_MS = 250;

export interface CodexPhaseShutdownInput {
	executionId: string;
	projectName: string;
	getSession: () => Session | undefined;
}

export interface CodexPhaseShutdownDeps {
	resolveCommDbPath?: (projectName: string) => string | undefined;
	openCommDb?: (dbPath: string) => RunnerShutdownDb;
	observeBody?: (
		executionId: string,
		projectName: string,
	) => Promise<"alive" | "dead" | "unknown">;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	randomId?: () => string;
	shutdownAckTimeoutMs?: number;
	controllerLeaseMaxAgeMs?: number;
	pollIntervalMs?: number;
}

export type CodexPhaseShutdownDecision =
	| { kind: "not_applicable" }
	| {
			kind: "direct";
			/** Current-generation execution-body death; never a window verdict. */
			reason: "body_dead";
	  }
	| { kind: "graceful"; requestId: string }
	| { kind: "blocked"; error: string };

export function isResidentCodexPhase(session: Session | undefined): boolean {
	return (
		session?.adapter_type === "codex-tmux" && isWorkflowManagedSession(session)
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function validateAcknowledgedBodyGone(
	input: CodexPhaseShutdownInput,
	requestId: string,
	observeBody: NonNullable<CodexPhaseShutdownDeps["observeBody"]>,
): Promise<CodexPhaseShutdownDecision> {
	let body: "alive" | "dead" | "unknown";
	try {
		body = await observeBody(input.executionId, input.projectName);
	} catch (error) {
		return {
			kind: "blocked",
			error: `phase_shutdown_post_ack_body_error:${errorMessage(error)}`,
		};
	}
	if (body === "dead") return { kind: "graceful", requestId };
	return {
		kind: "blocked",
		error: `phase_shutdown_ack_body_${body}`,
	};
}

/**
 * Decide whether a terminal caller may use its legacy direct-kill path, must
 * wait for the resident adapter, or must stop. The helper never deletes rows;
 * callers do that only after graceful confirmation or a successful direct
 * close, preserving request/wake evidence on every failure.
 */
export async function prepareCodexPhaseShutdown(
	input: CodexPhaseShutdownInput,
	deps: CodexPhaseShutdownDeps = {},
): Promise<CodexPhaseShutdownDecision> {
	const initialSession = input.getSession();
	if (!isResidentCodexPhase(initialSession)) return { kind: "not_applicable" };

	const observeBody =
		deps.observeBody ??
		(async () => {
			return "unknown" as const;
		});
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const randomId = deps.randomId ?? randomUUID;
	const ackTimeoutMs = Math.max(
		0,
		deps.shutdownAckTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS,
	);
	const leaseMaxAgeMs = Math.max(
		0,
		deps.controllerLeaseMaxAgeMs ?? DEFAULT_CONTROLLER_LEASE_MAX_AGE_MS,
	);
	const pollIntervalMs = Math.max(
		1,
		deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
	);

	let initialBody: "alive" | "dead" | "unknown";
	try {
		initialBody = await observeBody(input.executionId, input.projectName);
	} catch (error) {
		return {
			kind: "blocked",
			error: `phase_shutdown_body_error:${errorMessage(error)}`,
		};
	}
	if (initialBody === "dead") return { kind: "direct", reason: "body_dead" };
	if (initialBody === "unknown") {
		return {
			kind: "blocked",
			error: "phase_shutdown_body_unknown",
		};
	}

	const startedAt = now();
	const initialHeartbeat = initialSession?.heartbeat_at;
	if (!isFreshControllerHeartbeat(initialHeartbeat, startedAt, leaseMaxAgeMs)) {
		// The body is provably alive here. A stale lease means "the controller stopped
		// beating" OR "we cannot read its beat" — never "provably absent", which
		// is the only licence the header contract grants direct cleanup.
		return {
			kind: "blocked",
			error: "phase_shutdown_controller_lease_stale_live_body",
		};
	}

	const resolvePath = deps.resolveCommDbPath ?? resolveCommDbPath;
	const openDb = deps.openCommDb ?? ((path: string) => new CommDB(path));
	const dbPath = resolvePath(input.projectName);
	if (!dbPath) {
		return {
			kind: "blocked",
			error: "phase_shutdown_db_error:commdb_missing",
		};
	}

	let db: RunnerShutdownDb | undefined;
	try {
		db = openDb(dbPath);
		let control = db.listPendingRunnerShutdowns(input.executionId)[0];
		if (!control) {
			control = db.requestRunnerShutdown(
				input.executionId,
				randomId(),
				startedAt,
			);
		}
		const requestId = control.request_id;

		for (;;) {
			if (control.request_id !== requestId) {
				return {
					kind: "blocked",
					error: "phase_shutdown_request_mismatch",
				};
			}
			if (control.state === "acked") {
				return await validateAcknowledgedBodyGone(
					input,
					requestId,
					observeBody,
				);
			}
			if (control.state === "failed") {
				return {
					kind: "blocked",
					error: `phase_shutdown_failed:${control.error ?? "unknown"}`,
				};
			}
			const elapsed = now() - startedAt;
			if (elapsed >= ackTimeoutMs) break;
			await sleep(Math.min(pollIntervalMs, ackTimeoutMs - elapsed));
			const next = db.getRunnerShutdownRequest(input.executionId, requestId);
			if (!next) {
				return {
					kind: "blocked",
					error: "phase_shutdown_request_disappeared",
				};
			}
			control = next;
		}
	} catch (error) {
		return {
			kind: "blocked",
			error: `phase_shutdown_db_error:${errorMessage(error)}`,
		};
	} finally {
		db?.close();
	}

	let finalBody: "alive" | "dead" | "unknown";
	try {
		finalBody = await observeBody(input.executionId, input.projectName);
	} catch (error) {
		return {
			kind: "blocked",
			error: `phase_shutdown_timeout_body_error:${errorMessage(error)}`,
		};
	}
	if (finalBody === "dead") return { kind: "direct", reason: "body_dead" };
	if (finalBody === "unknown") {
		return {
			kind: "blocked",
			error: "phase_shutdown_timeout_body_unknown",
		};
	}

	const finalHeartbeat = input.getSession()?.heartbeat_at;
	if (finalHeartbeat !== initialHeartbeat) {
		return {
			kind: "blocked",
			error: "phase_shutdown_ack_timeout_live_controller",
		};
	}
	// The body is provably alive (every other verdict returned above),
	// so a heartbeat that stopped advancing during the ack wait is ambiguous — a
	// wedged-but-live controller and a dead one look identical from here, and only
	// the latter would be safe to cull. The header contract allows direct cleanup
	// solely when the controller is provably absent, which a live pane refutes.
	return {
		kind: "blocked",
		error: "phase_shutdown_ack_timeout_heartbeat_stopped_live_body",
	};
}
