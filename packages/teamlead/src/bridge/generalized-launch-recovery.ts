import { execFile } from "node:child_process";
import type { WorkflowLaunchOwnerRow } from "../StateStore.js";
import {
	discoverTmuxTargetByExecutionId,
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
	type RunnerTmuxTargetDiscovery,
	type TmuxTargetLookup,
} from "./tmux-lookup.js";

export type GeneralizedLaunchLiveness = "alive" | "dead" | "unknown";
export type GeneralizedLaunchTargetLookup = TmuxTargetLookup;

interface GeneralizedLaunchProbeDeps {
	lookup?: (executionId: string, projectName: string) => TmuxTargetLookup;
	probe?: (tmuxWindow: string) => Promise<RunnerLiveness>;
	discover?: (executionId: string) => Promise<RunnerTmuxTargetDiscovery>;
	/** Does ANY process on this host reference the execution id? */
	hasHostProcess?: (executionId: string) => Promise<boolean>;
	/** Terminal-session callers may combine three independent absence proofs. */
	allowMissingTargetHostAbsence?: boolean;
}

/** `pgrep -f <executionId>`: exit 0 = at least one match. Errors (incl. exit 1
 * = no match) resolve false-vs-true conservatively: only a clean "no match"
 * proves absence; spawn failures return true so the verdict stays "unknown". */
export function hasHostProcessByExecutionId(
	executionId: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			execFile("pgrep", ["-f", executionId], { timeout: 5_000 }, (error) => {
				if (!error) return resolve(true); // matches exist
				const code = (error as { code?: number | string }).code;
				resolve(code !== 1); // 1 = clean no-match → false; anything else → true
			});
		} catch {
			resolve(true);
		}
	});
}

/**
 * A committed launch may be adopted only with positive delivery evidence.
 * CommDB absence and probe errors are deliberately UNKNOWN: registration is
 * non-atomic with the marker, so neither is proof that the gated shell died.
 */
export async function probeGeneralizedLaunchLiveness(
	executionId: string,
	projectName: string,
	deps: GeneralizedLaunchProbeDeps = {},
): Promise<GeneralizedLaunchLiveness> {
	const lookup = (deps.lookup ?? lookupTmuxTarget)(executionId, projectName);
	if (lookup.kind === "error") {
		return "unknown";
	}
	if (lookup.kind === "gone") {
		if (!deps.allowMissingTargetHostAbsence) return "unknown";
		const discovery = await (deps.discover ?? discoverTmuxTargetByExecutionId)(
			executionId,
		);
		if (discovery.kind === "found") {
			const state = await (deps.probe ?? probeRunnerProcessLiveness)(
				discovery.tmuxWindow,
			);
			if (state === "alive") return "alive";
			if (state === "dead_pin" || state === "absent") return "dead";
			return "unknown";
		}
		if (discovery.kind !== "missing") return "unknown";
		const hasProcess = await (
			deps.hasHostProcess ?? hasHostProcessByExecutionId
		)(executionId);
		return hasProcess ? "unknown" : "dead";
	}
	if (lookup.target.tmuxWindow.endsWith(":pending")) {
		// 2026-07-24 incident (founder-directed hotfix): a runner that dies
		// BEFORE its tmux window materializes stays ":pending" forever. There is
		// nothing to probe, so this branch returned "unknown" eternally and the
		// dead-exec sweep never reclaimed the node (unknown = keep unchanged) —
		// the run wedged and every later dispatch replayed STALE_START_RESPONSE.
		// Registration can lag behind materialization, so discover by execution
		// identity before falling back to the host-wide process absence proof.
		const discovery = await (deps.discover ?? discoverTmuxTargetByExecutionId)(
			executionId,
		);
		if (discovery.kind === "found") {
			const state = await (deps.probe ?? probeRunnerProcessLiveness)(
				discovery.tmuxWindow,
			);
			if (state === "alive") return "alive";
			if (state === "dead_pin" || state === "absent") return "dead";
			return "unknown";
		}
		if (discovery.kind !== "missing") return "unknown";
		// If neither discovery nor the host process table finds the execution,
		// the runner cannot be alive. Any matching process stays unknown.
		const hasProcess = await (
			deps.hasHostProcess ?? hasHostProcessByExecutionId
		)(executionId);
		return hasProcess ? "unknown" : "dead";
	}
	const state = await (deps.probe ?? probeRunnerProcessLiveness)(
		lookup.target.tmuxWindow,
	);
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
