#!/usr/bin/env npx tsx

/**
 * Run a single Linear issue through the Flywheel pipeline.
 *
 * Uses the full Blueprint flow (v0.2):
 *   1. Git preflight (assert clean tree)
 *   2. Pre-hydrate (fetch issue from Linear or use hardcoded data)
 *   3. Worktree setup (single-repo only; multi-repo falls back to v0.1.1)
 *   4. Skill injection (SKILL.md files into .claude/skills/)
 *   5. Launch Claude Code in tmux via TmuxRunner
 *   6. Wait for completion (HTTP callback + pane_dead polling)
 *   7. Git result check + evidence collection
 *   8. Report results + cleanup
 *
 * Prerequisites:
 *   - tmux running (you should be in a tmux session)
 *   - claude CLI installed and authenticated
 *   - pnpm build has been run
 *   - Target project repo has a clean git tree
 *
 * Usage:
 *   cd /path/to/flywheel
 *   pnpm build
 *   npx tsx scripts/run-issue.ts GEO-95 ~/Dev/GeoForge3D
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
	killTmuxSession,
	log,
	setupComponents,
	teardownComponents,
} from "./lib/setup.js";

// ── Hardcoded issue data (fallback when LINEAR_API_KEY is not set) ──

const KNOWN_ISSUES: Record<
	string,
	{
		title: string;
		description: string;
		labels?: string[];
		projectId?: string;
		identifier?: string;
	}
> = {
	"GEO-95": {
		title: "[P0] OSM attribution — add OpenStreetMap license notice in UI",
		description: `## Background

GeoForge3D uses OpenStreetMap data (ODbL license) and Mapbox (proprietary). Both require visible attribution.

* **ODbL**: Must credit "© OpenStreetMap contributors" in any product using OSM data
* **Mapbox**: Mapbox GL JS already shows attribution in map component, but verify it's visible

## Scope

1. Add OSM attribution in footer or map view (e.g., "Map data © OpenStreetMap contributors")
2. Verify Mapbox attribution is visible in SimplePreview component
3. Add attribution in About page (data sources section)
4. Consider: should the physical 3D printed product include attribution? (README.txt in artifact already exists — verify it has OSM credit)

## Acceptance Criteria

- [ ] OSM attribution visible on any page showing map data
- [ ] Mapbox attribution not hidden/removed
- [ ] About page mentions data sources
- [ ] README.txt in 3MF artifact includes OSM attribution

## Effort

Small (< 1 day)`,
	},
};

// ── Helpers ──────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * Find all independent git repos under a directory (immediate children with .git/).
 */
function discoverSubRepos(dir: string): string[] {
	const subRepos: string[] = [];
	try {
		for (const entry of readdirSync(dir)) {
			const childPath = join(dir, entry);
			try {
				if (
					statSync(childPath).isDirectory() &&
					existsSync(join(childPath, ".git"))
				) {
					subRepos.push(childPath);
				}
			} catch {
				/* skip inaccessible */
			}
		}
	} catch {
		/* dir not readable */
	}
	return subRepos;
}

/**
 * Check for new commits across multiple git repos.
 * Returns aggregated result.
 */
function checkSubRepoCommits(
	repos: string[],
	baselines: Map<string, string>,
): {
	totalCommits: number;
	allMessages: string[];
	totalFiles: number;
	repoResults: Array<{ repo: string; commits: number; messages: string[] }>;
} {
	let totalCommits = 0;
	let totalFiles = 0;
	const allMessages: string[] = [];
	const repoResults: Array<{
		repo: string;
		commits: number;
		messages: string[];
	}> = [];

	for (const repo of repos) {
		const baseSha = baselines.get(repo);
		if (!baseSha) continue;

		try {
			const count =
				parseInt(git(["rev-list", "--count", `${baseSha}..HEAD`], repo), 10) ||
				0;
			if (count > 0) {
				const messages = git(["log", "--format=%s", `${baseSha}..HEAD`], repo)
					.split("\n")
					.filter(Boolean);
				const diffStat = git(["diff", "--shortstat", `${baseSha}..HEAD`], repo);
				const filesMatch = diffStat.match(/(\d+)\s+files?\s+changed/);
				const files = filesMatch ? parseInt(filesMatch[1]!, 10) : 0;

				totalCommits += count;
				totalFiles += files;
				allMessages.push(...messages);
				repoResults.push({ repo, commits: count, messages });
			}
		} catch {
			/* skip repos that error */
		}
	}

	return { totalCommits, allMessages, totalFiles, repoResults };
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
	const [issueId, projectRoot] = process.argv.slice(2);

	if (!issueId || !projectRoot) {
		console.error(
			"Usage: npx tsx scripts/run-issue.ts <ISSUE-ID> <PROJECT-ROOT>",
		);
		console.error(
			"Example: npx tsx scripts/run-issue.ts GEO-95 ~/Dev/GeoForge3D",
		);
		process.exit(1);
	}

	const resolvedRoot = projectRoot.replace(/^~/, process.env.HOME ?? "");

	// FIX: Use issue-specific tmux session name to avoid prefix matching
	const tmuxSessionName = issueId;

	console.log("\n========================================");
	console.log(`  Flywheel — Run Issue: ${issueId}`);
	console.log(`  Project: ${resolvedRoot}`);
	console.log(`  Session: ${tmuxSessionName}`);
	console.log("========================================\n");

	// 1. Check prerequisites
	if (process.env.CLAUDECODE) {
		log(
			"WARNING: Running inside Claude Code session. TmuxRunner will unset CLAUDECODE in tmux env.",
		);
	}

	try {
		execFileSync("tmux", ["-V"], { encoding: "utf-8" });
		log(`tmux: ${execFileSync("tmux", ["-V"], { encoding: "utf-8" }).trim()}`);
	} catch {
		console.error("ERROR: tmux not found. Install with: brew install tmux");
		process.exit(1);
	}

	try {
		const ver = execFileSync("claude", ["--version"], {
			encoding: "utf-8",
		}).trim();
		log(`claude: ${ver}`);
	} catch {
		console.error("ERROR: claude CLI not found.");
		process.exit(1);
	}

	if (!existsSync(resolvedRoot)) {
		console.error(`ERROR: Project root does not exist: ${resolvedRoot}`);
		process.exit(1);
	}

	// 2. Verify clean tree (parent + sub-repos)
	const porcelain = git(["status", "--porcelain"], resolvedRoot);
	if (porcelain.length > 0) {
		console.error(`ERROR: Git working tree is not clean in ${resolvedRoot}`);
		console.error("Run: git stash  (or commit your changes)");
		console.error(porcelain.split("\n").slice(0, 5).join("\n"));
		process.exit(1);
	}

	// FIX: Discover and check sub-repos
	const subRepos = discoverSubRepos(resolvedRoot);
	if (subRepos.length > 0) {
		log(
			`Discovered ${subRepos.length} sub-repos: ${subRepos.map((r) => r.split("/").pop()).join(", ")}`,
		);
		for (const repo of subRepos) {
			const subPorcelain = git(["status", "--porcelain"], repo);
			if (subPorcelain.length > 0) {
				console.error(`ERROR: Sub-repo not clean: ${repo}`);
				console.error(subPorcelain.split("\n").slice(0, 3).join("\n"));
				process.exit(1);
			}
		}
	}
	log("Git tree: clean ✓");

	// 3. Resolve issue data
	const issueData = KNOWN_ISSUES[issueId];
	if (!issueData) {
		console.error(`ERROR: Issue ${issueId} not found in hardcoded data.`);
		console.error(
			`Add it to KNOWN_ISSUES in this script, or set LINEAR_API_KEY.`,
		);
		process.exit(1);
	}
	log(`Issue: ${issueId} — ${issueData.title}`);

	// 4. v0.2 components — shared setup
	const isSingleRepo = subRepos.length === 0;
	const projectName = resolvedRoot.split("/").pop() ?? "unknown";
	const components = await setupComponents({
		projectRoot: resolvedRoot,
		tmuxSessionName,
		projectName,
		enableWorktree: isSingleRepo,
		fetchIssue: async (id: string) => {
			const data = KNOWN_ISSUES[id];
			if (!data) throw new Error(`Unknown issue: ${id}`);
			return {
				title: data.title,
				description: data.description,
				labels: data.labels,
				projectId: data.projectId,
				identifier: data.identifier ?? id,
			};
		},
	});
	const { blueprint, slackNotifier, interactionServer, reactionsEngine } =
		components;

	// 5. Capture baselines for all repos (parent + sub-repos)
	const allRepos = [resolvedRoot, ...subRepos];
	const baselines = new Map<string, string>();
	for (const repo of allRepos) {
		try {
			const sha = git(["rev-parse", "HEAD"], repo);
			baselines.set(repo, sha);
			log(`Baseline ${repo.split("/").pop()}: ${sha.slice(0, 8)}`);
		} catch {
			/* repo might not have commits */
		}
	}

	// 7. Auto-open Terminal viewer and bring to front
	// Use exact session match (=sessionName) to avoid tmux prefix matching
	log("\n--- Opening tmux viewer ---");
	execFileSync("osascript", [
		"-e",
		[
			'tell application "Terminal"',
			`  do script "echo 'Waiting for Flywheel session ${tmuxSessionName}...' && while ! tmux has-session -t '=${tmuxSessionName}' 2>/dev/null; do sleep 1; done && tmux attach -t '=${tmuxSessionName}'; exit"`,
			"  activate",
			"end tell",
		].join("\n"),
	]);
	log("Viewer window opened — it will connect once Claude starts");

	// 8. Auto-interaction: handle trust prompt + detect completion
	// Session naming: tmux session = issueId, window = buildWindowLabel() output.
	let trustConfirmed = false;
	// Label format from Blueprint.buildWindowLabel: "{runner}:{cleanTitle}"
	// Must match TmuxRunner.sanitizeWindowName: [^a-zA-Z0-9-] → "-", max 50 chars
	const cleanTitle = issueData.title
		.replace(/\[P\d+\]\s*/gi, "")
		.replace(/\s*—\s*/g, "-")
		.trim();
	const windowLabel = `claude-${cleanTitle}`
		.replace(/[^a-zA-Z0-9-]/g, "-")
		.slice(0, 50);
	const tmuxTarget = `${tmuxSessionName}:${windowLabel}`;

	const autoInteractInterval = setInterval(() => {
		try {
			const paneContent = execFileSync(
				"tmux",
				["capture-pane", "-t", tmuxTarget, "-p"],
				{ encoding: "utf-8" },
			);

			// Auto-confirm trust prompt
			if (
				!trustConfirmed &&
				(paneContent.includes("trust this folder") ||
					paneContent.includes("Enter to confirm"))
			) {
				execFileSync("tmux", ["send-keys", "-t", tmuxTarget, "Enter"]);
				log("Auto-confirmed workspace trust prompt");
				trustConfirmed = true;
			}

			// NOTE: PR/push detection + kill-pane removed in v0.6.
			// Session termination is now handled by TmuxRunner sentinel
			// (detects .flywheel/runs/<executionId>/land-status.json)
			// or pane_dead (agent exits naturally after landing).
		} catch {
			/* window may not exist yet */
		}
	}, 5000);

	// 9. Run Blueprint
	log("\n--- Launching Blueprint ---");
	log(`Claude Code will open in tmux window: ${windowLabel}`);
	log("Watch it work in the Terminal viewer!\n");

	const startTime = Date.now();
	const node = { id: issueId, blockedBy: [] };
	const executionId = randomUUID();
	const ctx = {
		teamName: "eng",
		runnerName: "claude",
		projectName,
		sessionTimeoutMs: 2_700_000, // 45 min — land skill needs time for CI/review/merge
		executionId,
	};

	let actualSuccess = false;
	let preserveSession = false;
	try {
		const blueprintResult = await blueprint.run(node, resolvedRoot, ctx);
		clearInterval(autoInteractInterval);
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

		// Decision route determines if tmux session should survive for inspection
		const route = blueprintResult.decision?.route;
		if (route === "needs_review" || route === "blocked") {
			preserveSession = true;
		}

		// 10. FIX: Check sub-repos for commits (Blueprint only checks parent repo)
		actualSuccess = blueprintResult.success;
		const subRepoCheck = checkSubRepoCommits(allRepos, baselines);

		if (!actualSuccess && subRepoCheck.totalCommits > 0) {
			log(
				`Blueprint reported no commits in parent repo, but found ${subRepoCheck.totalCommits} commits in sub-repos`,
			);
			actualSuccess = true;
		}

		// 11. Report
		console.log("\n--- Blueprint Result ---\n");
		console.log(
			`  success:      ${actualSuccess}${!blueprintResult.success && actualSuccess ? " (overridden by sub-repo check)" : ""}`,
		);
		console.log(`  sessionId:    ${blueprintResult.sessionId ?? "(none)"}`);
		console.log(`  durationMs:   ${blueprintResult.durationMs}`);
		console.log(`  elapsed:      ${elapsed}s`);
		console.log(`  error:        ${blueprintResult.error ?? "(none)"}`);
		console.log(
			`  worktreePath: ${blueprintResult.worktreePath ?? "(none — v0.1.1 mode)"}`,
		);

		if (blueprintResult.evidence) {
			const ev = blueprintResult.evidence;
			console.log("\n--- Execution Evidence ---\n");
			console.log(`  commits:      ${ev.commitCount}`);
			console.log(`  filesChanged: ${ev.filesChangedCount}`);
			console.log(`  linesAdded:   ${ev.linesAdded}`);
			console.log(`  linesRemoved: ${ev.linesRemoved}`);
			console.log(`  headSha:      ${ev.headSha ?? "(unknown)"}`);
			console.log(`  partial:      ${ev.partial}`);
			if (ev.commitMessages.length > 0) {
				console.log("  commits:");
				for (const msg of ev.commitMessages) {
					console.log(`    - ${msg}`);
				}
			}
		}

		if (blueprintResult.decision) {
			const d = blueprintResult.decision;
			console.log("\n--- Decision Layer ---\n");
			console.log(`  route:        ${d.route}`);
			console.log(`  confidence:   ${d.confidence}`);
			console.log(`  source:       ${d.decisionSource}`);
			console.log(`  reasoning:    ${d.reasoning}`);
			if (d.concerns && d.concerns.length > 0) {
				console.log("  concerns:");
				for (const c of d.concerns) {
					console.log(`    - ${c}`);
				}
			}
			if (d.hardRuleId) {
				console.log(`  hardRuleId:   ${d.hardRuleId}`);
			}
			if (d.verification) {
				console.log(
					`  verification: ${d.verification.approved ? "approved" : "rejected"} (confidence: ${d.verification.confidence})`,
				);
			}
		}

		// 11b. Slack notification + CEO reaction (v0.2 Step 2c)
		if (slackNotifier && blueprintResult.decision) {
			try {
				const notifyResult = await slackNotifier.notify(
					{
						issueId,
						issueIdentifier: issueData.identifier ?? issueId,
						issueTitle: issueData.title,
						labels: issueData.labels ?? [],
						projectId: issueData.projectId ?? projectName,
						exitReason:
							blueprintResult.decision.route === "blocked"
								? "error"
								: "completed",
						baseSha: baselines.get(resolvedRoot) ?? "",
						commitCount: blueprintResult.evidence?.commitCount ?? 0,
						commitMessages: blueprintResult.evidence?.commitMessages ?? [],
						changedFilePaths: blueprintResult.evidence?.changedFilePaths ?? [],
						filesChangedCount: blueprintResult.evidence?.filesChangedCount ?? 0,
						linesAdded: blueprintResult.evidence?.linesAdded ?? 0,
						linesRemoved: blueprintResult.evidence?.linesRemoved ?? 0,
						diffSummary: blueprintResult.evidence?.diffSummary ?? "",
						headSha: blueprintResult.evidence?.headSha ?? null,
						durationMs: blueprintResult.durationMs ?? 0,
						consecutiveFailures: 0,
						partial: blueprintResult.evidence?.partial ?? false,
					},
					blueprintResult.decision,
					{ tmuxSession: tmuxSessionName },
				);

				if (notifyResult.sent) {
					log(`Slack notification sent (route: ${route})`);

					if (interactionServer && reactionsEngine) {
						log("Waiting for CEO response (timeout: 1h)...");
						const action = await interactionServer.waitForAction(
							issueId,
							3_600_000,
						);

						if (action) {
							const actionResult = await reactionsEngine.dispatch(action);
							log(
								`Action executed: ${action.action} → ${actionResult.message}`,
							);
						} else {
							log(
								"No CEO response within timeout — issue preserved for manual review",
							);
						}
					}
				}
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log(`Slack notification failed (non-fatal): ${errMsg}`);
			}
		}

		if (subRepoCheck.repoResults.length > 0) {
			console.log("\n--- Sub-Repo Commits ---\n");
			for (const r of subRepoCheck.repoResults) {
				console.log(`  ${r.repo.split("/").pop()}: ${r.commits} commits`);
				for (const msg of r.messages) {
					console.log(`    - ${msg}`);
				}
			}
		}

		// 12. Show git state
		for (const repo of allRepos) {
			const repoName = repo.split("/").pop();
			try {
				console.log(`\n--- ${repoName} branches ---`);
				console.log(
					git(["branch", "--sort=-committerdate"], repo)
						.split("\n")
						.slice(0, 5)
						.join("\n"),
				);
			} catch {
				/* skip */
			}
		}

		// 13. Verdict
		console.log("\n========================================");
		if (actualSuccess) {
			console.log(`  ✅ PASS — ${issueId} completed successfully!`);
			console.log(
				`  Commits: ${subRepoCheck.totalCommits} across ${subRepoCheck.repoResults.length} repo(s)`,
			);
		} else if (blueprintResult.error) {
			console.log(`  ❌ FAIL — Error: ${blueprintResult.error}`);
		} else {
			console.log(`  ❌ FAIL — No commits detected in any repo`);
		}
		console.log("========================================\n");
	} catch (err) {
		console.error("\nBlueprint error:", err);
	} finally {
		// 14. Cleanup
		clearInterval(autoInteractInterval);
		await teardownComponents(components);
		if (preserveSession) {
			log(
				`Preserving tmux session '${tmuxSessionName}' for inspection (route: needs_review/blocked)`,
			);
		} else {
			killTmuxSession(tmuxSessionName);
		}
	}

	process.exit(actualSuccess ? 0 : 1);
}

main().catch((err) => {
	console.error("Script crashed:", err);
	process.exit(1);
});
