/**
 * GEO-168: Retry runtime builder — assembles per-project Blueprint with
 * DirectEventSink for bridge-local retry execution.
 */

import type { StateStore } from "../../packages/teamlead/dist/StateStore.js";
import type { BridgeConfig } from "../../packages/teamlead/dist/bridge/types.js";
import type { ProjectEntry } from "../../packages/teamlead/dist/ProjectConfig.js";
import { DirectEventSink } from "../../packages/teamlead/dist/DirectEventSink.js";
import { setupComponents, teardownComponents, log, type FlywheelComponents } from "./setup.js";
import { RetryDispatcher } from "./retry-dispatcher.js";

/**
 * Build a fetchIssue function that returns issue metadata from StateStore.
 * For retry, the issue was already hydrated in the original execution — we can
 * look it up from the stored session. Falls back to minimal stub if not found.
 */
function createFetchIssueFromStore(store: StateStore) {
	return async (id: string) => {
		const session = store.getSessionByIssue(id);
		return {
			title: session?.issue_title ?? `Issue ${id}`,
			description: `Retry execution for issue ${id}`,
			identifier: session?.issue_identifier ?? id,
		};
	};
}

export async function setupRetryRuntime(
	store: StateStore,
	bridgeConfig: BridgeConfig,
	projects: ProjectEntry[],
): Promise<RetryDispatcher> {
	const projectRuntimes = new Map<string, { blueprint: FlywheelComponents["blueprint"]; projectRoot: string }>();
	const cleanupHandles: Array<() => Promise<void>> = [];

	for (const project of projects) {
		log(`[RetryRuntime] Setting up retry runtime for project: ${project.projectName}`);

		const directSink = new DirectEventSink(store, bridgeConfig);

		try {
			const components = await setupComponents({
				projectRoot: project.projectRoot,
				tmuxSessionName: `retry-${project.projectName}`,
				projectName: project.projectName,
				projectRepo: project.projectRepo,
				fetchIssue: createFetchIssueFromStore(store),
				eventEmitterOverride: directSink,
				skipSlackLegacy: true,
			});

			projectRuntimes.set(project.projectName, {
				blueprint: components.blueprint,
				projectRoot: project.projectRoot,
			});
			cleanupHandles.push(() => teardownComponents(components));

			log(`[RetryRuntime] ${project.projectName} ready`);
		} catch (err) {
			console.error(
				`[RetryRuntime] Failed to setup ${project.projectName}:`,
				err instanceof Error ? err.message : err,
			);
			// Continue with other projects — one failing project shouldn't block others
		}
	}

	if (projectRuntimes.size === 0) {
		console.warn("[RetryRuntime] No project runtimes initialized — retry will be unavailable");
	} else {
		log(`[RetryRuntime] ${projectRuntimes.size}/${projects.length} project(s) ready for retry`);
	}

	return new RetryDispatcher(projectRuntimes, cleanupHandles);
}
