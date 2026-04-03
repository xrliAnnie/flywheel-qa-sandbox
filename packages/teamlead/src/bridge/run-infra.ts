/**
 * FLY-22: Run infrastructure setup — creates per-project Blueprint + RunDispatcher.
 *
 * Simplified version of scripts/lib/retry-runtime.ts + setup.ts that lives
 * inside the teamlead package so startBridge can create the RunDispatcher
 * internally when one is not injected via opts.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnthropicLLMClient, TmuxAdapter } from "flywheel-claude-runner";
import type { LLMClient } from "flywheel-core";
import { sanitizeTmuxName } from "flywheel-core";
import {
	AuditLogger,
	DecisionLayer,
	defaultRules,
	ExecutionEvidenceCollector,
	FallbackHeuristic,
	GitResultChecker,
	HaikuTriageAgent,
	HaikuVerifier,
	HardRuleEngine,
	HookCallbackServer,
	SkillInjector,
} from "flywheel-edge-worker";
import { Blueprint } from "flywheel-edge-worker/dist/Blueprint.js";
import { PreHydrator } from "flywheel-edge-worker/dist/PreHydrator.js";
import { DirectEventSink } from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { EventFilter } from "./EventFilter.js";
import { ForumPostCreator } from "./ForumPostCreator.js";
import { ForumTagUpdater } from "./ForumTagUpdater.js";
import { type ProjectRuntime, RunDispatcher } from "./run-dispatcher.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import type { BridgeConfig } from "./types.js";

/** Build a fetchIssue function that tries Linear API, falls back to StateStore. */
function createFetchIssue(store: StateStore) {
	return async (id: string) => {
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

		if (!accessToken) {
			console.warn(
				"[RunInfra] LINEAR_API_KEY not set — run will lack labels/projectId",
			);
		}
		const session = store.getSessionByIssue(id);
		return {
			title: session?.issue_title ?? `Issue ${id}`,
			description: session?.summary ?? `Execution for issue ${id}`,
			identifier: session?.issue_identifier ?? id,
		};
	};
}

/** Create a minimal Blueprint for running issues (no Slack, no CIPHER, no AgentDispatcher). */
async function createRunBlueprint(
	tmuxSessionName: string,
	fetchIssue: ReturnType<typeof createFetchIssue>,
	eventEmitter: DirectEventSink,
	sessionTimeoutMs: number = 14_400_000, // 4h (same as retry runtime)
): Promise<{ blueprint: Blueprint; cleanup: () => Promise<void> }> {
	const hookServer = new HookCallbackServer(0);
	await hookServer.start();

	const flywheelDir = join(homedir(), ".flywheel");
	mkdirSync(flywheelDir, { recursive: true });

	const auditLogger = new AuditLogger(join(flywheelDir, "audit.db"));
	await auditLogger.init();

	const execFn = async (cmd: string, args: string[], cwd: string) => {
		const result = execFileSync(cmd, args, { cwd, encoding: "utf-8" });
		return { stdout: result };
	};

	const evidenceCollector = new ExecutionEvidenceCollector(execFn);
	const skillInjector = new SkillInjector();

	// DecisionLayer — with or without LLM
	const hardRules = new HardRuleEngine(defaultRules());
	const fallback = new FallbackHeuristic();
	let triage: HaikuTriageAgent;
	let verifier: HaikuVerifier;
	if (process.env.ANTHROPIC_API_KEY) {
		const llmClient = new AnthropicLLMClient();
		triage = new HaikuTriageAgent(llmClient, "claude-haiku-4-5-20251001", 2000);
		verifier = new HaikuVerifier(llmClient, "claude-haiku-4-5-20251001");
	} else {
		const noLlm: LLMClient = {
			chat: () => {
				throw new Error("No ANTHROPIC_API_KEY");
			},
		};
		triage = new HaikuTriageAgent(noLlm, "", 0);
		verifier = new HaikuVerifier(noLlm, "");
	}

	const decisionLayer = new DecisionLayer(
		hardRules,
		triage,
		verifier,
		fallback,
		auditLogger,
		evidenceCollector,
	);

	const hydrator = new PreHydrator(fetchIssue);
	const gitChecker = new GitResultChecker(execFn);
	const makeAdapter = (_name: string) =>
		new TmuxAdapter(
			tmuxSessionName,
			undefined,
			5000,
			sessionTimeoutMs,
			hookServer,
		);
	const shell = {
		execFile: async (cmd: string, args: string[], cwd: string) => {
			try {
				const stdout = execFileSync(cmd, args, { cwd, encoding: "utf-8" });
				return { stdout, exitCode: 0 };
			} catch (e: unknown) {
				const err = e as { stdout?: string; status?: number };
				return { stdout: err.stdout ?? "", exitCode: err.status ?? 1 };
			}
		},
	};

	const blueprint = new Blueprint(
		hydrator,
		gitChecker,
		makeAdapter,
		shell,
		undefined, // worktreeManager — not needed for start API
		skillInjector,
		evidenceCollector,
		undefined, // skillsConfig
		decisionLayer,
		eventEmitter,
		undefined, // agentDispatcher
	);

	const cleanup = async () => {
		await hookServer.stop();
		await auditLogger.close();
	};

	return { blueprint, cleanup };
}

/**
 * Set up per-project Blueprint runtimes and return a RunDispatcher.
 *
 * Called by startBridge when no external startDispatcher is provided.
 */
export async function setupRunInfrastructure(
	store: StateStore,
	config: BridgeConfig,
	projects: ProjectEntry[],
	registry?: RuntimeRegistry,
): Promise<RunDispatcher> {
	const projectRuntimes = new Map<string, ProjectRuntime>();
	const cleanupHandles: Array<() => Promise<void>> = [];

	const fetchIssue = createFetchIssue(store);

	for (const project of projects) {
		try {
			const tmuxSessionName = sanitizeTmuxName(`runner-${project.projectName}`);

			const eventFilter = new EventFilter();
			const statusTagMap = config.statusTagMap ?? {};
			const forumTagUpdater = new ForumTagUpdater(statusTagMap);
			// FLY-24: ForumPostCreator so DirectEventSink can create Forum Posts on session_started
			const forumPostCreator = new ForumPostCreator(store, statusTagMap);
			const directSink = new DirectEventSink(
				store,
				config,
				projects,
				eventFilter,
				forumTagUpdater,
				registry,
				forumPostCreator,
			);

			const { blueprint, cleanup } = await createRunBlueprint(
				tmuxSessionName,
				fetchIssue,
				directSink,
			);

			projectRuntimes.set(project.projectName, {
				blueprint,
				projectRoot: project.projectRoot,
				tmuxSessionName,
			});
			cleanupHandles.push(cleanup);

			console.log(`[RunInfra] ${project.projectName} ready`);
		} catch (err) {
			console.error(
				`[RunInfra] Failed to setup ${project.projectName}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	if (projectRuntimes.size === 0) {
		console.warn(
			"[RunInfra] No project runtimes initialized — start/retry will be unavailable",
		);
	} else {
		console.log(
			`[RunInfra] ${projectRuntimes.size}/${projects.length} project(s) ready (maxConcurrent: ${config.maxConcurrentRunners})`,
		);
	}

	return new RunDispatcher(
		projectRuntimes,
		cleanupHandles,
		config.maxConcurrentRunners,
	);
}
