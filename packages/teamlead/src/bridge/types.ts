export function sqliteDatetime(): string {
	return new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

export interface BridgeConfig {
	host: string;
	port: number;
	dbPath: string;
	ingestToken?: string;
	apiToken?: string;
	/** @deprecated Pre-FLY-163 default fallback channel. Per-lead chatChannel now drives notifications. */
	notificationChannel: string;
	/** Default lead agent ID for project-less notifications (e.g., CIPHER proposals). */
	defaultLeadAgentId: string;
	stuckThresholdMinutes: number;
	stuckCheckIntervalMs: number;
	orphanThresholdMinutes: number;
	discordBotToken?: string;
	// GEO-187: Linear API proxy
	linearApiKey?: string;
	discordGuildId?: string;
	/** GEO-267: Maximum concurrent Runner executions (default 3). */
	maxConcurrentRunners: number;
	/** FLY-91: Enable per-issue chat thread creation in chatChannel. */
	chatThreadsEnabled?: boolean;
	/** FLY-91: Discord user ID to auto-add as thread member (e.g., server owner). */
	discordOwnerUserId?: string;
}
