import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_QUOTA_MONITOR_CONFIG,
	loadQuotaMonitorConfig,
} from "../account-heal/quota-monitor-config.js";

let dir: string;
let path: string;

const enabledConfig = {
	trigger5hPct: 90,
	basePollMinutes: 20,
	acceleratePct: 70,
	acceleratedPollMinutes: 10,
	candidateSweepMinutes: 60,
	minSwitchIntervalMinutes: 15,
	order: ["shopping", "school", "business"],
	writeStatuslineCache: true,
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1256-config-"));
	path = join(dir, "quota-monitor.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

describe("loadQuotaMonitorConfig", () => {
	it("missing config falls back to compiled polling defaults in monitor-only mode", () => {
		expect(loadQuotaMonitorConfig(path)).toEqual({
			config: DEFAULT_QUOTA_MONITOR_CONFIG,
			monitorOnly: true,
			error: "missing",
		});
		expect(DEFAULT_QUOTA_MONITOR_CONFIG).toMatchObject({
			trigger5hPct: 90,
			basePollMinutes: 20,
			acceleratePct: 70,
			acceleratedPollMinutes: 10,
			candidateSweepMinutes: 60,
			minSwitchIntervalMinutes: 15,
			order: [],
			writeStatuslineCache: true,
			degradedSwitch: false,
			episodeRealertMinutes: 30,
		});
	});

	it("loads an existing enabled config with safe defaults for new controls", () => {
		write(enabledConfig);
		expect(loadQuotaMonitorConfig(path)).toEqual({
			config: {
				...enabledConfig,
				degradedSwitch: false,
				episodeRealertMinutes: 30,
			},
			monitorOnly: false,
		});
	});

	it("accepts explicit degraded-switch and episode re-alert controls", () => {
		write({
			...enabledConfig,
			degradedSwitch: true,
			episodeRealertMinutes: 45,
		});
		expect(loadQuotaMonitorConfig(path).config).toMatchObject({
			degradedSwitch: true,
			episodeRealertMinutes: 45,
		});
	});

	it("accepts an empty order as an intentional valid monitor-only config", () => {
		write({ ...enabledConfig, order: [] });
		const loaded = loadQuotaMonitorConfig(path);
		expect(loaded.error).toBeUndefined();
		expect(loaded.monitorOnly).toBe(true);
		expect(loaded.config.order).toEqual([]);
	});

	it("re-reads the file on every call so edits take effect without restart", () => {
		write(enabledConfig);
		expect(loadQuotaMonitorConfig(path).config.trigger5hPct).toBe(90);
		write({ ...enabledConfig, trigger5hPct: 95 });
		expect(loadQuotaMonitorConfig(path).config.trigger5hPct).toBe(95);
	});

	it.each([
		["bad JSON", "{"],
		["missing field", JSON.stringify({ ...enabledConfig, order: undefined })],
		[
			"accelerate equals trigger",
			JSON.stringify({ ...enabledConfig, acceleratePct: 90 }),
		],
		[
			"accelerate exceeds trigger",
			JSON.stringify({ ...enabledConfig, acceleratePct: 91 }),
		],
		[
			"accelerated poll exceeds base poll",
			JSON.stringify({ ...enabledConfig, acceleratedPollMinutes: 21 }),
		],
		[
			"zero interval",
			JSON.stringify({ ...enabledConfig, candidateSweepMinutes: 0 }),
		],
		[
			"unbounded interval",
			JSON.stringify({ ...enabledConfig, basePollMinutes: 1_441 }),
		],
		[
			"invalid degraded switch",
			JSON.stringify({ ...enabledConfig, degradedSwitch: "yes" }),
		],
		[
			"episode interval below minimum",
			JSON.stringify({ ...enabledConfig, episodeRealertMinutes: 4 }),
		],
		[
			"episode interval above maximum",
			JSON.stringify({ ...enabledConfig, episodeRealertMinutes: 1_441 }),
		],
		[
			"duplicate account",
			JSON.stringify({ ...enabledConfig, order: ["school", "school"] }),
		],
		["leading dot", JSON.stringify({ ...enabledConfig, order: [".active"] })],
		[
			"parent traversal",
			JSON.stringify({ ...enabledConfig, order: ["school..backup"] }),
		],
		["slash", JSON.stringify({ ...enabledConfig, order: ["pool/school"] })],
	])(
		"invalid config (%s) falls back safely and identifies invalid input",
		(_label, body) => {
			writeFileSync(path, body, { mode: 0o600 });
			expect(loadQuotaMonitorConfig(path)).toEqual({
				config: DEFAULT_QUOTA_MONITOR_CONFIG,
				monitorOnly: true,
				error: "invalid",
			});
		},
	);
});
