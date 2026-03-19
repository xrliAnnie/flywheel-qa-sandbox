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
	gatewayUrl?: string;
	hooksToken?: string;
	/** @deprecated Use ProjectEntry.lead.channel instead (GEO-152). */
	notificationChannel: string;
	/** Default OpenClaw agent ID for project-less notifications (e.g., CIPHER proposals). */
	defaultLeadAgentId: string;
	stuckThresholdMinutes: number;
	stuckCheckIntervalMs: number;
	orphanThresholdMinutes: number;
	discordBotToken?: string;
	cleanupIntervalMs?: number;
	cleanupThresholdMinutes?: number;
}
