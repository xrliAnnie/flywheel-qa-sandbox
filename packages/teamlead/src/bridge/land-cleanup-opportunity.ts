import { CommDB } from "flywheel-comm/db";
import type { LandOperationRow, StateStore } from "../StateStore.js";
import { enqueueRunnerInstructionIfDeliverable } from "./runner-instruction-gate.js";

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
): Promise<{
	requested: number;
	acked: number;
	timedOut: number;
	skipped: number;
}> {
	const sessions = deps.store.getSessionsByIssue(operation.issue_id);
	if (sessions.length === 0)
		return { requested: 0, acked: 0, timedOut: 0, skipped: 0 };
	const nowMs = deps.nowMs ?? Date.now;
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const graceMs = Math.max(0, deps.graceMs ?? 30_000);
	const db = new CommDB(deps.commDbPathForProject(operation.project_name));
	try {
		const deliverable = [];
		let skipped = 0;
		for (const session of sessions) {
			const requestId = `${operation.operation_id}:${session.execution_id}`;
			const outcome = enqueueRunnerInstructionIfDeliverable(
				{ store: deps.store, commDb: db },
				{
					fromAgent: "bridge-land",
					executionId: session.execution_id,
					content: `[land-cleanup ${operation.operation_id}] Run bounded cleanup now, then acknowledge shutdown request ${requestId}.`,
					dedupeId: `land-cleanup-instruction:${operation.operation_id}:${session.execution_id}`,
					audit: {
						projectName: operation.project_name,
						issueId: operation.issue_id,
						source: "bridge-land",
						reason: `land-cleanup:${operation.operation_id}`,
					},
				},
			);
			if (!outcome.queued) {
				skipped += 1;
				continue;
			}
			db.requestRunnerShutdown(session.execution_id, requestId, nowMs());
			deliverable.push(session);
		}
		const deadline = nowMs() + graceMs;
		let acked = 0;
		while (true) {
			acked = deliverable.filter((session) => {
				const requestId = `${operation.operation_id}:${session.execution_id}`;
				return (
					db.getRunnerShutdownRequest(session.execution_id, requestId)
						?.state === "acked"
				);
			}).length;
			if (acked === deliverable.length || nowMs() >= deadline) break;
			await sleep(Math.min(500, Math.max(1, deadline - nowMs())));
		}
		return {
			requested: deliverable.length,
			acked,
			timedOut: deliverable.length - acked,
			skipped,
		};
	} finally {
		db.close();
	}
}
