import type { RunnerShutdownControl } from "flywheel-comm/db";
import type { Session } from "../StateStore.js";

const WORKFLOW_PHASE_ROLES = new Set(["design", "implement", "qa"]);

export const DEFAULT_ACK_TIMEOUT_MS = 30_000;
export const DEFAULT_CONTROLLER_LEASE_MAX_AGE_MS = 60_000;

export interface RunnerShutdownDb {
	getRunnerShutdown(executionId: string): RunnerShutdownControl | null;
	requestRunnerShutdown(
		executionId: string,
		requestId: string,
		nowMs: number,
	): RunnerShutdownControl;
	close(): void;
}

export function isWorkflowPhaseSession(session: Session | undefined): boolean {
	return WORKFLOW_PHASE_ROLES.has(session?.chat_thread_role ?? "");
}

export function parseControllerHeartbeatMs(
	value: string | undefined,
): number | undefined {
	if (!value) return undefined;
	const normalized = value.includes("T")
		? value.endsWith("Z")
			? value
			: `${value}Z`
		: `${value.replace(" ", "T")}Z`;
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function isFreshControllerHeartbeat(
	value: string | undefined,
	nowMs: number,
	maxAgeMs: number,
): boolean {
	const parsed = parseControllerHeartbeatMs(value);
	return (
		parsed !== undefined && nowMs - parsed >= 0 && nowMs - parsed <= maxAgeMs
	);
}
