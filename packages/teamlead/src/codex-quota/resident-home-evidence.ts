import type {
	CodexDaemonProcessBindingResult,
	ExecutionCodexHomeResolution,
} from "flywheel-claude-runner";

export interface ResidentProcessObservation {
	pid: number;
	startIdentity: string;
}

export interface ResidentHomeEvidenceRequest {
	executionId: string;
	home: string;
	project: string;
	role: string;
	process: ResidentProcessObservation;
	commPresent: boolean;
}

interface ResidentSession {
	execution_id: string;
	project_name: string;
	status: string;
	adapter_type?: string;
	workflow_node_id?: string;
	agent_name?: string;
	session_role?: string;
}

interface ResidentLaunchSnapshot {
	schemaVersion: 1;
	executionId: string;
}

export interface ResidentHomeEvidenceDeps {
	getSession(executionId: string): ResidentSession | undefined;
	resolveExecutionHome(
		executionId: string,
		expected: { project: string; role: string },
	): ExecutionCodexHomeResolution;
	readLaunchSnapshot(executionId: string): ResidentLaunchSnapshot;
	probeDaemonProcessBinding(
		executionId: string,
		process: ResidentProcessObservation,
	): Promise<CodexDaemonProcessBindingResult>;
}

export interface ResidentHomeEvidenceResult {
	verified: boolean;
	reason: string;
}

const ACTIVE_STATUSES = new Set([
	"running",
	"ship_parked",
	"awaiting_review",
	"design_done",
	"approved_to_ship",
]);

/**
 * Strict read-only adapter for old resident executions which predate the
 * durable keyed-home lease. Environment variables are observations only; the
 * StateStore row, persisted keyed binding, launch snapshot, and live daemon
 * process proof must all agree before the collector may explain the process.
 */
export function createResidentHomeEvidence(
	deps: ResidentHomeEvidenceDeps,
): (
	request: ResidentHomeEvidenceRequest,
) => Promise<ResidentHomeEvidenceResult> {
	return async (request) => {
		if (!request.commPresent) {
			return { verified: false, reason: "comm_session_missing" };
		}
		const session = deps.getSession(request.executionId);
		if (
			!session ||
			session.execution_id !== request.executionId ||
			session.project_name !== request.project ||
			session.adapter_type !== "codex-tmux" ||
			!ACTIVE_STATUSES.has(session.status)
		) {
			return { verified: false, reason: "state_session_mismatch" };
		}
		const durableRole =
			session.workflow_node_id ?? session.agent_name ?? session.session_role;
		if (durableRole !== request.role) {
			return { verified: false, reason: "state_role_mismatch" };
		}

		const resolved = deps.resolveExecutionHome(request.executionId, {
			project: request.project,
			role: request.role,
		});
		if (
			(resolved.kind !== "keyed" && resolved.kind !== "prepublished") ||
			resolved.home !== request.home ||
			resolved.project !== request.project ||
			resolved.role !== request.role
		) {
			return { verified: false, reason: "persistent_home_mismatch" };
		}

		let launch: ResidentLaunchSnapshot;
		try {
			launch = deps.readLaunchSnapshot(request.executionId);
		} catch {
			return { verified: false, reason: "launch_snapshot_unavailable" };
		}
		if (
			launch.schemaVersion !== 1 ||
			launch.executionId !== request.executionId
		) {
			return { verified: false, reason: "launch_snapshot_mismatch" };
		}

		let binding: CodexDaemonProcessBindingResult;
		try {
			binding = await deps.probeDaemonProcessBinding(
				request.executionId,
				request.process,
			);
		} catch {
			return { verified: false, reason: "daemon_evidence_unavailable" };
		}
		if (!binding.bound) {
			return { verified: false, reason: binding.reason };
		}
		return { verified: true, reason: "verified" };
	};
}
