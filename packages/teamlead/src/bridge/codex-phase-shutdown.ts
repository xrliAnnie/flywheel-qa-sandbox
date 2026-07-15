/**
 * FLY-1269: cooperative issue-terminal shutdown for resident Codex phases.
 *
 * A live phase controller owns the daemon and founder TUI. Killing its tmux
 * window from Bridge while it is draining can orphan the daemon or let Bridge
 * remove the shared worktree underneath an active process. This helper gives
 * that controller one bounded request/ack window. Direct cleanup remains the
 * backstop only when the controller is provably absent; uncertainty fails
 * closed.
 */

import { randomUUID } from "node:crypto";
import { CommDB, type RunnerShutdownControl } from "flywheel-comm/db";
import type { Session } from "../StateStore.js";
import { resolveCommDbPath } from "./commdb-session-prune.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
	type TmuxTargetLookup,
} from "./tmux-lookup.js";

const PHASE_ROLES = new Set(["design", "implement", "qa"]);
const DEFAULT_ACK_TIMEOUT_MS = 30_000;
const DEFAULT_CONTROLLER_LEASE_MAX_AGE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface RunnerShutdownDb {
	getRunnerShutdown(executionId: string): RunnerShutdownControl | null;
	requestRunnerShutdown(
		executionId: string,
		requestId: string,
		nowMs: number,
	): RunnerShutdownControl;
	close(): void;
}

export interface CodexPhaseShutdownInput {
	executionId: string;
	projectName: string;
	getSession: () => Session | undefined;
}

export interface CodexPhaseShutdownDeps {
	resolveCommDbPath?: (projectName: string) => string | undefined;
	openCommDb?: (dbPath: string) => RunnerShutdownDb;
	lookupTarget?: (executionId: string, projectName: string) => TmuxTargetLookup;
	probe?: (tmuxWindow: string) => Promise<RunnerLiveness>;
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
			reason:
				| "target_gone"
				| "controller_lease_stale"
				| "controller_heartbeat_stopped"
				| "dead_pin"
				| "absent";
	  }
	| { kind: "graceful"; requestId: string }
	| { kind: "blocked"; error: string };

export function isResidentCodexPhase(session: Session | undefined): boolean {
	return (
		session?.adapter_type === "codex-tmux" &&
		PHASE_ROLES.has(session.chat_thread_role ?? "")
	);
}

function heartbeatMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const normalized = value.includes("T")
		? value.endsWith("Z")
			? value
			: `${value}Z`
		: `${value.replace(" ", "T")}Z`;
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isFreshHeartbeat(
	value: string | undefined,
	nowMs: number,
	maxAgeMs: number,
): boolean {
	const parsed = heartbeatMs(value);
	return (
		parsed !== undefined && nowMs - parsed >= 0 && nowMs - parsed <= maxAgeMs
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function validateAcknowledgedTuiGone(
	input: CodexPhaseShutdownInput,
	requestId: string,
	lookupTarget: NonNullable<CodexPhaseShutdownDeps["lookupTarget"]>,
	probe: NonNullable<CodexPhaseShutdownDeps["probe"]>,
): Promise<CodexPhaseShutdownDecision> {
	const lookup = lookupTarget(input.executionId, input.projectName);
	if (lookup.kind === "gone") return { kind: "graceful", requestId };
	if (lookup.kind === "error") {
		return {
			kind: "blocked",
			error: `phase_shutdown_post_ack_lookup_error:${lookup.error}`,
		};
	}
	const liveness = await probe(lookup.target.tmuxWindow);
	if (liveness === "absent") return { kind: "graceful", requestId };
	return {
		kind: "blocked",
		error:
			liveness === "indeterminate"
				? "phase_shutdown_ack_tui_indeterminate"
				: `phase_shutdown_ack_tui_${liveness}`,
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

	const lookupTarget = deps.lookupTarget ?? lookupTmuxTarget;
	const probe = deps.probe ?? probeRunnerProcessLiveness;
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

	const initialLookup = lookupTarget(input.executionId, input.projectName);
	if (initialLookup.kind === "gone") {
		return { kind: "direct", reason: "target_gone" };
	}
	if (initialLookup.kind === "error") {
		return {
			kind: "blocked",
			error: `phase_shutdown_lookup_error:${initialLookup.error}`,
		};
	}

	let initialLiveness: RunnerLiveness;
	try {
		initialLiveness = await probe(initialLookup.target.tmuxWindow);
	} catch (error) {
		return {
			kind: "blocked",
			error: `phase_shutdown_liveness_error:${errorMessage(error)}`,
		};
	}
	if (initialLiveness === "dead_pin" || initialLiveness === "absent") {
		return { kind: "direct", reason: initialLiveness };
	}
	if (initialLiveness === "indeterminate") {
		return {
			kind: "blocked",
			error: "phase_shutdown_liveness_indeterminate",
		};
	}

	const startedAt = now();
	const initialHeartbeat = initialSession?.heartbeat_at;
	if (!isFreshHeartbeat(initialHeartbeat, startedAt, leaseMaxAgeMs)) {
		return { kind: "direct", reason: "controller_lease_stale" };
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
		let control = db.getRunnerShutdown(input.executionId);
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
				return await validateAcknowledgedTuiGone(
					input,
					requestId,
					lookupTarget,
					probe,
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
			const next = db.getRunnerShutdown(input.executionId);
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

	const finalLookup = lookupTarget(input.executionId, input.projectName);
	if (finalLookup.kind === "error") {
		return {
			kind: "blocked",
			error: `phase_shutdown_timeout_lookup_error:${finalLookup.error}`,
		};
	}
	if (finalLookup.kind === "gone") {
		return { kind: "direct", reason: "target_gone" };
	}

	let finalLiveness: RunnerLiveness;
	try {
		finalLiveness = await probe(finalLookup.target.tmuxWindow);
	} catch (error) {
		return {
			kind: "blocked",
			error: `phase_shutdown_timeout_liveness_error:${errorMessage(error)}`,
		};
	}
	if (finalLiveness === "dead_pin" || finalLiveness === "absent") {
		return { kind: "direct", reason: finalLiveness };
	}
	if (finalLiveness === "indeterminate") {
		return {
			kind: "blocked",
			error: "phase_shutdown_timeout_liveness_indeterminate",
		};
	}

	const finalHeartbeat = input.getSession()?.heartbeat_at;
	if (finalHeartbeat !== initialHeartbeat) {
		return {
			kind: "blocked",
			error: "phase_shutdown_ack_timeout_live_controller",
		};
	}
	return { kind: "direct", reason: "controller_heartbeat_stopped" };
}
