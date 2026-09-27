import type { BodyObservation } from "flywheel-claude-runner";
import type { StateStore } from "../StateStore.js";

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
