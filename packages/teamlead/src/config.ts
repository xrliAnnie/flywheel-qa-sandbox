import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "./bridge/types.js";

export type { BridgeConfig };

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Parse STATUS_TAG_MAP env var: JSON object mapping status → tag ID arrays. */
function parseStatusTagMap(
	raw: string | undefined,
): Record<string, string[]> | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("must be a JSON object");
		}
		return parsed as Record<string, string[]>;
	} catch (err) {
		console.warn(
			`[config] Invalid STATUS_TAG_MAP — ignoring:`,
			(err as Error).message,
		);
		return undefined;
	}
}

function parsePositiveInt(
	value: string | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined) return fallback;
	const n = parseInt(value, 10);
	if (!Number.isFinite(n) || n < 1) {
		throw new Error(`Invalid ${name}: ${value} (must be a positive integer)`);
	}
	return n;
}

export function loadConfig(): BridgeConfig {
	const host = process.env.TEAMLEAD_HOST ?? "127.0.0.1";
	if (!ALLOWED_HOSTS.has(host)) {
		throw new Error(
			`TEAMLEAD_HOST must be loopback (127.0.0.1, localhost, or ::1), got: ${host}`,
		);
	}

	const port = parseInt(process.env.TEAMLEAD_PORT ?? "9876", 10);
	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid TEAMLEAD_PORT: ${process.env.TEAMLEAD_PORT}`);
	}

	const stuckThresholdMinutes = parsePositiveInt(
		process.env.TEAMLEAD_STUCK_THRESHOLD,
		15,
		"TEAMLEAD_STUCK_THRESHOLD",
	);
	const orphanThresholdMinutes = parsePositiveInt(
		process.env.TEAMLEAD_ORPHAN_THRESHOLD,
		60,
		"TEAMLEAD_ORPHAN_THRESHOLD",
	);
	if (orphanThresholdMinutes <= stuckThresholdMinutes) {
		throw new Error(
			`TEAMLEAD_ORPHAN_THRESHOLD (${orphanThresholdMinutes}) must be greater than TEAMLEAD_STUCK_THRESHOLD (${stuckThresholdMinutes})`,
		);
	}

	return {
		host,
		port,
		dbPath:
			process.env.TEAMLEAD_DB_PATH ??
			join(homedir(), ".flywheel", "teamlead.db"),
		ingestToken: process.env.TEAMLEAD_INGEST_TOKEN,
		apiToken: process.env.TEAMLEAD_API_TOKEN,
		gatewayUrl: process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789",
		hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
		notificationChannel:
			process.env.TEAMLEAD_NOTIFICATION_CHANNEL ?? "CD5QZVAP6",
		stuckThresholdMinutes,
		stuckCheckIntervalMs: parsePositiveInt(
			process.env.TEAMLEAD_STUCK_INTERVAL,
			300_000,
			"TEAMLEAD_STUCK_INTERVAL",
		),
		orphanThresholdMinutes,
		discordBotToken: process.env.DISCORD_BOT_TOKEN,
		linearApiKey: process.env.LINEAR_API_KEY,
		discordGuildId: process.env.DISCORD_GUILD_ID,
		statusTagMap: parseStatusTagMap(process.env.STATUS_TAG_MAP),
		cleanupIntervalMs: parsePositiveInt(
			process.env.TEAMLEAD_CLEANUP_INTERVAL,
			3_600_000,
			"TEAMLEAD_CLEANUP_INTERVAL",
		),
		cleanupThresholdMinutes: parsePositiveInt(
			process.env.TEAMLEAD_CLEANUP_THRESHOLD,
			1440,
			"TEAMLEAD_CLEANUP_THRESHOLD",
		),
	};
}
