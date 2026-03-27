/**
 * GEO-168: Retry runtime builder — assembles per-project Blueprint with
 * DirectEventSink for bridge-local retry execution.
 *
 * GEO-267: Returns RunDispatcher (extends RetryDispatcher) with start() + concurrency control.
 * Accepts optional RuntimeRegistry for proper multi-Lead event routing.
 */

import { EventFilter } from "../../packages/teamlead/dist/bridge/EventFilter.js";
import { ForumTagUpdater } from "../../packages/teamlead/dist/bridge/ForumTagUpdater.js";
import type { RuntimeRegistry } from "../../packages/teamlead/dist/bridge/runtime-registry.js";
import type { BridgeConfig } from "../../packages/teamlead/dist/bridge/types.js";
import { DirectEventSink } from "../../packages/teamlead/dist/DirectEventSink.js";
import type { ProjectEntry } from "../../packages/teamlead/dist/ProjectConfig.js";
import type { StateStore } from "../../packages/teamlead/dist/StateStore.js";
import { sanitizeTmuxName } from "../../packages/core/dist/index.js";
import { RunDispatcher } from "./retry-dispatcher.js";
import {
	type FlywheelComponents,
	log,
	setupComponents,
	teardownComponents,
} from "./setup.js";

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
		// WARNING: labels and projectId are unavailable without LINEAR_API_KEY.
		// This affects agent dispatch routing and CIPHER dimension extraction.
		// Set LINEAR_API_KEY in the environment for full retry fidelity.
		if (!accessToken) {
			console.warn(
				"[RetryRuntime] LINEAR_API_KEY not set — retry will lack labels/projectId (agent routing may be degraded)",
			);
		} else {
			console.warn(
				"[RetryRuntime] Linear API fetch failed for issue %s — falling back to StateStore metadata",
				id,
			);
		}
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
	registry?: RuntimeRegistry,
): Promise<RunDispatcher> {
	const projectRuntimes = new Map<
		string,
		{
			blueprint: FlywheelComponents["blueprint"];
			projectRoot: string;
			tmuxSessionName: string;
		}
	>();
	const cleanupHandles: Array<() => Promise<void>> = [];

	for (const project of projects) {
		log(
			`[RetryRuntime] Setting up runtime for project: ${project.projectName}`,
		);

		const eventFilter = new EventFilter();
		const statusTagMap = bridgeConfig.statusTagMap ?? {};
		const forumTagUpdater = new ForumTagUpdater(statusTagMap);
		// GEO-267: Pass registry to DirectEventSink for proper multi-Lead event routing
		const directSink = new DirectEventSink(
			store,
			bridgeConfig,
			projects,
			eventFilter,
			forumTagUpdater,
			registry,
		);
		let components: FlywheelComponents | undefined;

		try {
			// GEO-277: Sanitize once, reuse everywhere — both TmuxAdapter
			// and openTmuxViewer must see the same session name
			const tmuxSessionName = sanitizeTmuxName(
				`retry-${project.projectName}`,
			);

			components = await setupComponents({
				projectRoot: project.projectRoot,
				tmuxSessionName,
				projectName: project.projectName,
				projectRepo: project.projectRepo,
				fetchIssue: createFetchIssue(store),
				eventEmitterOverride: directSink,
				skipSlackLegacy: true,
			});

			projectRuntimes.set(project.projectName, {
				blueprint: components.blueprint,
				projectRoot: project.projectRoot,
				tmuxSessionName,
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
				try {
					await teardownComponents(components);
				} catch {
					/* best-effort */
				}
			}
		}
	}

	if (projectRuntimes.size === 0) {
		console.warn(
			"[RetryRuntime] No project runtimes initialized — start/retry will be unavailable",
		);
	} else {
		log(
			`[RetryRuntime] ${projectRuntimes.size}/${projects.length} project(s) ready (maxConcurrent: ${bridgeConfig.maxConcurrentRunners})`,
		);
	}

	return new RunDispatcher(
		projectRuntimes,
		cleanupHandles,
		bridgeConfig.maxConcurrentRunners,
	);
}
