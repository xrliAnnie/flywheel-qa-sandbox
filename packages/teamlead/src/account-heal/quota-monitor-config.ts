import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface QuotaMonitorConfig {
	trigger5hPct: number;
	basePollMinutes: number;
	acceleratePct: number;
	acceleratedPollMinutes: number;
	candidateSweepMinutes: number;
	minSwitchIntervalMinutes: number;
	order: string[];
	writeStatuslineCache: boolean;
	paneScanSeconds: number;
	confirmDelayMinutes: number;
	degradedSwitch: boolean;
	episodeRealertMinutes: number;
}

export const DEFAULT_QUOTA_MONITOR_CONFIG: QuotaMonitorConfig = {
	trigger5hPct: 90,
	basePollMinutes: 20,
	acceleratePct: 70,
	acceleratedPollMinutes: 10,
	candidateSweepMinutes: 60,
	minSwitchIntervalMinutes: 15,
	order: [],
	writeStatuslineCache: true,
	paneScanSeconds: 60,
	confirmDelayMinutes: 7,
	degradedSwitch: false,
	episodeRealertMinutes: 30,
};

export type LoadedQuotaMonitorConfig = {
	config: QuotaMonitorConfig;
	monitorOnly: boolean;
	error?: "missing" | "invalid";
};

const VALID_PROFILE_NAME = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;

export function defaultQuotaMonitorConfigPath(): string {
	return (
		process.env.FLYWHEEL_QUOTA_MONITOR_CONFIG ??
		join(homedir(), ".flywheel", "quota-monitor.json")
	);
}

function fallback(error: "missing" | "invalid"): LoadedQuotaMonitorConfig {
	return {
		config: { ...DEFAULT_QUOTA_MONITOR_CONFIG, order: [] },
		monitorOnly: true,
		error,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedNumber(
	value: unknown,
	minInclusive: number,
	maxInclusive: number,
): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= minInclusive &&
		value <= maxInclusive
	);
}

function parseConfig(value: unknown): QuotaMonitorConfig | null {
	if (!isRecord(value)) return null;
	const paneScanSeconds =
		value.paneScanSeconds ?? DEFAULT_QUOTA_MONITOR_CONFIG.paneScanSeconds;
	const confirmDelayMinutes =
		value.confirmDelayMinutes ??
		DEFAULT_QUOTA_MONITOR_CONFIG.confirmDelayMinutes;
	const degradedSwitch = value.degradedSwitch ?? false;
	const episodeRealertMinutes = value.episodeRealertMinutes ?? 30;
	if (
		!boundedNumber(value.trigger5hPct, 0, 100) ||
		!boundedNumber(value.acceleratePct, 0, 100) ||
		!boundedNumber(value.basePollMinutes, Number.EPSILON, 1_440) ||
		!boundedNumber(value.acceleratedPollMinutes, Number.EPSILON, 1_440) ||
		!boundedNumber(value.candidateSweepMinutes, Number.EPSILON, 10_080) ||
		!boundedNumber(value.minSwitchIntervalMinutes, Number.EPSILON, 1_440) ||
		!boundedNumber(paneScanSeconds, 1, 3_600) ||
		!boundedNumber(confirmDelayMinutes, 5, 10) ||
		typeof value.writeStatuslineCache !== "boolean" ||
		typeof degradedSwitch !== "boolean" ||
		!boundedNumber(episodeRealertMinutes, 5, 1_440) ||
		!Array.isArray(value.order)
	) {
		return null;
	}
	if (
		value.acceleratePct >= value.trigger5hPct ||
		value.acceleratedPollMinutes > value.basePollMinutes
	) {
		return null;
	}
	if (
		!value.order.every(
			(name): name is string =>
				typeof name === "string" && VALID_PROFILE_NAME.test(name),
		) ||
		new Set(value.order).size !== value.order.length
	) {
		return null;
	}

	return {
		trigger5hPct: value.trigger5hPct,
		basePollMinutes: value.basePollMinutes,
		acceleratePct: value.acceleratePct,
		acceleratedPollMinutes: value.acceleratedPollMinutes,
		candidateSweepMinutes: value.candidateSweepMinutes,
		minSwitchIntervalMinutes: value.minSwitchIntervalMinutes,
		order: [...value.order],
		writeStatuslineCache: value.writeStatuslineCache,
		paneScanSeconds,
		confirmDelayMinutes,
		degradedSwitch,
		episodeRealertMinutes,
	};
}

/** Load and validate on demand; callers invoke this once per daemon tick. */
export function loadQuotaMonitorConfig(
	path: string = defaultQuotaMonitorConfigPath(),
): LoadedQuotaMonitorConfig {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return fallback(
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? "missing"
				: "invalid",
		);
	}

	try {
		const config = parseConfig(JSON.parse(raw));
		if (config === null) return fallback("invalid");
		return { config, monitorOnly: config.order.length === 0 };
	} catch {
		return fallback("invalid");
	}
}
