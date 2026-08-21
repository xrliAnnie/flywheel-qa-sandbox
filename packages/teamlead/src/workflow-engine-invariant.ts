export const ENGINE_INVARIANT_REASON_PREFIX = "engine_invariant:";

export class WorkflowEngineInvariantError extends Error {
	override name = "WorkflowEngineInvariantError";

	constructor(readonly invariant: string) {
		super(invariant);
	}
}

export function engineInvariantFromReason(reason: string): string | undefined {
	return reason.startsWith(ENGINE_INVARIANT_REASON_PREFIX)
		? reason.slice(ENGINE_INVARIANT_REASON_PREFIX.length)
		: undefined;
}
