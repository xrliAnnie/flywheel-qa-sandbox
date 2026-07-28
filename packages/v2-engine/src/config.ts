import type { ReadTx, WriteTx } from "flywheel-v2-kernel";
import {
	DEFAULT_ENGINE_CONFIG,
	type EngineConfig,
	EngineConfigError,
} from "./types.js";

const CONFIG_SPEC = {
	"mailbox.poll_interval_ms": {
		field: "pollIntervalMs",
		min: 250,
		max: 60_000,
	},
	"mailbox.heartbeat_write_interval_ms": {
		field: "heartbeatWriteIntervalMs",
		min: 1_000,
		max: 60_000,
	},
	"mailbox.heartbeat_stale_after_ms": {
		field: "heartbeatStaleAfterMs",
		min: 3_000,
		max: 600_000,
	},
	"mailbox.running_attempt_max_age_ms": {
		field: "runningAttemptMaxAgeMs",
		min: 60_000,
		max: 86_400_000,
	},
	"mailbox.cold_start_alert_after_ms": {
		field: "coldStartAlertAfterMs",
		min: 60_000,
		max: 3_600_000,
	},
	"mailbox.vip_burst": { field: "vipBurst", min: 1, max: 100 },
	"mailbox.promotion_age_ms": {
		field: "promotionAgeMs",
		min: 60_000,
		max: 604_800_000,
	},
	"mailbox.max_attempts": { field: "maxAttempts", min: 2, max: 100 },
	"mailbox.retry_base_ms": {
		field: "retryBaseMs",
		min: 1_000,
		max: 3_600_000,
	},
	"mailbox.retry_cap_ms": {
		field: "retryCapMs",
		min: 1_000,
		max: 86_400_000,
	},
	"mailbox.notice_pending_limit": {
		field: "noticePendingLimit",
		min: 1,
		max: 1_000_000,
	},
} as const satisfies Record<
	string,
	{ field: keyof EngineConfig; min: number; max: number }
>;

const FIELD_TO_KEY = Object.fromEntries(
	Object.entries(CONFIG_SPEC).map(([key, spec]) => [spec.field, key]),
) as Record<keyof EngineConfig, keyof typeof CONFIG_SPEC>;

interface ConfigRow {
	key: string;
	value: string;
}

function parseValue(
	key: string,
	value: string | undefined,
	min: number,
	max: number,
): number {
	if (value === undefined) {
		throw new EngineConfigError(`missing config key ${key}`);
	}
	if (!/^[1-9][0-9]*$/.test(value)) {
		throw new EngineConfigError(`${key} must be a canonical positive integer`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new EngineConfigError(`${key} must be in ${min}..${max}`);
	}
	return parsed;
}

export function validateEngineConfig(config: EngineConfig): EngineConfig {
	const validated = {} as EngineConfig;
	for (const [key, spec] of Object.entries(CONFIG_SPEC) as Array<
		[
			keyof typeof CONFIG_SPEC,
			{ field: keyof EngineConfig; min: number; max: number },
		]
	>) {
		validated[spec.field] = parseValue(
			key,
			String(config[spec.field]),
			spec.min,
			spec.max,
		);
	}
	if (validated.heartbeatWriteIntervalMs < validated.pollIntervalMs) {
		throw new EngineConfigError(
			"heartbeatWriteIntervalMs must be >= pollIntervalMs",
		);
	}
	if (
		validated.heartbeatStaleAfterMs <
		3 * validated.heartbeatWriteIntervalMs
	) {
		throw new EngineConfigError(
			"heartbeatStaleAfterMs must be >= 3 * heartbeatWriteIntervalMs",
		);
	}
	if (validated.retryBaseMs > validated.retryCapMs) {
		throw new EngineConfigError("retryBaseMs must be <= retryCapMs");
	}
	return validated;
}

export function seedEngineConfigTx(tx: WriteTx, updatedAt: string): void {
	for (const [field, value] of Object.entries(DEFAULT_ENGINE_CONFIG) as Array<
		[keyof EngineConfig, number]
	>) {
		tx.run(
			`INSERT INTO config(key,value,updated_at)
			 VALUES (@key,@value,@updatedAt)
			 ON CONFLICT(key) DO NOTHING`,
			{ key: FIELD_TO_KEY[field], value: String(value), updatedAt },
		);
	}
}

export function readEngineConfigTx(tx: ReadTx): EngineConfig {
	const rows = tx.all<ConfigRow>(
		`SELECT key,value FROM config
		 WHERE key LIKE 'mailbox.%'`,
	);
	const values = new Map(rows.map((row) => [row.key, row.value]));
	const config = {} as EngineConfig;
	for (const [key, spec] of Object.entries(CONFIG_SPEC) as Array<
		[
			keyof typeof CONFIG_SPEC,
			{ field: keyof EngineConfig; min: number; max: number },
		]
	>) {
		config[spec.field] = parseValue(key, values.get(key), spec.min, spec.max);
	}
	return validateEngineConfig(config);
}
