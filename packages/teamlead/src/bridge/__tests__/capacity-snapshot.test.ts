import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUOTA_MONITOR_CONFIG } from "../../account-heal/quota-monitor-config.js";
import { parseClaudeResetGrants } from "../../claude-quota/account-detail-observer.js";
import {
	readClaudeAccountDetailStore,
	writeClaudeAccountDetailStore,
} from "../../claude-quota/account-detail-store.js";
import { parseCodexSubscriptionResponse } from "../../codex-quota/codex-subscription-reader.js";
import {
	readCodexSubscriptionStore,
	writeCodexSubscriptionStore,
} from "../../codex-quota/codex-subscription-store.js";
import { renderAccountQuotaPageHtml } from "../account-quota-page.js";
import { buildAccountQuotaView } from "../account-quota-view.js";
import {
	buildCapacitySnapshot,
	codexTokenState,
} from "../capacity-snapshot.js";

const scratch: string[] = [];
const TOKEN_STATE_VECTORS = JSON.parse(
	readFileSync(
		new URL(
			"../../../../../scripts/__tests__/fixtures/codex-token-state-vectors.json",
			import.meta.url,
		),
		"utf8",
	),
) as readonly {
	authHealth: Parameters<typeof codexTokenState>[0]["authHealth"];
	note: Parameters<typeof codexTokenState>[0]["note"];
	usedPercent: number | null;
	expected: string;
}[];

function writeAccountStore(value: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "fly2144-capacity-"));
	scratch.push(dir);
	const path = join(dir, "claude-accounts.json");
	writeFileSync(path, JSON.stringify(value));
	return path;
}

function writeRawAccountStore(value: string): string {
	const dir = mkdtempSync(join(tmpdir(), "fly2144-capacity-"));
	scratch.push(dir);
	const path = join(dir, "claude-accounts.json");
	writeFileSync(path, value);
	return path;
}

function missingAccountStorePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "fly2144-capacity-"));
	scratch.push(dir);
	return join(dir, "claude-accounts.json");
}

afterEach(() => {
	while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true });
});

function writeCodexAccountStore(value: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "fly2688-codex-capacity-"));
	scratch.push(dir);
	const path = join(dir, "codex-accounts.json");
	writeFileSync(path, JSON.stringify(value));
	return path;
}

describe("FLY-2688 — Codex quota projection", () => {
	const base = {
		now: () => Date.parse("2026-09-21T12:00:00.000Z"),
		readMemoryFreePct: async () => ({
			freePct: 40,
			observedAt: "2026-09-21T12:00:00.000Z",
		}),
		store: {
			getActiveSessions: () => [] as never,
			getFleetPressureHold: () => undefined,
			getAdmissionPause: () => undefined,
		},
	};

	it.each(TOKEN_STATE_VECTORS)(
		"maps $authHealth / $note to token state $expected",
		({ authHealth, note, usedPercent, expected }) => {
			expect(
				codexTokenState({
					authHealth,
					note,
					fiveH:
						usedPercent === null
							? null
							: { usedPercent, windowMinutes: 300, resetAt: null },
					weekly: null,
				}),
			).toBe(expected);
		},
	);

	it("projects real readings, exhaustion and recovery from the Codex store", async () => {
		const snapshot = await buildCapacitySnapshot({
			...base,
			accountStorePath: missingAccountStorePath(),
			codexAccountStorePath: writeCodexAccountStore({
				version: 1,
				generatedAt: "2026-09-21T11:50:00.000Z",
				activeAccount: "personal",
				accounts: [
					{
						name: "personal",
						registeredProfile: "personal",
						observedAt: "2026-09-21T11:50:00.000Z",
						authHealth: "valid",
						note: null,
						planType: "pro",
						fiveH: {
							usedPercent: 100,
							windowMinutes: 300,
							resetAt: "2026-09-21T15:00:00.000Z",
						},
						weekly: {
							usedPercent: 100,
							windowMinutes: 10080,
							resetAt: "2026-09-23T15:00:00.000Z",
						},
						credits: {
							known: true,
							hasCredits: false,
							unlimited: false,
							balance: "0",
						},
						resetCredits: { known: true, value: null },
						unclassifiedWindows: 0,
					},
					{
						name: "shopping",
						registeredProfile: null,
						observedAt: null,
						authHealth: "in_use_unshared",
						note: "in_use_unshared",
						planType: null,
						fiveH: null,
						weekly: null,
						credits: {
							known: false,
							hasCredits: null,
							unlimited: null,
							balance: null,
						},
						resetCredits: { known: false, value: null },
						unclassifiedWindows: 0,
					},
					{
						name: "school",
						registeredProfile: "school",
						observedAt: null,
						authHealth: "missing",
						note: "read_failed",
						planType: null,
						fiveH: null,
						weekly: null,
						credits: {
							known: false,
							hasCredits: null,
							unlimited: null,
							balance: null,
						},
						resetCredits: { known: false, value: null },
						unclassifiedWindows: 0,
					},
				],
			}),
			quotaConfigPath: join(tmpdir(), "fly2688-missing-quota-config.json"),
		});

		expect(snapshot.quota.codex.source).toBe("codex-accounts.json");
		expect(snapshot.quota.codex.activeAccount).toBe("personal");
		expect(snapshot.quota.codex.unavailable).toEqual([]);
		expect(snapshot.quota.codex.accounts?.[0]).toMatchObject({
			name: "personal",
			active: true,
			planType: "pro",
			fiveHPct: 100,
			weeklyPct: 100,
			exhausted: true,
			recoveryAt: "2026-09-23T15:00:00.000Z",
			authUnusable: false,
			ageMinutes: 10,
			stale: false,
		});
		expect(snapshot.quota.codex.accounts?.[1]).toMatchObject({
			name: "shopping",
			active: false,
			weeklyPct: null,
			exhausted: false,
			recoveryAt: null,
			observedAt: null,
			ageMinutes: null,
			stale: null,
			note: "in_use_unshared",
		});
		expect(snapshot.quota.codex.accounts?.[2]).toMatchObject({
			name: "school",
			tokenState: "未探",
			authUnusable: true,
			note: "read_failed",
		});
		expect(JSON.stringify(snapshot)).not.toContain("@");
	});

	it("FLY-2869: never projects exhaustion from a stale or reset-elapsed reading", async () => {
		const window = (usedPercent: number, resetAt: string | null) => ({
			usedPercent,
			windowMinutes: 10080,
			resetAt,
		});
		const account = (
			name: string,
			fields: Record<string, unknown>,
		): Record<string, unknown> => ({
			name,
			registeredProfile: name,
			authHealth: "valid",
			note: null,
			planType: "pro",
			fiveH: null,
			credits: {
				known: false,
				hasCredits: null,
				unlimited: null,
				balance: null,
			},
			resetCredits: { known: false, value: null },
			unclassifiedWindows: 0,
			...fields,
		});
		const snapshot = await buildCapacitySnapshot({
			...base,
			accountStorePath: missingAccountStorePath(),
			codexAccountStorePath: writeCodexAccountStore({
				version: 1,
				generatedAt: "2026-09-21T11:55:00.000Z",
				activeAccount: null,
				accounts: [
					account("school", {
						// 35 minutes old: unknown, whatever it once said.
						observedAt: "2026-09-21T11:25:00.000Z",
						fiveH: {
							usedPercent: 100,
							windowMinutes: 300,
							resetAt: "2026-09-21T11:40:00.000Z",
						},
						weekly: window(100, "2026-09-23T15:00:00.000Z"),
					}),
					account("personal", {
						observedAt: "2026-09-21T11:55:00.000Z",
						weekly: window(100, "2026-09-21T11:59:00.000Z"),
					}),
					account("personal1", {
						authHealth: "refresh_invalid",
						note: "token_revoked",
						observedAt: "2026-09-21T11:25:00.000Z",
						weekly: window(100, "2026-09-23T15:00:00.000Z"),
					}),
					account("personal2", {
						observedAt: "2026-09-21T11:55:00.000Z",
						weekly: window(100, "2026-09-23T15:00:00.000Z"),
					}),
				],
			}),
			quotaConfigPath: join(tmpdir(), "fly2688-missing-quota-config.json"),
		});

		expect(snapshot.quota.codex.staleAfterMinutes).toBe(30);
		const [school, personal, personal1, personal2] =
			snapshot.quota.codex.accounts ?? [];
		expect(school).toMatchObject({
			freshness: "stale",
			stale: true,
			ageMinutes: 35,
			fiveHPct: null,
			weeklyPct: null,
			fiveHResetAt: null,
			weeklyResetAt: "2026-09-23T15:00:00.000Z",
			exhausted: false,
			recoveryAt: null,
			tokenState: "读数过期",
		});
		expect(personal).toMatchObject({
			freshness: "reset_elapsed",
			stale: false,
			weeklyPct: null,
			weeklyResetAt: null,
			exhausted: false,
			recoveryAt: null,
			tokenState: "已过重置待探",
		});
		expect(personal1).toMatchObject({
			freshness: "stale",
			exhausted: false,
			tokenState: "已吊销",
			authUnusable: true,
		});
		expect(personal2).toMatchObject({
			freshness: "fresh",
			weeklyPct: 100,
			exhausted: true,
			recoveryAt: "2026-09-23T15:00:00.000Z",
			tokenState: "打满",
		});
	});

	it("keeps the no-source shape when the Codex store is absent or invalid", async () => {
		for (const codexAccountStorePath of [
			join(mkdtempSync(join(tmpdir(), "fly2688-absent-")), "codex.json"),
			writeCodexAccountStore({ version: 2 }),
		]) {
			const snapshot = await buildCapacitySnapshot({
				...base,
				accountStorePath: missingAccountStorePath(),
				codexAccountStorePath,
				quotaConfigPath: join(tmpdir(), "fly2688-missing-quota-config.json"),
			});
			expect(snapshot.quota.codex).toEqual({
				source: null,
				unavailable: ["structural: codex_no_usage_api"],
			});
		}
	});
});

describe("buildCapacitySnapshot", () => {
	it("projects Claude subscription and prepaid details without secrets", async () => {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: "personal1",
			accounts: [
				{
					name: "personal1",
					quotaExhaustedUntil: null,
					weeklyResetAt: "2026-09-09T00:00:00Z",
					lastObservedAt: "2026-09-08T21:33:20.161Z",
					observedFiveHPct: 24,
					observedSevenDPct: 70,
				},
			],
		});
		writeFileSync(
			join(dirname(accountStorePath), "claude-account-details.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-09-23T00:00:00.000Z",
				accounts: [
					{
						name: "personal1",
						observedAt: "2026-09-23T00:00:00.000Z",
						subscription: "canceled",
						usageStatus: "forbidden:oauth_not_allowed_for_organization",
						prepaid: { known: false, cards: null },
						note: "prepaid_forbidden",
					},
				],
			}),
		);
		writeFileSync(
			join(dirname(accountStorePath), "manual-prepaid.json"),
			JSON.stringify({
				version: 1,
				accounts: [
					{
						account: "personal1",
						confirmedBy: "founder",
						confirmedAt: "2026-09-22T00:00:00.000Z",
						cards: [{ expiresAt: "2026-10-01T00:00:00.000Z" }],
					},
				],
			}),
			{ mode: 0o600 },
		);

		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-23T00:00:00.000Z"),
			accountStorePath,
			readMemoryFreePct: async () => ({
				freePct: 40,
				observedAt: "2026-09-23T00:00:00.000Z",
			}),
			store: {
				getActiveSessions: () => [] as never,
				getFleetPressureHold: () => undefined,
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.quota.claude.accounts[0]).toMatchObject({
			name: "personal1",
			subscriptionStatus: "canceled",
			detailObservedAt: "2026-09-23T00:00:00.000Z",
			usageStatus: "forbidden:oauth_not_allowed_for_organization",
			prepaid: { known: false, cards: null },
			manualPrepaid: {
				account: "personal1",
				confirmedBy: "founder",
			},
		});
		expect(JSON.stringify(snapshot)).not.toContain("accessToken");
	});

	it("does not trust an explicit manual prepaid file outside the configured state directory", async () => {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: "personal1",
			accounts: [
				{
					name: "personal1",
					quotaExhaustedUntil: null,
					weeklyResetAt: null,
					lastObservedAt: null,
					observedFiveHPct: null,
					observedSevenDPct: null,
				},
			],
		});
		const outsideDir = mkdtempSync(join(tmpdir(), "fly2807-outside-manual-"));
		scratch.push(outsideDir);
		const outsidePath = join(outsideDir, "manual-prepaid.json");
		writeFileSync(
			outsidePath,
			JSON.stringify({
				version: 1,
				accounts: [
					{
						account: "personal1",
						confirmedBy: "founder",
						confirmedAt: "2026-09-23T00:00:00.000Z",
						cards: [{ expiresAt: "2026-10-01T00:00:00.000Z" }],
					},
				],
			}),
			{ mode: 0o600 },
		);

		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-23T00:00:00.000Z"),
			accountStorePath,
			claudeManualPrepaidPath: outsidePath,
			readMemoryFreePct: async () => ({
				freePct: 40,
				observedAt: "2026-09-23T00:00:00.000Z",
			}),
			store: {
				getActiveSessions: () => [] as never,
				getFleetPressureHold: () => undefined,
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.quota.claude.accounts[0]).not.toHaveProperty(
			"manualPrepaid",
		);
	});

	it("combines current machine, brake, runner, and sanitized quota facts", async () => {
		const accountStorePath = writeAccountStore({
			generation: 7,
			activeAccount: "personal",
			accounts: [
				{
					name: "personal",
					quotaExhaustedUntil: "2026-09-04T01:00:00Z",
					weeklyResetAt: "2026-09-08T02:00:00Z",
					lastObservedAt: "2026-09-03T02:00:00Z",
					observedFiveHPct: 9,
					observedSevenDPct: 30,
					authExpired: false,
					identity: {
						email: "private@example.com",
						setAt: "2026-09-01T00:00:00Z",
					},
					modelCaps: { opus: { until: "2026-09-04T00:00:00Z" } },
					identityMismatch: { actualDigest: "secret", markedAt: "x" },
					switchCooldownUntil: "2026-09-04T00:00:00Z",
				},
				{
					name: "business",
					retiresAt: "2026-09-14T00:00:00-07:00",
					quotaExhaustedUntil: null,
					weeklyResetAt: null,
					lastObservedAt: "2026-09-03T01:59:00Z",
					observedFiveHPct: 11,
					observedSevenDPct: 20,
					profileVerifyFailed: true,
				},
			],
		});
		const now = Date.parse("2026-09-03T04:00:00.000Z");

		const snapshot = await buildCapacitySnapshot({
			now: () => now,
			readDataDisk: () => ({
				disk_avail_gb: 20,
				disk: {
					volume: "/System/Volumes/Data",
					availBytes: 20_000_000_000,
					observedAt: "2026-09-03T03:59:58.000Z",
				},
			}),
			accountStorePath,
			quotaConfigPath: join(tmpdir(), "fly2144-missing-quota-config.json"),
			readMemoryFreePct: vi.fn(async () => ({
				freePct: 14,
				observedAt: "2026-09-03T03:59:59.000Z",
			})),
			admission: {
				probe: () => ({
					load1: 18,
					cpuCount: 18,
					perCore: 1,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () =>
					[
						{ status: "running", project_name: "flywheel" },
						{ status: "awaiting_review", project_name: "flywheel" },
						{ status: "ship_parked", project_name: "growth" },
					] as never,
				getFleetPressureHold: () => ({
					set_by: "swap-sensor",
					set_at: "2026-09-03T03:58:00Z",
					watermark: "7.1% free",
				}),
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot).toEqual({
			schemaVersion: 1,
			generatedAt: "2026-09-03T04:00:00.000Z",
			disk_avail_gb: 20,
			disk: {
				volume: "/System/Volumes/Data",
				availBytes: 20_000_000_000,
				observedAt: "2026-09-03T03:59:58.000Z",
			},
			memory: {
				source: "memory_pressure",
				freePct: 14,
				observedAt: "2026-09-03T03:59:59.000Z",
				tightBelowPct: 15,
				tight: true,
			},
			load: {
				load1: 18,
				cpuCount: 18,
				perCore: 1,
				thresholdPerCore: 8,
				observedAt: "2026-09-03T04:00:00.000Z",
			},
			brakes: {
				pressureHold: {
					active: true,
					setBy: "swap-sensor",
					setAt: "2026-09-03T03:58:00.000Z",
					watermark: "7.1% free",
				},
				admissionPause: { active: false, remainingSeconds: 0 },
				admission: { admit: true },
				observedAt: "2026-09-03T04:00:00.000Z",
			},
			runners: {
				running: 1,
				parked: 2,
				total: 3,
				byProject: {
					flywheel: { running: 1, parked: 1 },
					growth: { running: 0, parked: 1 },
				},
				observedAt: "2026-09-03T04:00:00.000Z",
			},
			quota: {
				claude: {
					source: "claude-accounts.json",
					activeAccount: "personal",
					staleAfterMinutes: 120,
					accounts: [
						{
							name: "personal",
							active: true,
							fiveHPct: 9,
							sevenDPct: 30,
							observedAt: "2026-09-03T02:00:00.000Z",
							ageMinutes: 120,
							stale: false,
							weeklyResetAt: "2026-09-08T02:00:00.000Z",
							exhaustedUntil: "2026-09-04T01:00:00.000Z",
							authUnusable: false,
						},
						{
							name: "business",
							retiresAt: "2026-09-14T07:00:00.000Z",
							active: false,
							fiveHPct: 11,
							sevenDPct: 20,
							observedAt: "2026-09-03T01:59:00.000Z",
							ageMinutes: 121,
							stale: true,
							weeklyResetAt: null,
							exhaustedUntil: null,
							authUnusable: true,
						},
					],
				},
				codex: {
					source: null,
					unavailable: ["structural: codex_no_usage_api"],
				},
			},
		});
		const serialized = JSON.stringify(snapshot);
		for (const privateValue of [
			"private@example.com",
			"modelCaps",
			"identityMismatch",
			"switchCooldownUntil",
		]) {
			expect(serialized).not.toContain(privateValue);
		}
	});

	it("isolates a throwing memory sampler and still returns the other facts", async () => {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: null,
			accounts: [],
		});
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T04:10:00.000Z"),
			accountStorePath,
			readMemoryFreePct: async () => {
				throw new Error("sensor down");
			},
			admission: {
				probe: () => ({
					load1: 4,
					cpuCount: 2,
					perCore: 2,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () => [],
				getFleetPressureHold: () => undefined,
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.memory).toEqual({
			source: "memory_pressure",
			freePct: null,
			observedAt: null,
			tightBelowPct: 15,
			tight: null,
			unavailable: ["transient: memory_pressure_timeout"],
		});
		expect(snapshot.load.load1).toBe(4);
		expect(snapshot.runners.total).toBe(0);
	});

	it("isolates an unavailable Data-volume reading without hiding other facts", async () => {
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T04:10:00.000Z"),
			accountStorePath: missingAccountStorePath(),
			readDataDisk: () => {
				throw new Error("disk sensor down");
			},
			readMemoryFreePct: async () => ({
				freePct: 44,
				observedAt: "2026-09-03T04:10:00.000Z",
			}),
			store: {
				getActiveSessions: () => [],
				getFleetPressureHold: () => undefined,
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.disk_avail_gb).toBeNull();
		expect(snapshot.disk).toEqual({
			volume: "/System/Volumes/Data",
			availBytes: null,
			observedAt: null,
			unavailable: ["transient: data_volume_unreadable"],
		});
		expect(snapshot.memory.freePct).toBe(44);
		expect(snapshot.runners.total).toBe(0);
	});

	it("emits every capacity diagnostic as an array", async () => {
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T04:15:00.000Z"),
			accountStorePath: missingAccountStorePath(),
			readMemoryFreePct: async () => {
				throw new Error("sensor down");
			},
			store: {
				getActiveSessions: () => {
					throw new Error("session store down");
				},
				getFleetPressureHold: () => {
					throw new Error("pressure store down");
				},
				getAdmissionPause: () => {
					throw new Error("pause store down");
				},
			},
		});

		expect(snapshot.memory.unavailable).toEqual([
			"transient: memory_pressure_timeout",
		]);
		expect(snapshot.load.unavailable).toEqual([
			"structural: admission_controller_absent",
		]);
		expect(snapshot.brakes.pressureHold.unavailable).toEqual([
			"transient: state_store_unreadable",
		]);
		expect(snapshot.brakes.admissionPause.unavailable).toEqual([
			"transient: state_store_unreadable",
		]);
		expect(snapshot.brakes.admission.unavailable).toEqual([
			"structural: admission_controller_absent",
		]);
		expect(snapshot.runners.unavailable).toEqual([
			"transient: session_store_unreadable",
		]);
		expect(snapshot.quota.claude.unavailable).toEqual([
			"structural: account_pool_not_provisioned",
		]);
		expect(snapshot.quota.codex.unavailable).toEqual([
			"structural: codex_no_usage_api",
		]);
	});

	it("normalizes unavailable or malformed memory readings into a closed cell", async () => {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: null,
			accounts: [],
		});
		const cases = [
			[
				{
					freePct: null,
					observedAt: "2026-09-03T04:10:00.000Z",
					unavailable: "transient: memory_pressure_exit_42",
				},
				"transient: memory_pressure_exit_42",
			],
			[
				{
					freePct: "44",
					observedAt: "private@example.com",
					unavailable: "transient: suggest",
				},
				"transient: memory_pressure_parse_failed",
			],
		] as const;

		for (const [reading, unavailable] of cases) {
			const snapshot = await buildCapacitySnapshot({
				now: () => Date.parse("2026-09-03T04:10:00.000Z"),
				accountStorePath,
				readMemoryFreePct: async () => reading as never,
				admission: {
					probe: () => ({
						load1: 4,
						cpuCount: 2,
						perCore: 2,
						thresholdPerCore: 8,
						decision: { admit: true },
					}),
				},
				store: {
					getActiveSessions: () => [],
					getFleetPressureHold: () => undefined,
					getAdmissionPause: () => undefined,
				},
			});

			expect(snapshot.memory).toEqual({
				source: "memory_pressure",
				freePct: null,
				observedAt: null,
				tightBelowPct: 15,
				tight: null,
				unavailable: [unavailable],
			});
		}
	});

	it("marks absent or throwing admission probes without losing store-backed brakes", async () => {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: null,
			accounts: [],
		});
		const cases = [
			[undefined, "structural: admission_controller_absent"],
			[
				{
					probe: () => {
						throw new Error("load unavailable");
					},
				},
				"transient: load_probe_failed",
			],
		] as const;

		for (const [admission, unavailable] of cases) {
			const snapshot = await buildCapacitySnapshot({
				now: () => Date.parse("2026-09-03T04:20:00.000Z"),
				accountStorePath,
				readMemoryFreePct: async () => ({
					freePct: 60,
					observedAt: "2026-09-03T04:20:00.000Z",
				}),
				admission,
				store: {
					getActiveSessions: () => [],
					getFleetPressureHold: () => undefined,
					getAdmissionPause: () => undefined,
				},
			});

			expect(snapshot.load).toEqual({
				load1: null,
				cpuCount: null,
				perCore: null,
				thresholdPerCore: null,
				observedAt: null,
				unavailable: [unavailable],
			});
			expect(snapshot.brakes).toMatchObject({
				pressureHold: { active: false },
				admissionPause: { active: false, remainingSeconds: 0 },
				admission: { admit: null, unavailable: [unavailable] },
				observedAt: "2026-09-03T04:20:00.000Z",
			});
		}
	});

	it("isolates a throwing pressure-hold read from the remaining store facts", async () => {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: null,
			accounts: [],
		});
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T04:30:00.000Z"),
			accountStorePath,
			readMemoryFreePct: async () => ({
				freePct: 70,
				observedAt: "2026-09-03T04:30:00.000Z",
			}),
			admission: {
				probe: () => ({
					load1: 2,
					cpuCount: 4,
					perCore: 0.5,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () =>
					[{ status: "running", project_name: "flywheel" }] as never,
				getFleetPressureHold: () => {
					throw new Error("database unavailable");
				},
				getAdmissionPause: () => ({
					active: true,
					remainingSeconds: 90,
				}),
			},
		});

		expect(snapshot.brakes.pressureHold).toEqual({
			active: null,
			unavailable: ["transient: state_store_unreadable"],
		});
		expect(snapshot.brakes.admissionPause).toEqual({
			active: true,
			remainingSeconds: 90,
		});
		expect(snapshot.runners.total).toBe(1);
	});

	it("normalizes SQLite UTC pressure-hold timestamps to ISO instants", async () => {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: null,
			accounts: [],
		});
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T04:57:00.000Z"),
			accountStorePath,
			readMemoryFreePct: async () => ({
				freePct: 70,
				observedAt: "2026-09-03T04:57:00.000Z",
			}),
			admission: {
				probe: () => ({
					load1: 2,
					cpuCount: 4,
					perCore: 0.5,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () => [],
				getFleetPressureHold: () => ({
					set_by: "swap-sensor",
					set_at: "2026-09-03 04:56:26",
					watermark: "7.1% free",
				}),
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.brakes.pressureHold).toMatchObject({
			active: true,
			setAt: "2026-09-03T04:56:26.000Z",
		});
	});

	it("degrades only the pressure-hold cell when its stored timestamp is unreadable", async () => {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: null,
			accounts: [],
		});
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T04:57:00.000Z"),
			accountStorePath,
			readMemoryFreePct: async () => ({
				freePct: 70,
				observedAt: "2026-09-03T04:57:00.000Z",
			}),
			admission: {
				probe: () => ({
					load1: 2,
					cpuCount: 4,
					perCore: 0.5,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () => [],
				getFleetPressureHold: () => ({
					set_by: "swap-sensor",
					set_at: "not-a-timestamp",
					watermark: "7.1% free",
				}),
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.brakes.pressureHold).toEqual({
			active: null,
			unavailable: ["transient: state_store_unreadable"],
		});
		expect(snapshot.memory.freePct).toBe(70);
		expect(snapshot.load.perCore).toBe(0.5);
		expect(snapshot.runners.total).toBe(0);
	});

	it("isolates a throwing admission-pause read from the remaining store facts", async () => {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: null,
			accounts: [],
		});
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T04:40:00.000Z"),
			accountStorePath,
			readMemoryFreePct: async () => ({
				freePct: 70,
				observedAt: "2026-09-03T04:40:00.000Z",
			}),
			admission: {
				probe: () => ({
					load1: 2,
					cpuCount: 4,
					perCore: 0.5,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () => [],
				getFleetPressureHold: () => ({
					set_by: "swap-sensor",
					set_at: "2026-09-03T04:39:00.000Z",
					watermark: null,
				}),
				getAdmissionPause: () => {
					throw new Error("database unavailable");
				},
			},
		});

		expect(snapshot.brakes.admissionPause).toEqual({
			active: null,
			remainingSeconds: null,
			unavailable: ["transient: state_store_unreadable"],
		});
		expect(snapshot.brakes.pressureHold).toMatchObject({ active: true });
		expect(snapshot.runners.total).toBe(0);
	});

	it("isolates a throwing session read and marks all runner counts unavailable", async () => {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: null,
			accounts: [],
		});
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T04:50:00.000Z"),
			accountStorePath,
			readMemoryFreePct: async () => ({
				freePct: 70,
				observedAt: "2026-09-03T04:50:00.000Z",
			}),
			admission: {
				probe: () => ({
					load1: 2,
					cpuCount: 4,
					perCore: 0.5,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () => {
					throw new Error("database unavailable");
				},
				getFleetPressureHold: () => undefined,
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.runners).toEqual({
			running: null,
			parked: null,
			total: null,
			byProject: null,
			observedAt: null,
			unavailable: ["transient: session_store_unreadable"],
		});
		expect(snapshot.brakes.pressureHold).toEqual({ active: false });
	});

	it("distinguishes an unprovisioned account pool from unreadable stores", async () => {
		const cases = [
			[missingAccountStorePath(), "structural: account_pool_not_provisioned"],
			[
				writeRawAccountStore("{not-json"),
				"transient: account_store_unreadable",
			],
			[
				writeAccountStore({ generation: "bad", accounts: [] }),
				"transient: account_store_unreadable",
			],
		] as const;

		for (const [accountStorePath, unavailable] of cases) {
			const snapshot = await buildCapacitySnapshot({
				now: () => Date.parse("2026-09-03T05:00:00.000Z"),
				accountStorePath,
				readMemoryFreePct: async () => ({
					freePct: 70,
					observedAt: "2026-09-03T05:00:00.000Z",
				}),
				admission: {
					probe: () => ({
						load1: 2,
						cpuCount: 4,
						perCore: 0.5,
						thresholdPerCore: 8,
						decision: { admit: true },
					}),
				},
				store: {
					getActiveSessions: () => [],
					getFleetPressureHold: () => undefined,
					getAdmissionPause: () => undefined,
				},
			});

			expect(snapshot.quota.claude).toEqual({
				source: "claude-accounts.json",
				activeAccount: null,
				staleAfterMinutes: 120,
				accounts: [],
				unavailable: [unavailable],
			});
		}
	});

	it("rejects unsafe or duplicate account aliases for the whole Claude quota cell", async () => {
		const invalidStores = [
			{
				generation: 1,
				activeAccount: "private@example.com",
				accounts: [
					{
						name: "private@example.com",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
				],
			},
			{
				generation: 1,
				activeAccount: "shared",
				accounts: [
					{
						name: "shared",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
					{
						name: "shared",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
				],
			},
		];

		for (const storeValue of invalidStores) {
			const snapshot = await buildCapacitySnapshot({
				now: () => Date.parse("2026-09-03T05:10:00.000Z"),
				accountStorePath: writeAccountStore(storeValue),
				readMemoryFreePct: async () => ({
					freePct: 70,
					observedAt: "2026-09-03T05:10:00.000Z",
				}),
				admission: {
					probe: () => ({
						load1: 2,
						cpuCount: 4,
						perCore: 0.5,
						thresholdPerCore: 8,
						decision: { admit: true },
					}),
				},
				store: {
					getActiveSessions: () => [],
					getFleetPressureHold: () => undefined,
					getAdmissionPause: () => undefined,
				},
			});

			expect(snapshot.quota.claude).toMatchObject({
				activeAccount: null,
				accounts: [],
				unavailable: ["transient: account_store_invalid"],
			});
			expect(JSON.stringify(snapshot)).not.toContain("@");
		}
	});

	it("drops an account with a non-boolean auth flag and keeps valid accounts", async () => {
		const badAlias = "bad-auth-entry";
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T05:20:00.000Z"),
			accountStorePath: writeAccountStore({
				generation: 1,
				activeAccount: "good",
				accounts: [
					{
						name: "good",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
					{
						name: badAlias,
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
						authExpired: "true",
					},
				],
			}),
			readMemoryFreePct: async () => ({
				freePct: 70,
				observedAt: "2026-09-03T05:20:00.000Z",
			}),
			admission: {
				probe: () => ({
					load1: 2,
					cpuCount: 4,
					perCore: 0.5,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () => [],
				getFleetPressureHold: () => undefined,
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.quota.claude).toMatchObject({
			activeAccount: "good",
			unavailable: ["transient: account_entry_invalid"],
		});
		expect(snapshot.quota.claude.accounts).toHaveLength(1);
		expect(snapshot.quota.claude.accounts[0]).toMatchObject({
			name: "good",
			active: true,
		});
		expect(JSON.stringify(snapshot)).not.toContain(badAlias);
	});

	it("reports a terminally unavailable Claude profile as structural capacity loss", async () => {
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T05:25:00.000Z"),
			accountStorePath: writeAccountStore({
				generation: 2,
				activeAccount: "business",
				accounts: [
					{
						name: "business",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
					{
						name: "personal1",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
						unavailable: {
							reason: "profile_canceled",
							markedAt: "2026-09-03T05:00:00.000Z",
							evidence: "profile_subscription",
							markedBy: "quota-monitor",
						},
					},
				],
			}),
			readMemoryFreePct: async () => ({
				freePct: 70,
				observedAt: "2026-09-03T05:25:00.000Z",
			}),
			admission: {
				probe: () => ({
					load1: 2,
					cpuCount: 4,
					perCore: 0.5,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () => [],
				getFleetPressureHold: () => undefined,
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.quota.claude.unavailable).toContain(
			"structural: account_unavailable:personal1",
		);
		expect(
			snapshot.quota.claude.accounts.find(
				(account) => account.name === "personal1",
			)?.authUnusable,
		).toBe(true);
	});

	it("clears an active account that is missing or filtered from the pool", async () => {
		const cases = [
			{
				activeAccount: "missing-account",
				accounts: [
					{
						name: "good",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
				],
			},
			{
				activeAccount: "bad-active",
				accounts: [
					{
						name: "good",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
					{
						name: "bad-active",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
						profileVerifyFailed: "true",
					},
				],
			},
		];

		for (const storeValue of cases) {
			const snapshot = await buildCapacitySnapshot({
				now: () => Date.parse("2026-09-03T05:30:00.000Z"),
				accountStorePath: writeAccountStore({ generation: 1, ...storeValue }),
				readMemoryFreePct: async () => ({
					freePct: 70,
					observedAt: "2026-09-03T05:30:00.000Z",
				}),
				admission: {
					probe: () => ({
						load1: 2,
						cpuCount: 4,
						perCore: 0.5,
						thresholdPerCore: 8,
						decision: { admit: true },
					}),
				},
				store: {
					getActiveSessions: () => [],
					getFleetPressureHold: () => undefined,
					getAdmissionPause: () => undefined,
				},
			});

			expect(snapshot.quota.claude).toMatchObject({
				activeAccount: null,
			});
			expect(snapshot.quota.claude.unavailable).toContain(
				"transient: account_store_invalid",
			);
			expect(snapshot.quota.claude.accounts).toHaveLength(1);
			expect(snapshot.quota.claude.accounts[0]).toMatchObject({
				name: "good",
				active: false,
			});
		}
	});

	it("preserves every diagnostic when filtering also invalidates the active account", async () => {
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T05:35:00.000Z"),
			accountStorePath: writeAccountStore({
				generation: 1,
				activeAccount: "bad-active",
				accounts: [
					{
						name: "good",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
					{
						name: "bad-active",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
						authExpired: "true",
					},
				],
			}),
			readMemoryFreePct: async () => ({
				freePct: 70,
				observedAt: "2026-09-03T05:35:00.000Z",
			}),
			admission: {
				probe: () => ({
					load1: 2,
					cpuCount: 4,
					perCore: 0.5,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () => [],
				getFleetPressureHold: () => undefined,
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.quota.claude).toMatchObject({
			activeAccount: null,
			unavailable: [
				"transient: account_entry_invalid",
				"transient: account_store_invalid",
			],
		});
		expect(snapshot.quota.claude.accounts).toHaveLength(1);
		expect(snapshot.quota.claude.accounts[0]).toMatchObject({
			name: "good",
			active: false,
		});
	});

	it("normalizes quota values and refuses to report future observations as fresh", async () => {
		const futureObservation = "2026-09-03T05:41:01.000Z";
		const resetLeak = "private@example.com\nnext";
		const exhaustedLeak = "secret-token";
		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-03T05:40:00.000Z"),
			accountStorePath: writeAccountStore({
				generation: 1,
				activeAccount: "personal",
				accounts: [
					{
						name: "personal",
						quotaExhaustedUntil: exhaustedLeak,
						weeklyResetAt: resetLeak,
						lastObservedAt: futureObservation,
						observedFiveHPct: -1,
						observedSevenDPct: 101,
					},
				],
			}),
			quotaConfigPath: writeAccountStore({
				...DEFAULT_QUOTA_MONITOR_CONFIG,
				candidateSweepMinutes: 30,
			}),
			readMemoryFreePct: async () => ({
				freePct: 70,
				observedAt: "2026-09-03T05:40:00.000Z",
			}),
			admission: {
				probe: () => ({
					load1: 2,
					cpuCount: 4,
					perCore: 0.5,
					thresholdPerCore: 8,
					decision: { admit: true },
				}),
			},
			store: {
				getActiveSessions: () => [],
				getFleetPressureHold: () => undefined,
				getAdmissionPause: () => undefined,
			},
		});

		expect(snapshot.quota.claude.staleAfterMinutes).toBe(60);
		expect(snapshot.quota.claude.accounts).toEqual([
			{
				name: "personal",
				active: true,
				fiveHPct: null,
				sevenDPct: null,
				observedAt: null,
				ageMinutes: null,
				stale: null,
				weeklyResetAt: null,
				exhaustedUntil: null,
				authUnusable: false,
			},
		]);
		const serialized = JSON.stringify(snapshot);
		for (const leakedValue of [futureObservation, resetLeak, exhaustedLeak]) {
			expect(serialized).not.toContain(leakedValue);
		}
	});
});

describe("FLY-2864 — live tier, reset cards and Codex subscription projection", () => {
	const base = {
		now: () => Date.parse("2026-09-24T23:30:00.000Z"),
		readMemoryFreePct: async () => ({
			freePct: 40,
			observedAt: "2026-09-24T23:30:00.000Z",
		}),
		store: {
			getActiveSessions: () => [] as never,
			getFleetPressureHold: () => undefined,
			getAdmissionPause: () => undefined,
		},
		quotaConfigPath: join(tmpdir(), "fly2864-missing-quota-config.json"),
	};

	function claudeFixture(detailAccounts: unknown[]) {
		const accountStorePath = writeAccountStore({
			generation: 1,
			activeAccount: "business",
			accounts: ["business", "school"].map((name) => ({
				name,
				quotaExhaustedUntil: null,
				weeklyResetAt: "2026-09-29T16:00:00.000Z",
				lastObservedAt: "2026-09-24T23:00:00.000Z",
				observedFiveHPct: 5,
				observedSevenDPct: 20,
			})),
		});
		const dir = dirname(accountStorePath);
		for (const [name, tier] of [
			["business", "default_claude_max_5x"],
			["school", "default_claude_max_20x"],
		] as const) {
			const profile = join(dir, "claude-profiles", name);
			mkdirSync(profile, { recursive: true });
			writeFileSync(
				join(profile, ".credentials.json"),
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "secret-token",
						subscriptionType: "max",
						rateLimitTier: tier,
					},
				}),
			);
		}
		writeFileSync(
			join(dir, "claude-account-details.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-09-24T23:30:00.000Z",
				accounts: detailAccounts,
			}),
		);
		return accountStorePath;
	}

	const detail = (name: string, extra: Record<string, unknown>) => ({
		name,
		observedAt: "2026-09-24T23:30:00.000Z",
		subscription: "active",
		usageStatus: "ok",
		prepaid: { known: true, cards: null },
		note: null,
		...extra,
	});

	it("prefers the live profile tier over the login-time credential cache", async () => {
		const snapshot = await buildCapacitySnapshot({
			...base,
			accountStorePath: claudeFixture([
				detail("business", {
					tier: {
						subscriptionType: "max",
						rateLimitTier: "default_claude_max_20x",
					},
				}),
			]),
		});
		const byName = Object.fromEntries(
			snapshot.quota.claude.accounts.map((account) => [account.name, account]),
		);
		expect(byName.business?.subscriptionTier).toEqual({
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_20x",
		});
		// No live tier: the credential cache is still the fallback.
		expect(byName.school?.subscriptionTier).toEqual({
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_20x",
		});
		expect(JSON.stringify(snapshot)).not.toContain("secret-token");
	});

	it("falls back to the credential cache when the live tier is absent or null", async () => {
		for (const extra of [{}, { tier: null }]) {
			const snapshot = await buildCapacitySnapshot({
				...base,
				accountStorePath: claudeFixture([detail("business", extra)]),
			});
			expect(
				snapshot.quota.claude.accounts.find((a) => a.name === "business")
					?.subscriptionTier,
			).toEqual({
				subscriptionType: "max",
				rateLimitTier: "default_claude_max_5x",
			});
		}
	});

	it("passes reset cards through only when the detail store has them", async () => {
		const resetGrants = {
			known: true,
			reason: null,
			grants: [
				{
					resetsLeft: 1,
					resetsTotal: 1,
					endsAt: "2026-10-22T16:00:00.000Z",
				},
			],
		};
		const snapshot = await buildCapacitySnapshot({
			...base,
			accountStorePath: claudeFixture([
				detail("business", { resetGrants }),
				detail("school", {}),
			]),
		});
		const [business, school] = ["business", "school"].map((name) =>
			snapshot.quota.claude.accounts.find((a) => a.name === name),
		);
		expect(business?.resetGrants).toEqual(resetGrants);
		expect(school).not.toHaveProperty("resetGrants");
	});

	function codexFixture(subscriptions: unknown) {
		const dir = mkdtempSync(join(tmpdir(), "fly2864-codex-capacity-"));
		scratch.push(dir);
		const accountStorePath = join(dir, "claude-accounts.json");
		const quotaAccount = (name: string, identityKey?: string) => ({
			name,
			registeredProfile: name,
			...(identityKey ? { identityKey } : {}),
			observedAt: "2026-09-24T23:00:00.000Z",
			authHealth: "valid",
			note: null,
			planType: "pro",
			fiveH: null,
			weekly: {
				usedPercent: 40,
				windowMinutes: 10080,
				resetAt: "2026-09-29T16:00:00.000Z",
			},
			credits: {
				known: false,
				hasCredits: null,
				unlimited: null,
				balance: null,
			},
			resetCredits: { known: false, value: null },
			unclassifiedWindows: 0,
		});
		writeFileSync(
			join(dir, "codex-accounts.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-09-24T23:00:00.000Z",
				activeAccount: "business",
				accounts: [
					quotaAccount("business", "a".repeat(64)),
					quotaAccount("school", "b".repeat(64)),
					quotaAccount("shopping", "c".repeat(64)),
					quotaAccount("broken"),
				],
			}),
		);
		if (subscriptions !== undefined) {
			writeFileSync(
				join(dir, "codex-subscriptions.json"),
				typeof subscriptions === "string"
					? subscriptions
					: JSON.stringify(subscriptions),
			);
		}
		return accountStorePath;
	}

	const subscriptionStore = {
		version: 1,
		generatedAt: "2026-09-24T23:30:00.000Z",
		accounts: [
			{
				name: "business",
				identityKey: "a".repeat(64),
				observedAt: "2026-09-24T23:30:00.000Z",
				status: "active",
				renewsAt: "2026-10-23T03:59:39.000Z",
				endsAt: null,
				note: null,
			},
			{
				// A different login now sits in the school slot.
				name: "school",
				identityKey: "f".repeat(64),
				observedAt: "2026-09-24T23:30:00.000Z",
				status: "active",
				renewsAt: "2026-10-03T23:37:58.000Z",
				endsAt: null,
				note: null,
			},
			{
				name: "broken",
				observedAt: null,
				status: "unknown",
				renewsAt: null,
				endsAt: null,
				note: "problem:invalid_credential",
			},
		],
	};

	it("projects a subscription only onto the same identity, and orphans only as a note", async () => {
		const snapshot = await buildCapacitySnapshot({
			...base,
			accountStorePath: codexFixture(subscriptionStore),
		});
		const byName = Object.fromEntries(
			(snapshot.quota.codex.accounts ?? []).map((a) => [a.name, a]),
		);
		expect(byName.business?.subscription).toEqual({
			status: "active",
			renewsAt: "2026-10-23T03:59:39.000Z",
			endsAt: null,
			observedAt: "2026-09-24T23:30:00.000Z",
			note: null,
		});
		expect(byName.school).not.toHaveProperty("subscription");
		expect(byName.shopping).not.toHaveProperty("subscription");
		expect(byName.broken?.subscription).toEqual({
			status: "unknown",
			renewsAt: null,
			endsAt: null,
			observedAt: null,
			note: "problem:invalid_credential",
		});
		expect(JSON.stringify(snapshot)).not.toContain("a".repeat(64));
	});

	it("renders a kept old subscription store without showing past dates (whole read failed)", async () => {
		// The refresh keeps the previous file when the subscription read or write
		// throws, so its rows still say note:null days later.
		const snapshot = await buildCapacitySnapshot({
			...base,
			now: () => Date.parse("2026-10-21T18:00:00.000Z"),
			accountStorePath: codexFixture({
				version: 1,
				generatedAt: "2026-10-01T00:00:00.000Z",
				accounts: [
					{
						name: "business",
						identityKey: "a".repeat(64),
						observedAt: "2026-10-01T00:00:00.000Z",
						status: "canceled",
						renewsAt: null,
						endsAt: "2026-10-19T04:02:27.000Z",
						note: null,
					},
					{
						name: "school",
						identityKey: "b".repeat(64),
						observedAt: "2026-10-01T00:00:00.000Z",
						status: "active",
						renewsAt: "2026-10-03T23:37:58.000Z",
						endsAt: null,
						note: null,
					},
					{
						name: "shopping",
						identityKey: "c".repeat(64),
						observedAt: "2026-10-01T00:00:00.000Z",
						status: "active",
						renewsAt: "2026-10-23T03:59:39.000Z",
						endsAt: null,
						note: null,
					},
				],
			}),
		});
		const next = Object.fromEntries(
			buildAccountQuotaView(snapshot).codex.map((row) => [
				row.name,
				row.nextCharge.display,
			]),
		);
		expect(next).toMatchObject({
			business: "读不到（读数已过期）",
			school: "读不到（读数已过期）",
			shopping: "10/22 周四",
		});
	});

	it("keeps the snapshot intact when the subscription store is missing or corrupt", async () => {
		for (const subscriptions of [undefined, "{not json", { version: 9 }]) {
			const snapshot = await buildCapacitySnapshot({
				...base,
				accountStorePath: codexFixture(subscriptions),
			});
			expect(snapshot.quota.codex.source).toBe("codex-accounts.json");
			for (const account of snapshot.quota.codex.accounts ?? []) {
				expect(account).not.toHaveProperty("subscription");
			}
		}
	});
});

describe("FLY-2864 — research responses end to end", () => {
	it("turns the verbatim provider samples into the page's card and next-charge cells", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2864-pipeline-"));
		scratch.push(dir);
		const accountStorePath = join(dir, "claude-accounts.json");
		writeFileSync(
			accountStorePath,
			JSON.stringify({
				generation: 1,
				activeAccount: "business",
				accounts: [
					{
						name: "business",
						quotaExhaustedUntil: null,
						weeklyResetAt: "2026-09-29T16:00:00.000Z",
						lastObservedAt: "2026-09-24T23:20:00.000Z",
						observedFiveHPct: 5,
						observedSevenDPct: 20,
					},
				],
			}),
		);
		// research.md §2 — business usage, cedar_ember block verbatim.
		const resetGrants = parseClaudeResetGrants(
			{
				cedar_ember: {
					eligible: true,
					ineligible_reason: null,
					at_limit: false,
					exhausted: [],
					grants: [
						{
							id: "<redacted>",
							label:
								"Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
							resets_total: 1,
							resets_left: 1,
							starts_at: "2026-09-22T16:00:00+00:00",
							ends_at: "2026-10-22T16:00:00+00:00",
							clears: ["five_hour", "seven_day", "seven_day_overage_included"],
							paused: false,
							usable_now: true,
						},
					],
					next_grant_id: "opus55-launch-promax-20260921",
					weekly_resets_at: "2026-10-01T02:00:00+00:00",
					event_props: {
						surface: "claude_code_cli",
						tier: "claude_max_20x",
						billing_period: "unknown",
					},
				},
			},
			true,
		);
		const detailPath = join(dir, "claude-account-details.json");
		writeClaudeAccountDetailStore(detailPath, {
			version: 1,
			generatedAt: "2026-09-24T23:25:00.000Z",
			accounts: [
				{
					name: "business",
					observedAt: "2026-09-24T23:25:00.000Z",
					subscription: "active",
					usageStatus: "ok",
					prepaid: { known: true, cards: null },
					tier: {
						subscriptionType: "max",
						rateLimitTier: "default_claude_max_20x",
					},
					resetGrants,
					note: null,
				},
			],
		});
		expect(readClaudeAccountDetailStore(detailPath)).not.toBeNull();
		writeFileSync(
			join(dir, "codex-accounts.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-09-24T23:20:00.000Z",
				activeAccount: "business",
				accounts: [
					{
						name: "business",
						registeredProfile: "business",
						identityKey: "a".repeat(64),
						observedAt: "2026-09-24T23:20:00.000Z",
						authHealth: "valid",
						note: null,
						planType: "pro",
						fiveH: null,
						weekly: {
							usedPercent: 30,
							windowMinutes: 10080,
							resetAt: "2026-09-30T16:00:00.000Z",
						},
						credits: {
							known: false,
							hasCredits: null,
							unlimited: null,
							balance: null,
						},
						resetCredits: { known: false, value: null },
						unclassifiedWindows: 0,
					},
				],
			}),
		);
		// research.md §3 — business subscriptions response verbatim.
		const parsed = parseCodexSubscriptionResponse({
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				entitlement: {
					has_active_subscription: true,
					subscription_plan: "chatgptpro",
					expires_at: "2026-10-23T09:59:39+00:00",
					renews_at: "2026-10-23T03:59:39+00:00",
					cancels_at: null,
					billing_period: "monthly",
					is_delinquent: false,
				},
				plan_type: "pro",
				will_renew: true,
				active_until: "2026-10-23T03:59:39Z",
				active_start: "2026-08-19T15:39:26Z",
				cancellation_outcome: null,
			}),
		});
		expect(parsed).toEqual({
			ok: { status: "active", renewsAt: "2026-10-23T03:59:39.000Z" },
		});
		const subscriptionsPath = join(dir, "codex-subscriptions.json");
		writeCodexSubscriptionStore(subscriptionsPath, {
			version: 1,
			generatedAt: "2026-09-24T23:30:00.000Z",
			accounts: [
				{
					name: "business",
					identityKey: "a".repeat(64),
					observedAt: "2026-09-24T23:30:00.000Z",
					status: "active",
					renewsAt:
						"ok" in parsed && parsed.ok.status === "active"
							? parsed.ok.renewsAt
							: null,
					endsAt: null,
					note: null,
				},
			],
		});
		expect(readCodexSubscriptionStore(subscriptionsPath)).not.toBeNull();

		const snapshot = await buildCapacitySnapshot({
			now: () => Date.parse("2026-09-24T23:30:00.000Z"),
			accountStorePath,
			claudeProfilesDir: join(dir, "claude-profiles"),
			quotaConfigPath: join(dir, "missing-quota-config.json"),
			readMemoryFreePct: async () => ({
				freePct: 40,
				observedAt: "2026-09-24T23:30:00.000Z",
			}),
			store: {
				getActiveSessions: () => [] as never,
				getFleetPressureHold: () => undefined,
				getAdmissionPause: () => undefined,
			},
		});
		const html = renderAccountQuotaPageHtml(buildAccountQuotaView(snapshot));
		const rowOf = (section: "claude" | "codex") =>
			html
				.split(`provider-${section}`)[1]
				?.split("</tr>")
				.find((tr) => tr.includes("business</div>")) ?? "";
		expect(rowOf("claude")).toContain(
			'<div class="account-tier">Max 20x</div>',
		);
		expect(rowOf("claude")).toContain(
			'<span class="card-line">1 张</span><span class="card-line">#1 到期 2026/10/22</span>',
		);
		expect(rowOf("claude")).toContain(
			'<span class="next-charge">读不到（Anthropic 接口不给）</span>',
		);
		expect(rowOf("codex")).toContain(
			'<span class="next-charge">10/22 周四</span>',
		);
		for (const absent of [
			"明细未提供",
			"待你确认",
			"token 状态",
			"订阅到期",
			"<redacted>",
			"Opus 5.5 launch",
			"a".repeat(64),
		]) {
			expect(html).not.toContain(absent);
		}
	});
});
