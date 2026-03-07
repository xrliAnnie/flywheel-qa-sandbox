#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { loadProjects } from "./ProjectConfig.js";
import { StateStore } from "./StateStore.js";
import { EventIngestion } from "./EventIngestion.js";
import { SlackBot } from "./SlackBot.js";
import { TemplateNotifier } from "./TemplateNotifier.js";
import { StuckWatcher } from "./StuckWatcher.js";
import { createReactionsEngine } from "./ActionExecutor.js";
import { TeamLeadBrain, createSdkLlm, createCliLlm } from "./TeamLeadBrain.js";

async function main() {
	const config = loadConfig();
	const projects = loadProjects();

	// 1. StateStore (async init for sql.js WASM)
	const store = await StateStore.create(config.dbPath);

	// 2. Slack components (conditional on TEAMLEAD_OWNS_SLACK)
	let bot: SlackBot | undefined;
	let notifier: TemplateNotifier | undefined;
	let stuckWatcher: StuckWatcher | undefined;

	if (config.ownsSlack) {
		const reactionsEngine = createReactionsEngine(projects, store);

		// Brain — SDK backend (API key) or CLI backend (subscription)
		let brain: TeamLeadBrain | undefined;
		if (config.anthropicApiKey) {
			const llmCall = await createSdkLlm(config.anthropicApiKey, config.llmModel, config.llmMaxTokens);
			brain = new TeamLeadBrain(store, llmCall);
			console.log(`[TeamLead] Brain enabled (SDK, model: ${config.llmModel})`);
		} else {
			const llmCall = createCliLlm(config.llmModel);
			brain = new TeamLeadBrain(store, llmCall);
			console.log(`[TeamLead] Brain enabled (CLI, model: ${config.llmModel})`);
		}

		bot = new SlackBot(
			config.slackBotToken!,
			config.slackAppToken!,
			config.slackChannelId!,
			{
				reactionsDispatch: (action) => reactionsEngine.dispatch(action),
				onMessage: brain
					? (q, ts) => brain!.answer(q, ts)
					: undefined,
				getThreadIssue: (ts) => store.getThreadIssue(ts),
				allowedUserIds: config.allowedUserIds,
				allowAllUsers: config.allowAllUsers,
			},
		);
		notifier = new TemplateNotifier(bot, store);
		stuckWatcher = new StuckWatcher(
			store,
			notifier,
			config.stuckThresholdMinutes,
			config.stuckCheckIntervalMs,
		);
	}

	// 3. EventIngestion (always active)
	// Auth token: both daemon and orchestrator must share the same TEAMLEAD_INGEST_TOKEN.
	// If not configured, auth is disabled on both sides (TeamLeadClient won't send, EventIngestion won't check).
	const ingestToken = process.env.TEAMLEAD_INGEST_TOKEN;
	const ingestion = new EventIngestion(store, (event) => {
		if (!notifier) return;

		const session = store.getSession(event.execution_id);
		if (!session) return;

		if (event.event_type === "session_completed") {
			notifier.onSessionCompleted(session).catch((err) => {
				console.error("[TeamLead] Notification error:", err);
			});
		} else if (event.event_type === "session_failed") {
			notifier.onSessionFailed(session).catch((err) => {
				console.error("[TeamLead] Notification error:", err);
			});
		}
	}, ingestToken);

	// 4. Start components
	const port = await ingestion.start(config.port);
	if (bot) {
		await bot.start();
		stuckWatcher?.start();
		console.log(
			`[TeamLead] Daemon started — events on :${port}, Slack Socket Mode connected`,
		);
	} else {
		console.log(
			`[TeamLead] Daemon started (event-only mode) — events on :${port}`,
		);
	}

	// 5. Graceful shutdown
	const shutdown = async () => {
		console.log("[TeamLead] Shutting down...");
		stuckWatcher?.stop();
		await ingestion.stop();
		if (bot) await bot.stop();
		store.close();
		console.log("[TeamLead] Bye.");
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("[TeamLead] Fatal:", err);
	process.exit(1);
});
