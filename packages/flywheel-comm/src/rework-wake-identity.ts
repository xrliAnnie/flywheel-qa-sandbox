export type ReworkWakeMetadata = {
	wakeId: string;
	activationId: string;
	epoch: number;
};

export type ReworkWakeIdentity = ReworkWakeMetadata & { executionId: string };

export type ReworkWakeRetirementProof = ReworkWakeIdentity & {
	retirementId: string;
	runId: string;
	requestId: string;
	nodeId: string;
	attempt: number;
	oldRouteRevision: number;
	newRouteRevision: number;
	replacementExecutionId: string;
	replacementEventUid: string;
};

export function buildReworkWakeId(input: {
	requestId: string;
	activationId: string;
	epoch: number;
}): string {
	return `rework-wake:${input.requestId}:${input.activationId}:epoch:${input.epoch}`;
}

/** Identity hints only: authorization requires the immutable parent and engine proof. */
export function parseReworkWakeMetadata(
	input: unknown,
): ReworkWakeMetadata | null {
	let value = input;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (
		row.kind !== "workflow_rework" ||
		typeof row.wakeId !== "string" ||
		!row.wakeId.trim() ||
		typeof row.activationId !== "string" ||
		!row.activationId.trim() ||
		typeof row.epoch !== "number" ||
		!Number.isSafeInteger(row.epoch) ||
		row.epoch <= 0
	)
		return null;
	return {
		wakeId: row.wakeId,
		activationId: row.activationId,
		epoch: row.epoch,
	};
}
