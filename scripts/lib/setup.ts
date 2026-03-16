/**
 * Shared component initialization for Flywheel entry-point scripts.
 * Used by run-issue.ts and run-project.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { TmuxAdapter } from "../../packages/claude-runner/dist/TmuxAdapter.js";
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
import { ConfigLoader } from "../../packages/config/dist/ConfigLoader.js";
import { AgentDispatcher } from "../../packages/edge-worker/dist/AgentDispatcher.js";
import { createMemoryService } from "../../packages/edge-worker/dist/memory/index.js";
import { CipherReader } from "../../packages/edge-worker/dist/cipher/CipherReader.js";
import type { FlywheelConfig } from "../../packages/config/dist/types.js";
import type { ClassifyFn } from "../../packages/edge-worker/dist/AgentDispatcher.js";

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
	/** GEO-168: Override default event emitter (e.g., DirectEventSink for bridge-local retries) */
	eventEmitterOverride?: ExecutionEventEmitter;
	/** GEO-168: Skip legacy Slack components (used when bridge owns the pipeline) */
	skipSlackLegacy?: boolean;
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
		eventEmitterOverride,
		skipSlackLegacy = false,
	} = opts;

	// Fail-fast: TEAMLEAD_OWNS_SLACK=true requires TEAMLEAD_URL (unless skipSlackLegacy)
	const teamleadUrl = process.env.TEAMLEAD_URL;
	const teamleadOwnsSlack = process.env.TEAMLEAD_OWNS_SLACK === "true";
	if (!skipSlackLegacy && teamleadOwnsSlack && !teamleadUrl) {
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

	// CipherReader (read-only, for DecisionLayer integration)
	const cipherDbPath = join(flywheelDir, "cipher.db");
	const cipherReader = new CipherReader(cipherDbPath);
	log("CipherReader initialized (read-only)");

	const decisionLayer = new DecisionLayer(
		hardRules, triage, verifier, fallback, auditLogger, evidenceCollector,
		cipherReader,
	);

	// CIPHER: register active principles as HardRules
	// Principles match on their source pattern's primary label against execution context labels.
	// If the pattern has no label dimension, the principle fires universally.
	try {
		const principles = await cipherReader.loadActivePrinciples();
		for (const p of principles) {
			// Extract the label constraint from the source pattern key (e.g., "label:bug" or "label+size:bug+small")
			const labelMatch = p.sourcePattern.match(/(?:^|[+])label:([^+]+)/);
			const requiredLabel = labelMatch ? labelMatch[1] : null;

			hardRules.registerRule({
				id: p.id,
				description: p.description,
				priority: p.priority,
				evaluate: (ctx) => {
					// If principle has a label constraint, only trigger when execution matches
					if (requiredLabel && !ctx.labels.includes(requiredLabel)) {
						return { triggered: false, action: p.ruleType, reason: "", ruleId: p.id };
					}
					return {
						triggered: true,
						action: p.ruleType,
						reason: `CIPHER principle: ${p.description} (source: ${p.sourcePattern})`,
						ruleId: p.id,
					};
				},
			});
		}
		if (principles.length > 0) {
			log(`CIPHER: ${principles.length} active principle(s) registered as HardRules`);
		}
	} catch {
		log("CIPHER: no principles loaded (db may not exist yet)");
	}

	// EventEmitter — TeamLead pipeline (GEO-168: allow override for bridge-local retries)
	let eventEmitter: ExecutionEventEmitter;
	if (eventEmitterOverride) {
		eventEmitter = eventEmitterOverride;
		log("EventEmitter: using provided override (DirectEventSink)");
	} else {
		const teamleadToken = process.env.TEAMLEAD_INGEST_TOKEN;
		eventEmitter = teamleadUrl
			? new TeamLeadClient(teamleadUrl, teamleadToken)
			: new NoOpEventEmitter();
		if (teamleadUrl) log(`TeamLead events → ${teamleadUrl}`);
	}

	// Slack notification — conditional (skipped when TEAMLEAD_OWNS_SLACK or skipSlackLegacy)
	let slackNotifier: SlackNotifier | undefined;
	let interactionServer: SlackInteractionServer | undefined;
	let reactionsEngine: ReactionsEngine | undefined;

	const slackChannel = process.env.FLYWHEEL_SLACK_CHANNEL;
	const slackToken = process.env.SLACK_BOT_TOKEN;
	const repo = projectRepo ?? process.env.FLYWHEEL_PROJECT_REPO;

	if (skipSlackLegacy) {
		log("skipSlackLegacy=true — legacy Slack path disabled (bridge-local mode)");
	} else if (teamleadOwnsSlack) {
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

	// ── Config loading (v0.6 — .flywheel/config.yaml) ──────
	let flywheelConfig: FlywheelConfig | undefined;
	const configPath = join(projectRoot, ".flywheel", "config.yaml");
	try {
		const configLoader = new ConfigLoader(async (p) => readFileSync(p, "utf-8"));
		flywheelConfig = await configLoader.load(configPath);
		log(`Config loaded from ${configPath}`);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			log("No .flywheel/config.yaml — using defaults");
		} else {
			// Config exists but is invalid → fail fast
			throw err;
		}
	}

	// ── AgentDispatcher (v0.6) ──────────────────────────
	let agentDispatcher: AgentDispatcher | undefined;
	if (flywheelConfig?.agents && Object.keys(flywheelConfig.agents).length > 0) {
		let classifyFn: ClassifyFn | undefined;
		if (process.env.ANTHROPIC_API_KEY) {
			const classifyClient = new AnthropicLLMClient();
			classifyFn = async (title, description, agentNames, agentKeywords) => {
				const keywordList = agentNames
					.map((n) => `- ${n}: ${agentKeywords[n]?.join(", ") ?? ""}`)
					.join("\n");
				const prompt = [
					`Classify this Linear issue into exactly one of these agent names: [${agentNames.join(", ")}].`,
					"",
					"Each agent handles these types of work:",
					keywordList,
					"",
					"<issue_context>",
					`Title: ${title}`,
					`Description: ${description.slice(0, 500)}`,
					"</issue_context>",
					"",
					"Reply with ONLY the agent name, nothing else.",
				].join("\n");

				const response = await classifyClient.chat({
					model: "claude-haiku-4-5-20251001",
					messages: [{ role: "user", content: prompt }],
					max_tokens: 64,
				});
				const raw = response.content.trim();
				// Case-insensitive match: agent keys may have mixed case
				const matched = agentNames.find(
					(n) => n.toLowerCase() === raw.toLowerCase(),
				);
				return matched ?? null;
			};
		}
		agentDispatcher = new AgentDispatcher(
			flywheelConfig.agents,
			flywheelConfig.default_agent,
			classifyFn,
		);
		log(`AgentDispatcher: ${Object.keys(flywheelConfig.agents).length} agents configured`);
	}

	// Hydrator
	const hydrator = new PreHydrator(fetchIssue);

	// Git checker
	const gitChecker = new GitResultChecker(execFn);

	// Adapter factory (GEO-157: TmuxRunner → TmuxAdapter)
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
			} catch (e: any) {
				return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
			}
		},
	};

	// 4e. Memory system (v0.3) — factory logic + tests live in edge-worker package
	const memoryService = await createMemoryService({
		googleApiKey: process.env.GOOGLE_API_KEY,
		supabaseUrl: process.env.SUPABASE_URL,
		supabaseKey: process.env.SUPABASE_KEY,
		projectName,
		llmModel: process.env.FLYWHEEL_MEMORY_MODEL,
	});
	if (memoryService) {
		log("Memory system enabled (Supabase pgvector)");
	} else {
		log("Memory system disabled — requires GOOGLE_API_KEY + SUPABASE_URL + SUPABASE_KEY");
	}

	const blueprint = new Blueprint(
		hydrator, gitChecker, makeAdapter, shell,
		worktreeManager, skillInjector, evidenceCollector,
		flywheelConfig?.skills, // skillsConfig (was hardcoded undefined)
		decisionLayer,
		eventEmitter,
		agentDispatcher,
		memoryService,
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
