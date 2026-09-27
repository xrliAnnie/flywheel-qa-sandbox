import type { BodyObservation } from "flywheel-claude-runner";
import type { StateStore } from "../StateStore.js";
import { storeExecutionBodyDeathEnabled } from "./flag-store-runtime.js";

export type ExecutionBodyLivenessReader = (
	executionId: string,
	projectName: string,
) => "alive" | "dead" | "unknown";

interface BodyReaderOptions {
	store: Pick<
		StateStore,
		"getSession" | "getCurrentProjectedExecutionBodyDeath"
	>;
	sampler():
		| {
				read(executionId: string): BodyObservation | undefined;
				request(executionId: string): void;
		  }
		| undefined;
	isEnabled(): boolean;
}
/** Synchronous scheduling consumer. OS samples authorize the common convergence
 * path; only its settled, current-generation fact exposes death to replacement.
 * Mutating consumers must revalidate that fact inside their final transaction. */
export function createExecutionBodyReader(options: BodyReaderOptions) {
	return {
		read(
			executionId: string,
			projectName: string,
		): "alive" | "dead" | "unknown" {
			try {
				if (
					options.isEnabled() !== true ||
					options.store.getSession(executionId)?.project_name !== projectName
				)
					return "unknown";
				if (options.store.getCurrentProjectedExecutionBodyDeath(executionId))
					return "dead";
				const sampler = options.sampler();
				const observation = sampler?.read(executionId);
				if (observation?.verdict === "alive") return "alive";
				sampler?.request(executionId);
				return "unknown";
			} catch {
				return "unknown";
			}
		},
	};
}

/** Non-runtime callers can read already settled physical death from the same
 * ledger. Live/uncached observations require the runtime's shared reader. */
export function readStoredExecutionBodyLiveness(
	store: StateStore,
	executionId: string,
	projectName: string,
): ReturnType<ExecutionBodyLivenessReader> {
	return createExecutionBodyReader({
		store,
		sampler: () => undefined,
		isEnabled: () => storeExecutionBodyDeathEnabled({ mode: "ready", store }),
	}).read(executionId, projectName);
}
