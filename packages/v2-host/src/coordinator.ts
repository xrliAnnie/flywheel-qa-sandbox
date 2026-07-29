import {
	type DagPorts,
	type DispatchResult,
	dispatchOnce,
	recoverPendingLaunches,
} from "flywheel-v2-dag";
import type { Kernel } from "flywheel-v2-kernel";

export interface CoordinatorTickResult {
	status: "held" | "ran";
	recovery?: Awaited<ReturnType<typeof recoverPendingLaunches>>;
	dispatch?: DispatchResult;
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
		return { status: "ran", recovery, dispatch };
	}
}
