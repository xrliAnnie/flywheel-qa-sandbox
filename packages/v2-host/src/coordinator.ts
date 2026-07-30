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

export interface CoordinatorTickResult {
	status: "held" | "ran";
	recovery?: Awaited<ReturnType<typeof recoverPendingLaunches>>;
	dispatch?: DispatchResult;
	/** FLY-1544 ⑤⑥: post-merge whole-issue closure runs on the same tick. */
	closure?: IssueClosureResult;
	/** FLY-1544 doorbell: lead→runner mail pasted into session terminals. */
	doorbell?: DoorbellResult;
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
		const recovery = await recoverPendingLaunches(this.#kernel, this.#ports);
		const dispatch = await dispatchOnce(this.#kernel, this.#ports);
		// FLY-1544 ⑤⑥: whole-issue closure fires here — the tick is the only
		// place with a real launcher, and it observes gates settled by EITHER
		// ship path (direct executeShip or the reconcile-ship re-entry, both of
		// which run in the operator CLI process without runner control).
		const closure = await closeShippedIssues(this.#kernel, this.#ports);
		// FLY-1544 doorbell: mail addressed to a live session is pasted into its
		// terminal every tick — the engine rings, the runner never polls.
		const doorbell = await ringSessionDoorbells(this.#kernel, this.#ports);
		return { status: "ran", recovery, dispatch, closure, doorbell };
	}
}
