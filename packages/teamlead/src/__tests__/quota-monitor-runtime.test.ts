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
import {
	type RecordObservationResult,
	readStore,
	writeStore,
} from "../account-heal/account-store.js";
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
	delete process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK;
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
			blockedEpisode: null,
			pendingSwitchFailure: null,
		},
		statePath,
	);
});

afterEach(() => {
	delete process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK;
	rmSync(dir, { recursive: true, force: true });
});

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
	it("wires live active identity verification before usage reads", async () => {
		process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK = "1";
		writeConfig(99);
		const current = readStore(storePath);
		const shopping = current.accounts.find(
			(account) => account.name === "shopping",
		);
		if (!shopping) throw new Error("shopping fixture missing");
		shopping.identity = {
			email: "shopping@example.com",
			uuid: "uuid-shopping",
			setAt: new Date(NOW - 60_000).toISOString(),
		};
		writeStore(current, storePath);
		const fetchUsage = vi.fn(async () => usageResult(40, 20));
		const fetchIdentity = vi.fn(async () => ({
			email: "intruder@example.com",
			uuid: "uuid-intruder",
		}));
		const alerts: unknown[] = [];
		const runtime = makeQuotaMonitorRuntime({
			now: () => NOW,
			paths: { poolDir, configPath, statePath, storePath, cachePath, lockPath },
			readKeychainCredential: async () => ({
				accessToken: "active-secret",
				expiresAt: NOW + 3_600_000,
			}),
			fetchUsage,
			fetchIdentity,
			tmux: {
				listPanes: async () => [],
				capturePane: async () => "",
				sendContinue: async () => ({ sent: true }),
			},
			alert: async (alert) => {
				alerts.push(alert);
				return { primary: "sent" };
			},
			log: vi.fn(),
		});

		const result = await runtime.tick();

		expect(result.outcome).toBe("identity_mismatch_active");
		expect(fetchIdentity).toHaveBeenCalledWith("active-secret");
		expect(fetchUsage).not.toHaveBeenCalled();
		expect(alerts).toEqual([
			expect.objectContaining({ kind: "account_identity_mismatch" }),
		]);
	});

	it("reconciles a manual active marker change before polling and migrates state to the new generation", async () => {
		writeConfig(99);
		writeFileSync(join(poolDir, ".active"), "school\n", { mode: 0o600 });
		const runtime = makeQuotaMonitorRuntime({
			now: () => NOW,
			paths: { poolDir, configPath, statePath, storePath, cachePath, lockPath },
			readKeychainCredential: async () => ({
				accessToken: "school-secret",
				expiresAt: NOW + 3_600_000,
			}),
			fetchUsage: async () => usageResult(40, 20),
			tmux: {
				listPanes: async () => [],
				capturePane: async () => "",
				sendContinue: async () => ({ sent: true }),
			},
			alert: async () => ({ primary: "sent" }),
			log: vi.fn(),
		});

		const result = await runtime.tick();

		expect(result.outcome).toBe("observed");
		expect(readStore(storePath)).toMatchObject({
			activeAccount: "school",
			generation: 5,
		});
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
			observedGeneration: 5,
			lastSwitchAt: NOW,
			reviveEpoch: null,
			blockedEpisode: null,
			pendingSwitchFailure: null,
		});
	});

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
				return { primary: "sent" };
			},
			log: vi.fn(),
		});

		let result = await runtime.tick();
		expect(result.outcome).toBe("observed");
		expect(switchImpl).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual(current.ok.raw);
		expect(readFileSync(statePath, "utf8")).not.toContain("active-secret");
		expect(
			readStore(storePath).accounts.find((entry) => entry.name === "shopping"),
		).toMatchObject({
			lastObservedAt: new Date(NOW).toISOString(),
			observedFiveHPct: 96,
			observedSevenDPct: 20,
		});

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

	it("alerts after three consecutive store projection failures without stopping polls", async () => {
		writeConfig(99);
		const alerts: unknown[] = [];
		const recordObservation = vi.fn(
			async (): Promise<RecordObservationResult> => "write_failed",
		);
		const runtime = makeQuotaMonitorRuntime({
			now: () => NOW,
			paths: { poolDir, configPath, statePath, storePath, cachePath, lockPath },
			readKeychainCredential: async () => ({
				accessToken: "active-secret",
				expiresAt: NOW + 3_600_000,
			}),
			fetchUsage: async () => usageResult(40, 20),
			recordObservation,
			tmux: {
				listPanes: async () => [],
				capturePane: async () => "",
				sendContinue: async () => ({ sent: true }),
			},
			alert: async (alert) => {
				alerts.push(alert);
				return { primary: "sent" };
			},
			log: vi.fn(),
		});

		for (let attempt = 0; attempt < 3; attempt++) {
			const result = await runtime.tick();
			expect(result.outcome).toBe("observed");
		}

		expect(recordObservation).toHaveBeenCalledTimes(3);
		expect(alerts).toEqual([
			expect.objectContaining({
				kind: "quota_monitor_down",
				signature: "quota-monitor-store-projection-2026-07-14",
			}),
		]);
	});
});
