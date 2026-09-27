import {
	discoverTmuxTargetByExecutionId,
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
	type RunnerTmuxTargetDiscovery,
	type TmuxTargetLookup,
} from "./tmux-lookup.js";

export type PatrolProcessLiveness = "alive" | "dead" | "unknown";
export type PatrolWindowLiveness =
	| "present"
	| "missing"
	| "dead_pin"
	| "pending"
	| "unknown";

export interface PatrolProcessObservation {
	body: PatrolProcessLiveness;
	window: PatrolWindowLiveness;
}

export interface PatrolProcessProbeDeps {
	observeBody?: (
		executionId: string,
		projectName: string,
	) => Promise<PatrolProcessLiveness>;
	lookup?: (executionId: string, projectName: string) => TmuxTargetLookup;
	probe?: (tmuxWindow: string) => Promise<RunnerLiveness>;
	discover?: (executionId: string) => Promise<RunnerTmuxTargetDiscovery>;
}

function windowVerdict(state: RunnerLiveness): PatrolWindowLiveness {
	if (state === "alive") return "present";
	if (state === "dead_pin") return "dead_pin";
	if (state === "absent") return "missing";
	return "unknown";
}

async function probeDiscoveredWindow(
	executionId: string,
	deps: PatrolProcessProbeDeps,
): Promise<PatrolWindowLiveness> {
	const discovery = await (deps.discover ?? discoverTmuxTargetByExecutionId)(
		executionId,
	);
	if (discovery.kind === "missing") return "missing";
	if (discovery.kind !== "found") return "unknown";
	if (discovery.tmuxWindow.endsWith(":pending")) return "pending";
	return windowVerdict(
		await (deps.probe ?? probeRunnerProcessLiveness)(discovery.tmuxWindow),
	);
}

async function observeWindow(
	executionId: string,
	projectName: string,
	deps: PatrolProcessProbeDeps,
): Promise<PatrolWindowLiveness> {
	try {
		const lookup = (deps.lookup ?? lookupTmuxTarget)(executionId, projectName);
		if (lookup.kind === "error") return "unknown";
		if (lookup.kind === "gone") {
			return probeDiscoveredWindow(executionId, deps);
		}
		if (lookup.target.tmuxWindow.endsWith(":pending")) {
			const discovered = await probeDiscoveredWindow(executionId, deps);
			return discovered === "missing" ? "pending" : discovered;
		}
		return windowVerdict(
			await (deps.probe ?? probeRunnerProcessLiveness)(
				lookup.target.tmuxWindow,
			),
		);
	} catch {
		return "unknown";
	}
}

/** Patrol reports process-body truth and presentation health separately. A
 * missing/dead tmux pane remains actionable UI evidence but never becomes
 * authorization to terminalize or replace an execution body. */
export async function observePatrolProcessLiveness(
	executionId: string,
	projectName: string,
	deps: PatrolProcessProbeDeps = {},
): Promise<PatrolProcessObservation> {
	const bodyPromise = Promise.resolve()
		.then(() => deps.observeBody?.(executionId, projectName) ?? "unknown")
		.catch(() => "unknown" as const);
	const [body, window] = await Promise.all([
		bodyPromise,
		observeWindow(executionId, projectName, deps),
	]);
	return { body, window };
}

/** Compatibility projection for the patrol-loop ledger. Only body truth is
 * returned; window diagnostics are available via observePatrolProcessLiveness. */
export async function probePatrolProcessLiveness(
	executionId: string,
	projectName: string,
	deps: PatrolProcessProbeDeps = {},
): Promise<PatrolProcessLiveness> {
	return (await observePatrolProcessLiveness(executionId, projectName, deps))
		.body;
}
