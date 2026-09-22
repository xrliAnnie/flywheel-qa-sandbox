import type { StateStore } from "../StateStore.js";

export interface LandOperationAuditIdentity {
	operationId: string;
	ownerId: string;
	ownerInstanceId?: string;
	generation: number;
	runId?: string | null;
	sourceExecutionId?: string | null;
}

function auditToken(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

/**
 * Persist an operation-scoped closeout audit without inventing a session
 * execution id. Auxiliary land steps are generation/lease fenced and do not
 * advance the operation retry epoch.
 */
export function recordLandCloseoutAudit(
	store: Pick<StateStore, "getLandOperation" | "recordLandOperationStep">,
	identity: LandOperationAuditIdentity,
	input: {
		evidenceId: string;
		eventKind: string;
		receipt: Record<string, unknown>;
		now?: string;
		threadArchive?: { threadId: string; archivedAt: string };
	},
): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string } {
	const operation = store.getLandOperation(identity.operationId);
	const reservationEpoch =
		operation?.closeout_reservation_epoch ?? identity.generation;
	return store.recordLandOperationStep({
		operationId: identity.operationId,
		ownerId: identity.ownerId,
		ownerInstanceId: identity.ownerInstanceId,
		generation: identity.generation,
		step: [
			"aux:closeout_audit",
			auditToken(String(reservationEpoch)),
			auditToken(input.evidenceId),
			auditToken(input.eventKind),
		].join(":"),
		receipt: {
			operationId: identity.operationId,
			runId: identity.runId ?? operation?.run_id ?? null,
			sourceExecutionId: identity.sourceExecutionId ?? null,
			eventKind: input.eventKind,
			...input.receipt,
		},
		now: input.now ?? new Date().toISOString(),
		threadArchive: input.threadArchive,
	});
}
