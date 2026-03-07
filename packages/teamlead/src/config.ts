import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "./bridge/types.js";

export type { BridgeConfig };

export function loadConfig(): BridgeConfig {
	const host = process.env.TEAMLEAD_HOST ?? "127.0.0.1";
	if (host === "0.0.0.0") {
		throw new Error("TEAMLEAD_HOST must not be 0.0.0.0 — use 127.0.0.1");
	}

	return {
		host,
		port: parseInt(process.env.TEAMLEAD_PORT ?? "9876", 10),
		dbPath: process.env.TEAMLEAD_DB_PATH ?? join(homedir(), ".flywheel", "teamlead.db"),
		ingestToken: process.env.TEAMLEAD_INGEST_TOKEN,
		apiToken: process.env.TEAMLEAD_API_TOKEN,
		gatewayUrl: process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789",
		hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
		stuckThresholdMinutes: parseInt(process.env.TEAMLEAD_STUCK_THRESHOLD ?? "15", 10),
		stuckCheckIntervalMs: parseInt(process.env.TEAMLEAD_STUCK_INTERVAL ?? "300000", 10),
	};
}
