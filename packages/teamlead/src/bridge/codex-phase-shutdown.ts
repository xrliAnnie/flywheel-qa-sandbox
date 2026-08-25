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
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
	type TmuxTargetLookup,
} from "./tmux-lookup.js";

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
			// FLY-1269 Authority Matrix: only a tmux-identity verdict that the target
			// is provably absent licenses direct cleanup — `target_gone` / `dead_pin`
			// / `absent`. A heartbeat signal never does: it cannot distinguish a dead
			// controller from a live-but-wedged one, and culling the latter orphans
			// its daemon.
			reason:
				| "target_gone"
				// now unreachable by design (FLY-1269): both heartbeat-derived reasons
				// are only ever evaluated once the pane probed ALIVE, which is exactly
				// when direct cleanup is forbidden. Kept (not deleted) so existing
				// referents and persisted values keep resolving.
				| "controller_lease_stale"
				| "controller_heartbeat_stopped"
				| "dead_pin"
				| "absent";
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
	if (!isFreshControllerHeartbeat(initialHeartbeat, startedAt, leaseMaxAgeMs)) {
		// FLY-1269: every not-alive liveness returned above, so the pane is
		// provably LIVE here. A stale lease then means "the controller stopped
		// beating" OR "we cannot read its beat" — never "provably absent", which
		// is the only licence the header contract grants direct cleanup. Fail
		// closed: killing a live controller's window orphans its daemon.
		return {
			kind: "blocked",
			error: "phase_shutdown_controller_lease_stale_live_pane",
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
	// FLY-1269: the pane is provably LIVE (every other liveness returned above),
	// so a heartbeat that stopped advancing during the ack wait is ambiguous — a
	// wedged-but-live controller and a dead one look identical from here, and only
	// the latter would be safe to cull. The header contract allows direct cleanup
	// solely when the controller is provably absent, which a live pane refutes.
	// Fail closed and let the tmux-identity probe (gone/dead_pin/absent) be the
	// sole authority for culling.
	return {
		kind: "blocked",
		error: "phase_shutdown_ack_timeout_heartbeat_stopped_live_pane",
	};
}
