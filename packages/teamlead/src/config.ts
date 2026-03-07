import { homedir } from "node:os";
import { join } from "node:path";

export interface TeamLeadConfig {
	port: number;
	dbPath: string;
	ownsSlack: boolean;
	slackBotToken?: string;
	slackAppToken?: string;
	slackChannelId?: string;
	stuckThresholdMinutes: number;
	stuckCheckIntervalMs: number;
	anthropicApiKey?: string;
	llmModel: string;
	llmMaxTokens: number;
	allowedUserIds: string[];
	allowAllUsers: boolean;
}

export function loadConfig(): TeamLeadConfig {
	const ownsSlack = process.env.TEAMLEAD_OWNS_SLACK === "true";

	if (ownsSlack) {
		if (!process.env.SLACK_BOT_TOKEN) {
			throw new Error("TEAMLEAD_OWNS_SLACK=true requires SLACK_BOT_TOKEN");
		}
		if (!process.env.SLACK_APP_TOKEN) {
			throw new Error("TEAMLEAD_OWNS_SLACK=true requires SLACK_APP_TOKEN");
		}
		if (!process.env.FLYWHEEL_SLACK_CHANNEL) {
			throw new Error("TEAMLEAD_OWNS_SLACK=true requires FLYWHEEL_SLACK_CHANNEL");
		}
	}

	const config: TeamLeadConfig = {
		port: parseInt(process.env.TEAMLEAD_PORT ?? "9876", 10),
		dbPath: process.env.TEAMLEAD_DB_PATH ?? join(homedir(), ".flywheel", "teamlead.db"),
		ownsSlack,
		slackBotToken: process.env.SLACK_BOT_TOKEN,
		slackAppToken: process.env.SLACK_APP_TOKEN,
		slackChannelId: process.env.FLYWHEEL_SLACK_CHANNEL,
		stuckThresholdMinutes: parseInt(process.env.TEAMLEAD_STUCK_THRESHOLD ?? "15", 10),
		stuckCheckIntervalMs: parseInt(process.env.TEAMLEAD_STUCK_INTERVAL ?? "300000", 10),
		anthropicApiKey: process.env.ANTHROPIC_API_KEY,
		llmModel: process.env.TEAMLEAD_LLM_MODEL ?? "claude-sonnet-4-6",
		llmMaxTokens: parseInt(process.env.TEAMLEAD_LLM_MAX_TOKENS ?? "1024", 10),
		allowedUserIds: process.env.TEAMLEAD_ALLOWED_USER_IDS
			? process.env.TEAMLEAD_ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
			: [],
		allowAllUsers: process.env.TEAMLEAD_ALLOW_ALL_USERS === "true",
	};

	// Secure-by-default: when Slack is enabled, Brain Q&A is always active (SDK or CLI fallback),
	// so access control is always required.
	if (config.ownsSlack && !config.allowAllUsers && config.allowedUserIds.length === 0) {
		throw new Error(
			"Brain Q&A requires TEAMLEAD_ALLOWED_USER_IDS or TEAMLEAD_ALLOW_ALL_USERS=true",
		);
	}

	return config;
}
