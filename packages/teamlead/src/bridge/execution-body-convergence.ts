import type { BodyObservation } from "flywheel-claude-runner";

/** Bridge-internal authority; never deserialize this input from a Runner request. */
export interface BodyDeathCommitInput {
	observation: BodyObservation;
	expectedCommIdentityRevision: string;
	observedTurnEpoch: number | null;
	/** Synchronous final read of the managed switch and reowner/OS identity fences. */
	isCurrent(observation: BodyObservation): boolean;
	markerDir?: string;
	nowMs: number;
}
export interface BodyDeathObligation {
	version: 1;
	obligationId: string;
	observation: BodyObservation;
	runId: string;
	nodeId: string;
	attempt: number;
	expectedCommIdentityRevision: string;
	observedTurnEpoch: number | null;
	terminalStatus: string;
	terminalLifecycleId: string | null;
	completionEventId: string | null;
	disposition:
		| "failed"
		| "terminal_preserved"
		| "completion_preserved"
		| "standby";
	committedAt: string;
}
export type BodyDeathCommitResult =
	| { ok: true; obligation: BodyDeathObligation; idempotentReplay: boolean }
	| { ok: false; reason: string };
