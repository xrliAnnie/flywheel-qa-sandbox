/**
 * Shared component initialization for Flywheel entry-point scripts.
 * Used by run-issue.ts and run-project.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { TmuxRunner } from "../../packages/claude-runner/dist/TmuxRunner.js";
import { AnthropicLLMClient } from "../../packages/claude-runner/dist/AnthropicLLMClient.js";
import { GitResultChecker } from "../../packages/edge-worker/dist/GitResultChecker.js";
import { Blueprint } from "../../packages/edge-worker/dist/Blueprint.js";
import { PreHydrator } from "../../packages/edge-worker/dist/PreHydrator.js";
import { HookCallbackServer } from "../../packages/edge-worker/dist/HookCallbackServer.js";
import { WorktreeManager } from "../../packages/edge-worker/dist/WorktreeManager.js";
import { SkillInjector } from "../../packages/edge-worker/dist/SkillInjector.js";
import { ExecutionEvidenceCollector } from "../../packages/edge-worker/dist/ExecutionEvidenceCollector.js";
import { AuditLogger } from "../../packages/edge-worker/dist/AuditLogger.js";
import { SlackNotifier } from "../../packages/edge-worker/dist/SlackNotifier.js";
import { SlackInteractionServer } from "../../packages/edge-worker/dist/SlackInteractionServer.js";
import { ReactionsEngine } from "../../packages/edge-worker/dist/ReactionsEngine.js";
import { ApproveHandler } from "../../packages/edge-worker/dist/reactions/ApproveHandler.js";
import { RejectHandler } from "../../packages/edge-worker/dist/reactions/RejectHandler.js";
import { DeferHandler } from "../../packages/edge-worker/dist/reactions/DeferHandler.js";
import { postSlackResponse } from "../../packages/edge-worker/dist/reactions/postSlackResponse.js";
import { SlackMessageService } from "../../packages/slack-event-transport/dist/SlackMessageService.js";
import {
	DecisionLayer,
	HardRuleEngine,
	HaikuTriageAgent,
	HaikuVerifier,
	FallbackHeuristic,
	defaultRules,
} from "../../packages/edge-worker/dist/decision/index.js";
import type { LLMClient } from "../../packages/core/dist/llm-client-types.js";
import { TeamLeadClient, NoOpEventEmitter } from "../../packages/edge-worker/dist/ExecutionEventEmitter.js";
import type { ExecutionEventEmitter } from "../../packages/edge-worker/dist/ExecutionEventEmitter.js";

// Re-export for convenience
export { Blueprint } from "../../packages/edge-worker/dist/Blueprint.js";
export { DagDispatcher } from "../../packages/edge-worker/dist/DagDispatcher.js";
export type { DispatchResult } from "../../packages/edge-worker/dist/DagDispatcher.js";
export type { BlueprintResult, BlueprintContext } from "../../packages/edge-worker/dist/Blueprint.js";

export interface FlywheelComponents {
	hookServer: HookCallbackServer;
	worktreeManager?: WorktreeManager;
	skillInjector: SkillInjector;
	evidenceCollector: ExecutionEvidenceCollector;
	auditLogger: AuditLogger;
	decisionLayer: DecisionLayer;
	blueprint: Blueprint;
	slackNotifier?: SlackNotifier;
	interactionServer?: SlackInteractionServer;
	reactionsEngine?: ReactionsEngine;
	eventEmitter: ExecutionEventEmitter;
}

export interface SetupOptions {
	projectRoot: string;
	tmuxSessionName: string;
	projectName: string;
	projectRepo?: string;
	/** If false, skip worktree manager (e.g., multi-repo projects) */
	enableWorktree?: boolean;
	/** Custom issue fetcher for PreHydrator */
	fetchIssue: (id: string) => Promise<{
		title: string;
		description: string;
		labels?: string[];
		projectId?: string;
		identifier?: string;
	}>;
	/** Session timeout in ms (default: 2_700_000 = 45 min) */
	sessionTimeoutMs?: number;
}

export function log(msg: string) {
	const time = new Date().toLocaleTimeString();
	console.log(`[${time}] ${msg}`);
}

export function killTmuxSession(sessionName: string): void {
	try {
		execFileSync("tmux", ["kill-session", "-t", `=${sessionName}`]);
		log(`Cleaned up tmux session: ${sessionName}`);
	} catch { /* session may already be gone */ }
}

export async function setupComponents(opts: SetupOptions): Promise<FlywheelComponents> {
	const {
		projectRoot,
		tmuxSessionName,
		projectName,
		projectRepo,
		enableWorktree = true,
		fetchIssue,
		sessionTimeoutMs = 2_700_000,
	} = opts;

	// Fail-fast: TEAMLEAD_OWNS_SLACK=true requires TEAMLEAD_URL
	const teamleadUrl = process.env.TEAMLEAD_URL;
	const teamleadOwnsSlack = process.env.TEAMLEAD_OWNS_SLACK === "true";
	if (teamleadOwnsSlack && !teamleadUrl) {
		throw new Error(
			"TEAMLEAD_OWNS_SLACK=true requires TEAMLEAD_URL. Otherwise no notification path is active.",
		);
	}

	// HookCallbackServer
	const hookServer = new HookCallbackServer(0);
	await hookServer.start();
	log(`HookCallbackServer started on port ${hookServer.getPort()}`);

	// WorktreeManager
	const worktreeManager = enableWorktree ? new WorktreeManager() : undefined;
	if (!enableWorktree) {
		log("Worktree disabled");
	}

	const skillInjector = new SkillInjector();

	const execFn = async (cmd: string, args: string[], cwd: string) => {
		const result = execFileSync(cmd, args, { cwd, encoding: "utf-8" });
		return { stdout: result };
	};

	const evidenceCollector = new ExecutionEvidenceCollector(execFn);

	// AuditLogger
	const flywheelDir = join(homedir(), ".flywheel");
	mkdirSync(flywheelDir, { recursive: true });
	const auditLogger = new AuditLogger(join(flywheelDir, "audit.db"));
	await auditLogger.init();
	log("AuditLogger initialized");

	// Decision Layer
	const hardRules = new HardRuleEngine(defaultRules());
	const fallback = new FallbackHeuristic();

	let triage: HaikuTriageAgent;
	let verifier: HaikuVerifier;
	if (process.env.ANTHROPIC_API_KEY) {
		const llmClient = new AnthropicLLMClient();
		triage = new HaikuTriageAgent(llmClient, "claude-haiku-4-5-20251001", 2000);
		verifier = new HaikuVerifier(llmClient, "claude-haiku-4-5-20251001");
		log("Decision Layer: LLM triage + verify enabled");
	} else {
		log("ANTHROPIC_API_KEY not set — LLM triage/verify disabled");
		const noLlm: LLMClient = { chat: () => { throw new Error("No ANTHROPIC_API_KEY"); } };
		triage = new HaikuTriageAgent(noLlm, "", 0);
		verifier = new HaikuVerifier(noLlm, "");
	}

	const decisionLayer = new DecisionLayer(
		hardRules, triage, verifier, fallback, auditLogger, evidenceCollector,
	);

	// EventEmitter — TeamLead pipeline
	const teamleadToken = process.env.TEAMLEAD_INGEST_TOKEN;
	const eventEmitter: ExecutionEventEmitter = teamleadUrl
		? new TeamLeadClient(teamleadUrl, teamleadToken)
		: new NoOpEventEmitter();
	if (teamleadUrl) log(`TeamLead events → ${teamleadUrl}`);

	// Slack notification — conditional (skipped when TEAMLEAD_OWNS_SLACK)
	let slackNotifier: SlackNotifier | undefined;
	let interactionServer: SlackInteractionServer | undefined;
	let reactionsEngine: ReactionsEngine | undefined;

	const slackChannel = process.env.FLYWHEEL_SLACK_CHANNEL;
	const slackToken = process.env.SLACK_BOT_TOKEN;
	const repo = projectRepo ?? process.env.FLYWHEEL_PROJECT_REPO;

	if (teamleadOwnsSlack) {
		log("TEAMLEAD_OWNS_SLACK=true — legacy Slack path disabled");
	} else if (slackToken && slackChannel) {
		const msgService = new SlackMessageService();
		slackNotifier = new SlackNotifier(
			{ channelId: slackChannel, botToken: slackToken, projectRepo: repo },
			msgService,
		);

		interactionServer = new SlackInteractionServer(
			parseInt(process.env.FLYWHEEL_INTERACTION_PORT ?? "9877"),
			process.env.SLACK_INTERACTION_TOKEN,
		);
		await interactionServer.start();
		log(`SlackInteractionServer started on port ${interactionServer.getPort()}`);

		const stubHandler = {
			async execute(action: { issueId: string; action: string; responseUrl: string; userId: string }) {
				const msg = `Action '${action.action}' for ${action.issueId} acknowledged — not yet implemented (v0.2.1+)`;
				await postSlackResponse(action.responseUrl, msg);
				return { success: true, message: msg };
			},
		};

		reactionsEngine = new ReactionsEngine({
			approve: new ApproveHandler(execFn, projectRoot, repo),
			reject: new RejectHandler(),
			defer: new DeferHandler(),
			retry: stubHandler,
			shelve: stubHandler,
		});
		log("Slack notification + reactions enabled");
	} else {
		log("SLACK_BOT_TOKEN not set — Slack notifications disabled");
	}

	// Hydrator
	const hydrator = new PreHydrator(fetchIssue);

	// Git checker
	const gitChecker = new GitResultChecker(execFn);

	// Runner factory
	const makeRunner = (_name: string) =>
		new TmuxRunner(
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
			} catch (e: any) {
				return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
			}
		},
	};

	const blueprint = new Blueprint(
		hydrator, gitChecker, makeRunner, shell,
		worktreeManager, skillInjector, evidenceCollector,
		undefined, // skillsConfig
		decisionLayer,
		eventEmitter,
	);

	return {
		hookServer,
		worktreeManager,
		skillInjector,
		evidenceCollector,
		auditLogger,
		decisionLayer,
		blueprint,
		slackNotifier,
		interactionServer,
		reactionsEngine,
		eventEmitter,
	};
}

export async function teardownComponents(c: FlywheelComponents): Promise<void> {
	await c.eventEmitter.flush();
	await c.hookServer.stop();
	log("HookCallbackServer stopped");
	if (c.interactionServer) {
		await c.interactionServer.stop();
		log("SlackInteractionServer stopped");
	}
	await c.auditLogger.close();
	log("AuditLogger closed");
}
