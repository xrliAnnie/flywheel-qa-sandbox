import { CommDB } from "flywheel-comm/db";
import type { LandOperationRow, StateStore } from "../StateStore.js";

export interface LandCleanupOpportunityDeps {
	store: StateStore;
	commDbPathForProject(projectName: string): string;
	graceMs?: number;
	nowMs?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Give every persisted issue session one best-effort cleanup notification.
 * Resident Codex phases already understand runner_shutdown_controls; other
 * runners also receive a deterministic inbox instruction and may opt in. The
 * subsequent lifecycle closeout remains fail-safe and closes after the bound.
 */
export async function requestLandCleanupOpportunities(
	operation: LandOperationRow,
	deps: LandCleanupOpportunityDeps,
): Promise<{ requested: number; acked: number; timedOut: number }> {
	const sessions = deps.store.getSessionsByIssue(operation.issue_id);
	if (sessions.length === 0) return { requested: 0, acked: 0, timedOut: 0 };
	const nowMs = deps.nowMs ?? Date.now;
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const graceMs = Math.max(0, deps.graceMs ?? 30_000);
	const db = new CommDB(deps.commDbPathForProject(operation.project_name));
	try {
		for (const session of sessions) {
			const requestId = `${operation.operation_id}:${session.execution_id}`;
			db.requestRunnerShutdown(session.execution_id, requestId, nowMs());
			db.insertInstruction(
				"bridge-land",
				session.execution_id,
				`[land-cleanup ${operation.operation_id}] Run bounded cleanup now, then acknowledge shutdown request ${requestId}.`,
				{
					dedupeId: `land-cleanup-instruction:${operation.operation_id}:${session.execution_id}`,
				},
			);
		}
		const deadline = nowMs() + graceMs;
		let acked = 0;
		while (true) {
			acked = sessions.filter((session) => {
				const requestId = `${operation.operation_id}:${session.execution_id}`;
				return (
					db.getRunnerShutdownRequest(session.execution_id, requestId)
						?.state === "acked"
				);
			}).length;
			if (acked === sessions.length || nowMs() >= deadline) break;
			await sleep(Math.min(500, Math.max(1, deadline - nowMs())));
		}
		return {
			requested: sessions.length,
			acked,
			timedOut: sessions.length - acked,
		};
	} finally {
		db.close();
	}
}
