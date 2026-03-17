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
 * Build a fetchIssue function that tries Linear API first, then falls back
 * to StateStore session data. This ensures retry executions get the full
 * issue description (not just a stub), which Blueprint uses as the prompt.
 */
function createFetchIssue(store: StateStore) {
	return async (id: string) => {
		// Try Linear API first — gives us full description, labels, projectId
		const accessToken = process.env.LINEAR_API_KEY;
		if (accessToken) {
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ accessToken });
				const issue = await client.issue(id);
				if (issue) {
					const labels = await issue.labels();
					const labelNames = labels.nodes.map((l) => l.name);
					return {
						title: issue.title,
						description: issue.description ?? "",
						labels: labelNames,
						projectId: issue.project ? (await issue.project)?.id : undefined,
						identifier: issue.identifier,
					};
				}
			} catch {
				// Linear API failed — fall through to StateStore fallback
			}
		}

		// Fallback: reconstruct from stored session metadata
		const session = store.getSessionByIssue(id);
		return {
			title: session?.issue_title ?? `Issue ${id}`,
			description: session?.summary ?? `Retry execution for issue ${id}`,
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
		let components: FlywheelComponents | undefined;

		try {
			components = await setupComponents({
				projectRoot: project.projectRoot,
				tmuxSessionName: `retry-${project.projectName}`,
				projectName: project.projectName,
				projectRepo: project.projectRepo,
				fetchIssue: createFetchIssue(store),
				eventEmitterOverride: directSink,
				skipSlackLegacy: true,
			});

			projectRuntimes.set(project.projectName, {
				blueprint: components.blueprint,
				projectRoot: project.projectRoot,
			});
			cleanupHandles.push(() => teardownComponents(components!));

			log(`[RetryRuntime] ${project.projectName} ready`);
		} catch (err) {
			console.error(
				`[RetryRuntime] Failed to setup ${project.projectName}:`,
				err instanceof Error ? err.message : err,
			);
			// Clean up partially initialized components
			if (components) {
				try { await teardownComponents(components); } catch { /* best-effort */ }
			}
		}
	}

	if (projectRuntimes.size === 0) {
		console.warn("[RetryRuntime] No project runtimes initialized — retry will be unavailable");
	} else {
		log(`[RetryRuntime] ${projectRuntimes.size}/${projects.length} project(s) ready for retry`);
	}

	return new RetryDispatcher(projectRuntimes, cleanupHandles);
}
