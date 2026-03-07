export interface BridgeConfig {
	host: string;
	port: number;
	dbPath: string;
	ingestToken?: string;
	apiToken?: string;
	gatewayUrl?: string;
	hooksToken?: string;
	stuckThresholdMinutes: number;
	stuckCheckIntervalMs: number;
}
