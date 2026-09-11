import { createHash } from "node:crypto";

export interface BetaBinding {
	projectName: string;
	repositoryId: number;
	canonicalRepo: string;
	workflowId: number;
	defaultBranch: string;
	bindingRevision: string;
	tokenEnv?: string;
}
export interface BetaLane extends BetaBinding {
	activatedAtMs: number;
	intervalMs: number | null;
	lastDueAtMs: number | null;
	nextDueAtMs: number;
	activeOccurrenceId: string | null;
}
export interface BetaOccurrence {
	occurrenceId: string;
	projectName: string;
	bindingRevision: string;
	scheduledAtMs: number;
	sourceCommit: string;
	state:
		| "prepared"
		| "dispatching"
		| "dispatch_unknown"
		| "accepted"
		| "running"
		| "succeeded"
		| "failed"
		| "attention"
		| "exhausted";
	runIds: number[];
	attemptCount: number;
	retryAtMs: number | null;
	lastError: string | null;
	createdAtMs: number;
	settledAtMs: number | null;
}
export function betaOccurrenceId(
	project: string,
	revision: string,
	due: number,
): string {
	return createHash("sha256")
		.update(JSON.stringify([project, revision, due]))
		.digest("hex");
}

export interface BetaStoredObservation {
	owner: "legacy" | "paused" | "bridge" | "unknown";
	status: string;
	reason: string | null;
	observedAtMs: number;
	pollAfterMs: number;
}
