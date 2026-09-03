import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUOTA_MONITOR_CONFIG } from "../../account-heal/quota-monitor-config.js";
import { buildCapacitySnapshot } from "../capacity-snapshot.js";

const scratch: string[] = [];

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

describe("buildCapacitySnapshot", () => {
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
