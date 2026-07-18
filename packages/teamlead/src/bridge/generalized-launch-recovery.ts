import type { WorkflowLaunchOwnerRow } from "../StateStore.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
	type TmuxTargetLookup,
} from "./tmux-lookup.js";

export type GeneralizedLaunchLiveness = "alive" | "dead" | "unknown";
export type GeneralizedLaunchTargetLookup = TmuxTargetLookup;

interface GeneralizedLaunchProbeDeps {
	lookup: (executionId: string, projectName: string) => TmuxTargetLookup;
	probe: (tmuxWindow: string) => Promise<RunnerLiveness>;
}

/**
 * A committed launch may be adopted only with positive delivery evidence.
 * CommDB absence and probe errors are deliberately UNKNOWN: registration is
 * non-atomic with the marker, so neither is proof that the gated shell died.
 */
export async function probeGeneralizedLaunchLiveness(
	executionId: string,
	projectName: string,
	deps: GeneralizedLaunchProbeDeps = {
		lookup: lookupTmuxTarget,
		probe: probeRunnerProcessLiveness,
	},
): Promise<GeneralizedLaunchLiveness> {
	const lookup = deps.lookup(executionId, projectName);
	if (
		lookup.kind !== "found" ||
		lookup.target.tmuxWindow.endsWith(":pending")
	) {
		return "unknown";
	}
	const state = await deps.probe(lookup.target.tmuxWindow);
	if (state === "alive") return "alive";
	if (state === "dead_pin" || state === "absent") return "dead";
	return "unknown";
}

type WorkflowLaunchDeliveryEvidence = Pick<
	WorkflowLaunchOwnerRow,
	"owner_generation" | "committed_generation" | "delivery_state"
>;

interface WorkflowLaunchOwnerReader {
	getWorkflowLaunchOwner(
		executionId: string,
	): WorkflowLaunchDeliveryEvidence | undefined;
}

/** Return only a launch owner whose current generation is durably delivered. */
export function getGeneralizedLaunchDelivery(
	store: WorkflowLaunchOwnerReader,
	executionId: string,
): WorkflowLaunchDeliveryEvidence | undefined {
	const owner = store.getWorkflowLaunchOwner(executionId);
	return owner &&
		owner.committed_generation === owner.owner_generation &&
		owner.delivery_state === "delivered"
		? owner
		: undefined;
}

interface WorkflowLaunchDeliveryWaitOptions {
	timeoutMs?: number;
	intervalMs?: number;
	sleep?: (delayMs: number) => Promise<void>;
}

/** Wait until marker delivery and its current owner generation agree durably. */
export async function waitForGeneralizedLaunchDelivery(
	store: WorkflowLaunchOwnerReader,
	executionId: string,
	options: WorkflowLaunchDeliveryWaitOptions = {},
): Promise<WorkflowLaunchDeliveryEvidence | undefined> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const intervalMs = options.intervalMs ?? 50;
	const sleep =
		options.sleep ??
		((delayMs: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const delivered = getGeneralizedLaunchDelivery(store, executionId);
		if (delivered) return delivered;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return undefined;
		await sleep(Math.min(intervalMs, remaining));
	}
}
