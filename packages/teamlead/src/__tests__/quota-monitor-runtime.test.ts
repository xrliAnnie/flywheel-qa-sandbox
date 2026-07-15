import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStore } from "../account-heal/account-store.js";
import { makeQuotaMonitorRuntime } from "../account-heal/quota-monitor-runtime.js";
import { writeQuotaMonitorState } from "../account-heal/quota-monitor-state.js";
import { usageResult } from "./quota-monitor-test-helpers.js";

const NOW = Date.parse("2026-07-14T20:00:00Z");
let dir: string;
let poolDir: string;
let configPath: string;
let statePath: string;
let storePath: string;
let cachePath: string;
let lockPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1256-runtime-"));
	poolDir = join(dir, "pool");
	configPath = join(dir, "config.json");
	statePath = join(dir, "state.json");
	storePath = join(dir, "accounts.json");
	cachePath = join(dir, "usage-cache.json");
	lockPath = join(dir, "accounts.lock");
	mkdirSync(poolDir);
	writeFileSync(join(poolDir, ".active"), "shopping\n", { mode: 0o600 });
	for (const [name, token] of [
		["shopping", "active-secret"],
		["school", "school-secret"],
	] as const) {
		mkdirSync(join(poolDir, name));
		writeFileSync(
			join(poolDir, name, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: token,
					refreshToken: `${name}-refresh`,
					expiresAt: NOW + 3_600_000,
				},
			}),
			{ mode: 0o600 },
		);
	}
	writeStore(
		{
			generation: 4,
			activeAccount: "shopping",
			accounts: [
				{ name: "shopping", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		},
		storePath,
	);
	writeQuotaMonitorState(
		{
			version: 1,
			lastPollAt: null,
			lastSuccessfulUsageAt: null,
			errorStreak: 0,
			backoffUntilMs: 0,
			tier: "base",
			lastCandidateSweepAt: null,
			lastSwitchAt: null,
			observedGeneration: 4,
			reviveEpoch: null,
		},
		statePath,
	);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(trigger5hPct: number): void {
	writeFileSync(
		configPath,
		JSON.stringify({
			trigger5hPct,
			basePollMinutes: 20,
			acceleratePct: 70,
			acceleratedPollMinutes: 10,
			candidateSweepMinutes: 60,
			minSwitchIntervalMinutes: 15,
			order: ["shopping", "school"],
			writeStatuslineCache: true,
		}),
		{ mode: 0o600 },
	);
}

describe("makeQuotaMonitorRuntime", () => {
	it("assembles real file/lock/credential seams, re-reads config per tick, and persists cache/state without tokens", async () => {
		writeConfig(99);
		const current = usageResult(96, 20);
		const school = usageResult(5, 10, {
			seven: "2026-07-19T14:00:00.000Z",
		});
		const switchImpl = vi.fn(async () => ({
			outcome: "switched" as const,
			from: "shopping",
			to: "school",
			generation: 5,
		}));
		const alerts: unknown[] = [];
		const runtime = makeQuotaMonitorRuntime({
			now: () => NOW,
			paths: { poolDir, configPath, statePath, storePath, cachePath, lockPath },
			readKeychainCredential: async () => ({
				accessToken: "active-secret",
				expiresAt: NOW + 3_600_000,
			}),
			fetchUsage: async (token) =>
				token === "active-secret" ? current : school,
			verifyCandidate: async () => ({
				fresh: "refreshed" as const,
				expiresAt: NOW + 3_600_000,
			}),
			switchAccount: switchImpl,
			tmux: {
				listPanes: async () => [],
				capturePane: async () => "",
				sendContinue: async () => ({ sent: true }),
			},
			alert: async (alert) => {
				alerts.push(alert);
			},
			log: vi.fn(),
		});

		let result = await runtime.tick();
		expect(result.outcome).toBe("observed");
		expect(switchImpl).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual(current.ok.raw);
		expect(readFileSync(statePath, "utf8")).not.toContain("active-secret");

		writeConfig(90);
		result = await runtime.tick();
		expect(result.outcome).toBe("switched");
		expect(switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({ preferredOrder: ["school"] }),
		);
		expect(alerts).toEqual([
			expect.objectContaining({ kind: "account_switched" }),
		]);
	});
});
