export function sqliteDatetime(): string {
	return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export interface BridgeConfig {
	host: string;
	port: number;
	dbPath: string;
	ingestToken?: string;
	apiToken?: string;
	gatewayUrl?: string;
	hooksToken?: string;
	notificationChannel: string;
	stuckThresholdMinutes: number;
	stuckCheckIntervalMs: number;
	orphanThresholdMinutes: number;
}
