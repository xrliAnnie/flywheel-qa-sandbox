#!/usr/bin/env npx tsx
/**
 * Run multiple Linear issues through the Flywheel pipeline in parallel.
 *
 * Usage:
 *   npx tsx scripts/run-project.ts <project-name> <project-root> [options]
 *
 * Options:
 *   --max-parallel N       Max concurrent sessions (default: 3)
 *   --issue-ids ID1,ID2    Comma-separated issue IDs (skips Linear API)
 *
 * Examples:
 *   npx tsx scripts/run-project.ts geoforge3d ~/Dev/GeoForge3D
 *   npx tsx scripts/run-project.ts geoforge3d ~/Dev/GeoForge3D --max-parallel 2
 *   npx tsx scripts/run-project.ts geoforge3d ~/Dev/GeoForge3D --issue-ids GEO-95,GEO-96
 */

import { existsSync } from "node:fs";

import { Semaphore } from "../packages/core/dist/Semaphore.js";
import { sanitizeTmuxName } from "../packages/core/dist/index.js";
import type { DagNode } from "../packages/dag-resolver/dist/DagResolver.js";
import { DagResolver } from "../packages/dag-resolver/dist/DagResolver.js";
import { DagDispatcher } from "../packages/edge-worker/dist/DagDispatcher.js";
import {
	type FlywheelComponents,
	killTmuxSession,
	log,
	setupComponents,
	teardownComponents,
} from "./lib/setup.js";

// ── Helpers ──────────────────────────────────────────────────

function getFlag(flag: string): string | undefined {
	const idx = process.argv.indexOf(flag);
	if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
	return process.argv[idx + 1];
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const projectName = args[0];
	const projectRoot = args[1];

	if (!projectName || !projectRoot) {
		console.error(
			"Usage: npx tsx scripts/run-project.ts <project-name> <project-root> [--max-parallel N] [--issue-ids ID1,ID2]",
		);
		process.exit(1);
	}

	const resolvedRoot = projectRoot.replace(/^~/, process.env.HOME ?? "");
	const maxParallel = parseInt(getFlag("--max-parallel") ?? "3", 10);
	const issueIdsRaw = getFlag("--issue-ids");

	if (!existsSync(resolvedRoot)) {
		console.error(`ERROR: Project root does not exist: ${resolvedRoot}`);
		process.exit(1);
	}

	console.log("\n========================================");
	console.log(`  Flywheel — Run Project: ${projectName}`);
	console.log(`  Root: ${resolvedRoot}`);
	console.log(`  Max Parallel: ${maxParallel}`);
	console.log("========================================\n");

	// 1. Build DAG
	let nodes: DagNode[];
	if (issueIdsRaw) {
		nodes = issueIdsRaw
			.split(",")
			.map((id) => ({ id: id.trim(), blockedBy: [] }));
		log(`Using provided issue IDs: ${nodes.map((n) => n.id).join(", ")}`);
	} else {
		console.error(
			"ERROR: --issue-ids required. Linear API integration is planned for v0.2.1+.",
		);
		process.exit(1);
	}

	if (nodes.length === 0) {
		log("No issues to process.");
		process.exit(0);
	}

	const resolver = new DagResolver(nodes);
	// GEO-277: Sanitize session name so openTmuxViewer and TmuxAdapter agree
	const tmuxSessionName = sanitizeTmuxName(`flywheel-${projectName}`);

	// 2. Initialize components
	let components: FlywheelComponents;
	try {
		components = await setupComponents({
			projectRoot: resolvedRoot,
			tmuxSessionName,
			projectName,
			fetchIssue: async (id: string) => {
				// Minimal stub — real Linear integration in v0.2.1+
				return {
					title: `Issue ${id}`,
					description: `Auto-fetched issue ${id}`,
					identifier: id,
				};
			},
		});
	} catch (err) {
		console.error("Failed to initialize components:", err);
		process.exit(1);
	}

	// 3. Create DagDispatcher
	const semaphore = new Semaphore(maxParallel);
	const dispatcher = new DagDispatcher(
		resolver,
		components.blueprint,
		resolvedRoot,
		(_node) => ({
			teamName: "eng",
			runnerName: "claude",
			projectName,
			sessionTimeoutMs: 2_700_000,
		}),
		semaphore,
		tmuxSessionName,
		components.worktreeManager,
		projectName,
	);

	// 4. Wire onNodeComplete for logging + Slack
	dispatcher.onNodeComplete = async (nodeId, result) => {
		log(
			`[${nodeId}] ${result.success ? "DONE" : "SHELVED"}${result.error ? ` — ${result.error}` : ""}`,
		);
		if (components.slackNotifier && result.decision) {
			const route = result.decision.route;
			components.slackNotifier
				.notify(
					{
						issueId: nodeId,
						issueIdentifier: nodeId,
						issueTitle: `Issue ${nodeId}`,
						labels: [],
						projectId: projectName,
						exitReason: route === "blocked" ? "error" : "completed",
						baseSha: "",
						commitCount: result.evidence?.commitCount ?? 0,
						commitMessages: result.evidence?.commitMessages ?? [],
						changedFilePaths: result.evidence?.changedFilePaths ?? [],
						filesChangedCount: result.evidence?.filesChangedCount ?? 0,
						linesAdded: result.evidence?.linesAdded ?? 0,
						linesRemoved: result.evidence?.linesRemoved ?? 0,
						diffSummary: result.evidence?.diffSummary ?? "",
						headSha: result.evidence?.headSha ?? null,
						durationMs: result.durationMs ?? 0,
						consecutiveFailures: 0,
						partial: result.evidence?.partial ?? false,
					},
					result.decision,
					{ tmuxSession: tmuxSessionName },
				)
				.catch((err) => {
					console.warn(
						`[Slack] Notification failed for ${nodeId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
		}
	};

	// 5. Dispatch
	log(`Dispatching ${nodes.length} issues (max parallel: ${maxParallel})`);
	try {
		const dispatchResult = await dispatcher.dispatch();

		// 6. Report
		console.log("\n--- Dispatch Summary ---");
		console.log(
			`  completed: ${dispatchResult.completed.join(", ") || "(none)"}`,
		);
		console.log(
			`  shelved:   ${dispatchResult.shelved.join(", ") || "(none)"}`,
		);
		console.log(
			`  duration:  ${((dispatchResult.durationMs ?? 0) / 1000).toFixed(1)}s`,
		);
		console.log(`  halted:    ${dispatchResult.halted}`);

		if (dispatchResult.nodeResults) {
			console.log("\n--- Per-Node Results ---");
			for (const [id, nr] of Object.entries(dispatchResult.nodeResults)) {
				const cost = nr.costUsd?.toFixed(4) ?? "N/A";
				console.log(
					`  ${id}: ${nr.success ? "OK" : "FAIL"} — $${cost}${nr.error ? ` (${nr.error})` : ""}`,
				);
			}
		}

		console.log("\n========================================");
		if (dispatchResult.completed.length > 0) {
			console.log(
				`  Completed: ${dispatchResult.completed.length}/${nodes.length}`,
			);
		}
		if (dispatchResult.shelved.length > 0) {
			console.log(
				`  Shelved: ${dispatchResult.shelved.length}/${nodes.length}`,
			);
		}
		console.log("========================================\n");

		process.exitCode = dispatchResult.shelved.length > 0 ? 1 : 0;
	} catch (err) {
		console.error("Dispatch error:", err);
		process.exitCode = 1;
	} finally {
		await teardownComponents(components);
		killTmuxSession(tmuxSessionName);
	}
}

main().catch((err) => {
	console.error("Script crashed:", err);
	process.exit(1);
});
