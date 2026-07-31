import {
	closeShippedIssues,
	type DagPorts,
	type DispatchResult,
	type DoorbellResult,
	dispatchOnce,
	type IssueClosureResult,
	recoverPendingLaunches,
	ringSessionDoorbells,
} from "flywheel-v2-dag";
import type { Kernel } from "flywheel-v2-kernel";

export type CoordinatorPhase = "recovery" | "dispatch" | "closure" | "doorbell";

/**
 * FLY-1556: a phase that threw. Recorded in the tick result (and durably by the
 * host) instead of aborting the tick — one broken phase must not stop the
 * others, and nothing a tick does may take the engine process down.
 */
export interface CoordinatorPhaseFailure {
	phase: CoordinatorPhase;
	error: string;
}

export interface CoordinatorTickResult {
	status: "held" | "ran";
	recovery?: Awaited<ReturnType<typeof recoverPendingLaunches>>;
	dispatch?: DispatchResult;
	/** FLY-1544 ⑤⑥: post-merge whole-issue closure runs on the same tick. */
	closure?: IssueClosureResult;
	/** FLY-1544 doorbell: lead→runner mail pasted into session terminals. */
	doorbell?: DoorbellResult;
	/** FLY-1556: present only when a phase threw this tick. */
	phaseFailures?: CoordinatorPhaseFailure[];
}

export class V2RuntimeCoordinator {
	readonly #kernel: Kernel;
	readonly #ports: DagPorts;
	readonly #authorityState: () => "cutover" | "live";
	#running?: Promise<CoordinatorTickResult>;

	constructor(options: {
		kernel: Kernel;
		ports: DagPorts;
		authorityState: () => "cutover" | "live";
	}) {
		this.#kernel = options.kernel;
		this.#ports = options.ports;
		this.#authorityState = options.authorityState;
	}

	tick(): Promise<CoordinatorTickResult> {
		if (this.#running) return this.#running;
		const run = this.#tick().finally(() => {
			if (this.#running === run) this.#running = undefined;
		});
		this.#running = run;
		return run;
	}

	async #tick(): Promise<CoordinatorTickResult> {
		if (this.#authorityState() !== "live") return { status: "held" };
		// FLY-1556: each phase is its own failure domain. Before this, any
		// exception a phase leaked — one corrupt launch claim, one unreadable
		// meta row — aborted the tick, and the host wiring turned that into a
		// process exit: a single session's dirty state took down the socket,
		// the outbound service and every healthy runner with it.
		const failures: CoordinatorPhaseFailure[] = [];
		const phase = async <T>(
			name: CoordinatorPhase,
			run: () => Promise<T>,
		): Promise<T | undefined> => {
			try {
				return await run();
			} catch (error) {
				failures.push({
					phase: name,
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			}
		};
		const recovery = await phase("recovery", () =>
			recoverPendingLaunches(this.#kernel, this.#ports),
		);
		const dispatch = await phase("dispatch", () =>
			dispatchOnce(this.#kernel, this.#ports),
		);
		// FLY-1544 ⑤⑥: whole-issue closure fires here — the tick is the only
		// place with a real launcher, and it observes gates settled by EITHER
		// ship path (direct executeShip or the reconcile-ship re-entry, both of
		// which run in the operator CLI process without runner control).
		const closure = await phase("closure", () =>
			closeShippedIssues(this.#kernel, this.#ports),
		);
		// FLY-1544 doorbell: mail addressed to a live session is pasted into its
		// terminal every tick — the engine rings, the runner never polls.
		const doorbell = await phase("doorbell", () =>
			ringSessionDoorbells(this.#kernel, this.#ports),
		);
		return {
			status: "ran",
			...(recovery ? { recovery } : {}),
			...(dispatch ? { dispatch } : {}),
			...(closure ? { closure } : {}),
			...(doorbell ? { doorbell } : {}),
			...(failures.length > 0 ? { phaseFailures: failures } : {}),
		};
	}
}
