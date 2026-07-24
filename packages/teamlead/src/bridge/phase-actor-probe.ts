import type { PhaseLiveness } from "./phase-actor-reentry.js";
import type { PhaseSession } from "./phase-orchestrator.js";
import type { TmuxTargetLookup } from "./tmux-lookup.js";

/**
 * Preserve the distinction between a missing CommDB registration and a failed
 * CommDB read before a re-entry decision is allowed to consider replacement.
 */
export async function probeRegisteredPhaseActor(input: {
	session: PhaseSession;
	lookupTarget(executionId: string, projectName: string): TmuxTargetLookup;
	probeTarget(tmuxWindow: string): Promise<PhaseLiveness>;
}): Promise<PhaseLiveness> {
	const lookup = input.lookupTarget(
		input.session.execution_id,
		input.session.project_name ?? "",
	);
	if (lookup.kind === "error") return "indeterminate";
	if (lookup.kind === "gone") return "absent";
	return input.probeTarget(lookup.target.tmuxWindow);
}
