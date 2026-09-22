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
	probeHostProcess?: (
		executionId: string,
	) => Promise<HostProcessByExecutionIdProbe>;
	/** Terminal-session callers may combine three independent absence proofs. */
	allowMissingTargetHostAbsence?: boolean;
}

export type HostProcessByExecutionIdProbe =
	| { verdict: "live"; source: "pgrep" | "process-environment" }
	| { verdict: "absent"; source: "process-environment" }
	| {
			verdict: "unknown";
			source: "pgrep" | "process-environment";
			reason: string;
	  };

/** Read argv and the full host process environment without logging either.
 * Only clean absence from both sensors proves absence; any sensor failure
 * stays conservative through the boolean compatibility wrapper. */
export function hasHostProcessByExecutionId(
	executionId: string,
): Promise<boolean> {
	return probeHostProcessByExecutionId(executionId).then(
		(result) => result.verdict !== "absent",
	);
}

/** Closeout-only tri-state host probe. Sensor failures remain unknown rather
 * than being reported as a live process; the legacy boolean wrapper above
 * still maps unknown to true for its conservative existing callers. */
export function probeHostProcessByExecutionId(
	executionId: string,
): Promise<HostProcessByExecutionIdProbe> {
	return new Promise((resolve) => {
		if (!/^[A-Za-z0-9_.:-]+$/.test(executionId)) {
			resolve({
				verdict: "unknown",
				source: "process-environment",
				reason: "invalid_execution_id",
			});
			return;
		}
		try {
			execFile("pgrep", ["-f", executionId], { timeout: 5_000 }, (error) => {
				if (!error) return resolve({ verdict: "live", source: "pgrep" });
				const code = (error as { code?: number | string }).code;
				if (code !== 1) {
					resolve({
						verdict: "unknown",
						source: "pgrep",
						reason: `pgrep_failed:${String(code ?? "unknown")}`,
					});
					return;
				}
				// Codex's resident daemon/TUI carries the execution identity only in
				// its environment. pgrep inspects argv, so a clean pgrep miss is not
				// absence until the bounded host process snapshot also has no exact
				// FLYWHEEL_EXEC_ID marker. The snapshot is never logged.
				execFile(
					"/bin/ps",
					["eww", "-axo", "pid=,command="],
					{
						timeout: 5_000,
						maxBuffer: 16 * 1024 * 1024,
						encoding: "utf8",
					},
					(psError, stdout) => {
						if (psError || typeof stdout !== "string") {
							const psCode = (psError as { code?: number | string } | null)
								?.code;
							resolve({
								verdict: "unknown",
								source: "process-environment",
								reason: `process_snapshot_failed:${String(psCode ?? "unknown")}`,
							});
							return;
						}
						const marker = `FLYWHEEL_EXEC_ID=${executionId}`;
						const live = stdout
							.split("\n")
							.some((line) =>
								line.split(/\s+/).some((field) => field === marker),
							);
						resolve(
							live
								? { verdict: "live", source: "process-environment" }
								: { verdict: "absent", source: "process-environment" },
						);
					},
				);
			});
		} catch {
			resolve({
				verdict: "unknown",
				source: "pgrep",
				reason: "pgrep_spawn_failed",
			});
		}
	});
}

async function hostProcessVerdict(
	executionId: string,
	deps: GeneralizedLaunchProbeDeps,
): Promise<HostProcessByExecutionIdProbe> {
	if (deps.probeHostProcess) return deps.probeHostProcess(executionId);
	if (deps.hasHostProcess) {
		return (await deps.hasHostProcess(executionId))
			? { verdict: "live", source: "pgrep" }
			: { verdict: "absent", source: "process-environment" };
	}
	return probeHostProcessByExecutionId(executionId);
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
		const host = await hostProcessVerdict(executionId, deps);
		return host.verdict === "absent" ? "dead" : "unknown";
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
		const host = await hostProcessVerdict(executionId, deps);
		return host.verdict === "absent" ? "dead" : "unknown";
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
