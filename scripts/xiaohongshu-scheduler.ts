/**
 * FLY-222: thin scheduled-learning scheduler ENTRY (run via `npx tsx`).
 *
 * ⚠️ DRAFT — write-only, NOT yet wired into launchd. Verified end-to-end against
 * a real Bridge + the Flywheel Sandbox Linear project during A0-A10 (the runbook
 * at doc/engineer/implementation/FLY-222-a0-a10-runbook.md). Do NOT run against a
 * production Bridge or spawn real Runners outside that window.
 *
 * Wires the real deps around the unit-tested decision core
 * (planLearningRuns + executeLearningPlan, packages/teamlead/src/
 * xiaohongshu-scheduler.ts):
 *   - loadProjects() (~/.flywheel/projects.json) + per-project ConfigLoader →
 *     enumerate enabled xiaohongshu_learning collections
 *   - readState (state helper) for due-ness
 *   - createTriggerIssue: resolve the dept-label name→id via @linear/sdk and
 *     create-if-absent the fixed trigger issue (a trusted local process holds
 *     LINEAR_API_KEY — plan §2.5 "direct Linear API" branch)
 *   - startRun: POST the Bridge /api/runs/start with TEAMLEAD_API_TOKEN
 *
 * Lease model = option A (Codex-blessed, plan §8): the Runner self-holds the
 * lease; this scheduler relies on the FLY-176 lockdir (shell wrapper) + the 409
 * active-session guard + the Runner lease + Runner-set-next-due.
 *
 * A0-A10 VERIFY (highest-risk-to-confirm, draft assumptions):
 *   - exact @linear/sdk shapes: `client.teams()`, `client.issueLabels({filter:
 *     {team:{id:{eq}}}})`, `client.createIssue({teamId,labelIds,description})`
 *     and `(await created.issue).id` — confirm against the installed SDK version;
 *   - `config.linear.team_id` is a resolvable team id OR key (resolveTeamId
 *     tries both);
 *   - the trigger-issue body YAML is what the skill reads for run params.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LinearClient } from "@linear/sdk";
// Workspace packages are imported by RELATIVE dist path (matching
// scripts/run-bridge.ts) — bare names like "flywheel-config" do not resolve via
// `npx tsx` from scripts/ (not symlinked into the root node_modules).
import { ConfigLoader, type FlywheelConfig } from "../packages/config/dist/index.js";
import {
	defaultStateDir,
	readState,
} from "../packages/flywheel-comm/dist/xiaohongshu-state.js";
import { loadProjects } from "../packages/teamlead/dist/ProjectConfig.js";
import {
	type CollectionRunPlan,
	executeLearningPlan,
	planLearningRuns,
	type StartRunResult,
} from "../packages/teamlead/dist/xiaohongshu-scheduler.js";

// Accept BRIDGE_URL or FLYWHEEL_BRIDGE_URL (the latter is what most Flywheel
// components + the QA slots use); fall back to the default Bridge port.
const BRIDGE_URL = (
	process.env.BRIDGE_URL ??
	process.env.FLYWHEEL_BRIDGE_URL ??
	"http://localhost:9876"
).replace(/\/+$/, "");
const API_TOKEN = process.env.TEAMLEAD_API_TOKEN;
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;

function log(msg: string): void {
	console.log(`[xhs-scheduler ${new Date().toISOString()}] ${msg}`);
}
function alert(msg: string): void {
	console.error(`[xhs-scheduler ALERT] ${msg}`);
}

/** Pre-load every project's .flywheel/config.yaml (async) into a sync-readable map. */
async function loadProjectConfigs(
	projects: ReturnType<typeof loadProjects>,
): Promise<Map<string, FlywheelConfig | null>> {
	const map = new Map<string, FlywheelConfig | null>();
	for (const project of projects) {
		const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
		try {
			const loader = new ConfigLoader(async (p) => readFile(p, "utf-8"));
			map.set(project.projectName, await loader.load(configPath));
		} catch (err) {
			// Missing/invalid config → treat as "no learning config" (planner skips).
			log(
				`no usable config for ${project.projectName}: ${(err as Error).message}`,
			);
			map.set(project.projectName, null);
		}
	}
	return map;
}

async function main(): Promise<void> {
	if (!API_TOKEN) {
		alert("TEAMLEAD_API_TOKEN is required");
		process.exit(1);
	}
	if (!LINEAR_API_KEY) {
		alert("LINEAR_API_KEY is required");
		process.exit(1);
	}

	const projects = loadProjects();
	const configMap = await loadProjectConfigs(projects);
	const linear = new LinearClient({ apiKey: LINEAR_API_KEY });
	const stateDir = defaultStateDir();

	const decisions = planLearningRuns({
		projects,
		loadProjectConfig: (name) => configMap.get(name) ?? null,
		readState,
		now: () => new Date(),
	});

	// Resolve a project's Linear team (by key OR id) once, cached.
	const teamIdCache = new Map<string, string>();
	async function resolveTeamId(projectName: string): Promise<string> {
		const cached = teamIdCache.get(projectName);
		if (cached) return cached;
		const cfgTeam = configMap.get(projectName)?.linear?.team_id;
		if (!cfgTeam) {
			throw new Error(`project ${projectName} config has no linear.team_id`);
		}
		const teams = await linear.teams();
		const match =
			teams.nodes.find((t) => t.id === cfgTeam) ??
			teams.nodes.find((t) => t.key === cfgTeam);
		if (!match) {
			throw new Error(
				`Linear team "${cfgTeam}" (project ${projectName}) not found`,
			);
		}
		teamIdCache.set(projectName, match.id);
		return match.id;
	}

	// Strict target-project resolution: the control issue MUST land in the named
	// project. A silent team-only fallback would misplace it and violate the
	// routing contract — so a miss/ambiguity throws and the executor skips +
	// alerts this one collection (the others still run).
	async function resolveTargetProjectId(name: string): Promise<string> {
		const projs = await linear.projects({ filter: { name: { eq: name } } });
		const nodes = projs.nodes;
		if (nodes.length === 0) {
			throw new Error(`target_linear_project "${name}" not found in Linear`);
		}
		if (nodes.length > 1) {
			throw new Error(
				`target_linear_project "${name}" is ambiguous (${nodes.length} matches)`,
			);
		}
		const only = nodes[0];
		if (!only?.id) throw new Error(`target_linear_project "${name}" has no id`);
		return only.id;
	}

	async function createTriggerIssue(plan: CollectionRunPlan): Promise<string> {
		const teamId = await resolveTeamId(plan.project);
		// Stable dedup key built from IMMUTABLE fields (project + collection_id),
		// NOT the mutable label. createTriggerIssue is find-or-create: if a crash
		// happened between a prior create and the local triggerIssueId persist, the
		// next tick FINDS this issue by title and reuses it — no duplicate trigger.
		const stableTitle = `[xhs-learning] ${plan.project} / ${plan.collectionId}`;
		const existing = await linear.issues({
			filter: { team: { id: { eq: teamId } }, title: { eq: stableTitle } },
		});
		const found = existing.nodes[0];
		if (found?.id) return found.id;

		// dept-label name → id (case-insensitive) within the team
		const labels = await linear.issueLabels({
			filter: { team: { id: { eq: teamId } } },
		});
		const want = plan.departmentLabel.trim().toLowerCase();
		const labelMatch = labels.nodes.find(
			(l) => l.name.trim().toLowerCase() === want,
		);
		if (!labelMatch) {
			throw new Error(
				`dept label "${plan.departmentLabel}" not found in Linear team for ${plan.project}`,
			);
		}
		// Place the trigger (control) issue in the SAME Linear project as the
		// outputs (target_linear_project) — strict (see resolveTargetProjectId).
		const projectId = await resolveTargetProjectId(plan.targetLinearProject);
		// The trigger issue body carries the run params the skill reads.
		const description = [
			"FLY-222 scheduled-learning trigger issue (auto-created; reused every tick).",
			"",
			"```yaml",
			`xiaohongshu_learning_run:`,
			`  project: ${plan.project}`,
			`  collection_id: ${plan.collectionId}`,
			`  collection_label: ${plan.collectionLabel}`,
			`  lead_id: ${plan.leadId}`,
			`  target_linear_project: ${plan.targetLinearProject}`,
			`  cadence: ${plan.cadence}`,
			`  max_fetch: ${plan.maxFetch}`,
			`  video_opt_in: ${plan.videoOptIn}`,
			"```",
		].join("\n");
		const created = await linear.createIssue({
			teamId,
			title: stableTitle,
			description,
			labelIds: [labelMatch.id],
			projectId,
		});
		const issue = await created.issue;
		if (!issue?.id) {
			throw new Error(`createIssue returned no issue for ${plan.collectionId}`);
		}
		return issue.id;
	}

	async function startRun(args: {
		issueId: string;
		projectName: string;
		leadId: string;
	}): Promise<StartRunResult> {
		const res = await fetch(`${BRIDGE_URL}/api/runs/start`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${API_TOKEN}`,
			},
			body: JSON.stringify({
				issueId: args.issueId,
				projectName: args.projectName,
				leadId: args.leadId,
			}),
		});
		if (res.ok) {
			const body = (await res.json()) as { executionId?: string };
			return { ok: true, executionId: body.executionId ?? "(unknown)" };
		}
		let message = `HTTP ${res.status}`;
		try {
			const body = (await res.json()) as { message?: string };
			if (body.message) message = body.message;
		} catch {
			/* non-JSON body */
		}
		return { ok: false, status: res.status, message };
	}

	const report = await executeLearningPlan(decisions, {
		stateDir,
		createTriggerIssue,
		startRun,
		log,
		alert,
	});

	log(
		`done — spawned=${report.spawned.length} skipped=${report.skipped.length} errors=${report.errors.length}`,
	);
	if (report.errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
	alert(`fatal: ${(err as Error).stack ?? err}`);
	process.exit(1);
});
