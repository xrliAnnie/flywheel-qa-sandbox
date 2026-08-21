import { execFile } from "node:child_process";
import {
	discoverTmuxTargetByExecutionId,
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
	type RunnerTmuxTargetDiscovery,
	type TmuxTargetLookup,
} from "./tmux-lookup.js";

export type PatrolProcessLiveness = "alive" | "dead" | "unknown";
type HostProcessPresence = boolean | "unknown";

export interface PatrolProcessProbeDeps {
	lookup?: (executionId: string, projectName: string) => TmuxTargetLookup;
	probe?: (tmuxWindow: string) => Promise<RunnerLiveness>;
	discover?: (executionId: string) => Promise<RunnerTmuxTargetDiscovery>;
	hasHostProcess?: (executionId: string) => Promise<HostProcessPresence>;
}

function hasHostProcessByExecutionId(
	executionId: string,
): Promise<HostProcessPresence> {
	return new Promise((resolve) => {
		try {
			execFile("pgrep", ["-f", executionId], { timeout: 5_000 }, (error) => {
				if (!error) return resolve(true);
				const code = (error as { code?: number | string }).code;
				resolve(code === 1 ? false : "unknown");
			});
		} catch {
			resolve("unknown");
		}
	});
}

async function probeTmuxTarget(
	tmuxWindow: string,
	executionId: string,
	deps: PatrolProcessProbeDeps,
): Promise<PatrolProcessLiveness> {
	if (tmuxWindow.endsWith(":pending")) {
		const discovery = await (deps.discover ?? discoverTmuxTargetByExecutionId)(
			executionId,
		);
		if (
			discovery.kind === "found" &&
			!discovery.tmuxWindow.endsWith(":pending")
		) {
			return probeTmuxTarget(discovery.tmuxWindow, executionId, deps);
		}
		if (discovery.kind !== "missing") return "unknown";
		const host = await (deps.hasHostProcess ?? hasHostProcessByExecutionId)(
			executionId,
		);
		return host === "unknown" ? "unknown" : host ? "alive" : "dead";
	}
	const state = await (deps.probe ?? probeRunnerProcessLiveness)(tmuxWindow);
	if (state === "alive") return "alive";
	if (state === "dead_pin" || state === "absent") return "dead";
	return "unknown";
}

/**
 * Read-only physical liveness used by patrol_tick. CommDB is only a target
 * locator: a missing row falls through to the execution marker and then a
 * host-process lookup, so total physical absence is positive death evidence.
 */
export async function probePatrolProcessLiveness(
	executionId: string,
	projectName: string,
	deps: PatrolProcessProbeDeps = {},
): Promise<PatrolProcessLiveness> {
	try {
		const lookup = (deps.lookup ?? lookupTmuxTarget)(executionId, projectName);
		if (lookup.kind === "error") return "unknown";
		if (lookup.kind === "found") {
			return probeTmuxTarget(lookup.target.tmuxWindow, executionId, deps);
		}

		const discovery = await (deps.discover ?? discoverTmuxTargetByExecutionId)(
			executionId,
		);
		if (discovery.kind === "found") {
			return probeTmuxTarget(discovery.tmuxWindow, executionId, deps);
		}
		if (discovery.kind !== "missing") return "unknown";
		const host = await (deps.hasHostProcess ?? hasHostProcessByExecutionId)(
			executionId,
		);
		return host === "unknown" ? "unknown" : host ? "alive" : "dead";
	} catch {
		return "unknown";
	}
}
