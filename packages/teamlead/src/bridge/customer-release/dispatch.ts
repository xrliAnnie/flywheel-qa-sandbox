import type {
	CustomerReleaseGitHub,
	ReleaseWorkflowBinding,
	ReleaseWorkflowObservation,
	ReleaseWorkflowRequest,
} from "./github.js";
import type { CustomerReleaseStore } from "./store.js";

/** The append-only cycle journal owns the single dispatch attempt. A lost
 * response or a new adapter instance only observes the frozen run marker. */
export class CustomerReleaseDispatch {
	constructor(
		private readonly options: {
			store: CustomerReleaseStore;
			transport: Pick<CustomerReleaseGitHub, "dispatch" | "observe">;
			now: () => number;
		},
	) {}
	async tick(
		cycleId: string,
		binding: ReleaseWorkflowBinding,
		request: ReleaseWorkflowRequest,
		signal?: AbortSignal,
	): Promise<ReleaseWorkflowObservation | null> {
		signal?.throwIfAborted();
		const first = this.options.store.startWorkflowDispatch(
			cycleId,
			binding,
			request,
			this.options.now(),
		);
		try {
			if (first)
				await this.options.transport.dispatch(binding, request, signal);
			return await this.options.transport.observe(binding, request, signal);
		} catch {
			// No retry of the POST. The caller polls this same durable intent and
			// applies its fixed cycle deadline; null never means proven no-write.
			return null;
		}
	}
}
