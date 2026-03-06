#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { loadProjects } from "./ProjectConfig.js";
import { StateStore } from "./StateStore.js";
import { EventIngestion } from "./EventIngestion.js";
import { SlackBot } from "./SlackBot.js";
import { TemplateNotifier } from "./TemplateNotifier.js";
import { StuckWatcher } from "./StuckWatcher.js";
import { createReactionsEngine } from "./ActionExecutor.js";

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
		bot = new SlackBot(
			config.slackBotToken!,
			config.slackAppToken!,
			config.slackChannelId!,
			{ reactionsDispatch: (action) => reactionsEngine.dispatch(action) },
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
	});

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
