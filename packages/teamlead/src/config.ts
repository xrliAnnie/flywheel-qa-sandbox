import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "./bridge/types.js";

export type { BridgeConfig };

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function loadConfig(): BridgeConfig {
	const host = process.env.TEAMLEAD_HOST ?? "127.0.0.1";
	if (!ALLOWED_HOSTS.has(host)) {
		throw new Error(`TEAMLEAD_HOST must be loopback (127.0.0.1, localhost, or ::1), got: ${host}`);
	}

	const port = parseInt(process.env.TEAMLEAD_PORT ?? "9876", 10);
	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid TEAMLEAD_PORT: ${process.env.TEAMLEAD_PORT}`);
	}

	return {
		host,
		port,
		dbPath: process.env.TEAMLEAD_DB_PATH ?? join(homedir(), ".flywheel", "teamlead.db"),
		ingestToken: process.env.TEAMLEAD_INGEST_TOKEN,
		apiToken: process.env.TEAMLEAD_API_TOKEN,
		gatewayUrl: process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789",
		hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
		stuckThresholdMinutes: parseInt(process.env.TEAMLEAD_STUCK_THRESHOLD ?? "15", 10),
		stuckCheckIntervalMs: parseInt(process.env.TEAMLEAD_STUCK_INTERVAL ?? "300000", 10),
	};
}
