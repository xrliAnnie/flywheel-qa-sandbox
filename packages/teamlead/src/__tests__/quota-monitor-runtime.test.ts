import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
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
import { createModelDetectionIntent } from "../account-heal/quota-incident.js";
import { makeQuotaMonitorRuntime } from "../account-heal/quota-monitor-runtime.js";
import {
	emptyQuotaMonitorState,
	writeQuotaMonitorState,
} from "../account-heal/quota-monitor-state.js";
import { usageResult } from "./quota-monitor-test-helpers.js";

const NOW = Date.parse("2026-07-14T20:00:00Z");
let dir: string;
let poolDir: string;
let configPath: string;
let statePath: string;
let storePath: string;
let cachePath: string;
let lockPath: string;
let claudeJsonPath: string;
let confirmationEvidenceDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1256-runtime-"));
	poolDir = join(dir, "pool");
	configPath = join(dir, "config.json");
	statePath = join(dir, "state.json");
	storePath = join(dir, "accounts.json");
	cachePath = join(dir, "usage-cache.json");
	lockPath = join(dir, "accounts.lock");
	claudeJsonPath = join(dir, "claude.json");
	confirmationEvidenceDir = join(dir, "confirmations");
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
		writeFileSync(
			join(poolDir, name, "oauthAccount.json"),
			JSON.stringify({ emailAddress: `${name}@example.com` }),
			{ mode: 0o600 },
		);
	}
	writeFileSync(
		claudeJsonPath,
		JSON.stringify({ oauthAccount: { emailAddress: "shopping@example.com" } }),
		{ mode: 0o600 },
	);
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
	const state = emptyQuotaMonitorState(4);
	state.lastCandidateSweepAt = NOW;
	writeQuotaMonitorState(state, statePath);
});

afterEach(() => {
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

const noMachineDrift = async (): Promise<boolean> => true;

describe("makeQuotaMonitorRuntime", () => {
	it("skips healthy reconcile and throttles repeated attempts for one drift witness", async () => {
		writeConfig(99);
		let accessToken = "active-secret";
		const reconcileMachine = vi.fn(async () => false);
		const runtime = makeQuotaMonitorRuntime({
			now: () => NOW,
			paths: {
				poolDir,
				configPath,
				statePath,
				storePath,
				cachePath,
				lockPath,
				claudeJsonPath,
			},
			reconcileMachine,
			readKeychainCredential: async () => ({
				accessToken,
				expiresAt: NOW + 3_600_000,
			}),
			fetchUsage: async () => usageResult(20, 20),
			fetchIdentity: async () => ({
				email: "shopping@example.com",
				uuid: "uuid-shopping",
			}),
			tmux: {
				listPanes: async () => [],
				capturePane: async () => "",
				sendContinue: async () => ({ sent: true }),
			},
			alert: async () => ({ primary: "sent" }),
		});

		await runtime.tick();
		expect(reconcileMachine).not.toHaveBeenCalled();

		accessToken = "manual-login-secret";
		await runtime.tick();
		await runtime.tick();

		expect(reconcileMachine).toHaveBeenCalledTimes(1);
	});

	it("captures manual login drift before refreshing every non-active slot", async () => {
		writeConfig(99);
		for (const [name, uuid] of [
			["shopping", "uuid-shopping"],
			["school", "uuid-school"],
		] as const) {
			writeFileSync(
				join(poolDir, name, "identity-anchor.json"),
				JSON.stringify({
					accountUuid: uuid,
					anchoredAt: "2026-08-13T12:45:00.000Z",
					anchoredBy: "founder",
					confirmedBy: "oauth-profile",
					email: `${name}@example.com`,
				}),
				{ mode: 0o600 },
			);
		}
		const due = emptyQuotaMonitorState(4);
		due.lastCandidateSweepAt = 0;
		writeQuotaMonitorState(due, statePath);
		const order: string[] = [];
		const verifyCandidate = vi.fn(async () => ({
			fresh: "refreshed" as const,
			expiresAt: NOW + 3_600_000,
		}));
		const runtime = makeQuotaMonitorRuntime({
			now: () => NOW,
			paths: {
				poolDir,
				configPath,
				statePath,
				storePath,
				cachePath,
				lockPath,
				claudeJsonPath,
			},
			reconcileMachine: async () => {
				order.push("reconcile");
				writeFileSync(join(poolDir, ".active"), "school\n", { mode: 0o600 });
				writeFileSync(
					claudeJsonPath,
					JSON.stringify({
						oauthAccount: { emailAddress: "school@example.com" },
					}),
					{ mode: 0o600 },
				);
				writeStore(
					{
						generation: 5,
						activeAccount: "school",
						accounts: [{ name: "shopping" }, { name: "school" }],
					},
					storePath,
				);
				return true;
			},
			readKeychainCredential: async () => {
				order.push("keychain");
				return {
					accessToken: "manual-school",
					expiresAt: NOW + 3_600_000,
				};
			},
			fetchIdentity: async () => ({
				email: "school@example.com",
				uuid: "uuid-school",
			}),
			fetchUsage: async () => usageResult(20, 20),
			verifyCandidate,
			tmux: {
				listPanes: async () => [],
				capturePane: async () => "",
				sendContinue: async () => ({ sent: true }),
			},
			alert: async () => ({ primary: "sent" }),
		});

		await expect(runtime.tick()).resolves.toMatchObject({
			outcome: "observed",
		});
		expect(order.slice(0, 2)).toEqual(["keychain", "reconcile"]);
		expect(verifyCandidate).toHaveBeenCalledWith("shopping", "school");
		expect(verifyCandidate).not.toHaveBeenCalledWith(
			"school",
			expect.anything(),
		);
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
			lastCandidateSweepAt: NOW,
			observedGeneration: 5,
		});
	});

	it("captures each pane once for model detection, switch, revive, and delayed confirmation", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				trigger5hPct: 90,
				basePollMinutes: 20,
				acceleratePct: 70,
				acceleratedPollMinutes: 10,
				candidateSweepMinutes: 60,
				minSwitchIntervalMinutes: 15,
				order: ["shopping", "school"],
				writeStatuslineCache: true,
				paneScanSeconds: 60,
				confirmDelayMinutes: 5,
			}),
			{ mode: 0o600 },
		);
		let clock = NOW;
		let capture = readFileSync(
			join(
				import.meta.dirname,
				"fixtures",
				"lead-panes",
				"usage-limit-real.txt",
			),
			"utf8",
		).replace(
			/\s*⎿\s+Claude usage limit reached\.[^\n]*/,
			"  ⎿  You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
		);
		const listPanes = vi.fn(async () => [
			{
				paneId: "%7",
				panePid: 7_007,
				sessionName: "flywheel",
				windowName: "FLY-1182-claude-runner",
				currentCommand: "2.1.211",
				dead: false,
				qaInjection: false,
			},
		]);
		const capturePane = vi.fn(async () => capture);
		const sendContinue = vi.fn(async () => ({ sent: true as const }));
		const deliverAlert = vi.fn(async () => "sent" as const);
		const switchAccount = vi.fn(async () => {
			const benchUntil = new Date(clock + 30 * 60_000).toISOString();
			writeFileSync(join(poolDir, ".active"), "school\n", { mode: 0o600 });
			writeFileSync(
				claudeJsonPath,
				JSON.stringify({
					oauthAccount: { emailAddress: "school@example.com" },
				}),
				{ mode: 0o600 },
			);
			writeStore(
				{
					generation: 5,
					activeAccount: "school",
					accounts: [
						{
							name: "shopping",
							modelCaps: {
								"Fable 5": {
									until: benchUntil,
									backoffMs: 30 * 60_000,
								},
							},
						},
						{ name: "school" },
					],
				},
				storePath,
			);
			return {
				outcome: "switched" as const,
				from: "shopping",
				to: "school",
				generation: 5,
				benchUntilByModel: { "Fable 5": benchUntil },
			};
		});
		const runtime = makeQuotaMonitorRuntime({
			now: () => clock,
			reconcileMachine: noMachineDrift,
			paths: {
				poolDir,
				configPath,
				statePath,
				storePath,
				cachePath,
				lockPath,
				claudeJsonPath,
				confirmationEvidenceDir,
			},
			readKeychainCredential: async () => ({
				accessToken: "active-secret",
				expiresAt: clock + 3_600_000,
			}),
			fetchUsage: async (token) =>
				token === "active-secret" ? usageResult(20, 20) : usageResult(5, 5),
			verifyCandidate: async () => ({
				fresh: "refreshed" as const,
				expiresAt: clock + 3_600_000,
			}),
			switchAccount,
			tmux: { listPanes, capturePane, sendContinue },
			deliverAlert,
			alert: async () => {},
		});

		let result = await runtime.tick();
		expect(result.outcome).toBe("switched");
		expect(listPanes).toHaveBeenCalledTimes(1);
		expect(capturePane).toHaveBeenCalledTimes(1);
		expect(sendContinue).toHaveBeenCalledWith("%7");
		expect(deliverAlert).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "model_cap_switched" }),
		);
		expect(result.state.alertOutbox).toEqual([]);
		expect(result.state.confirmation).toMatchObject({ generation: 5 });

		capture = readFileSync(
			join(
				import.meta.dirname,
				"fixtures",
				"lead-panes",
				"idle-product-lead.txt",
			),
			"utf8",
		);
		clock += 5 * 60_000;
		result = await runtime.tick();
		expect(result.outcome).toBe("local_scan");
		expect(listPanes).toHaveBeenCalledTimes(2);
		expect(capturePane).toHaveBeenCalledTimes(2);
		expect(deliverAlert).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "quota_switch_confirmation" }),
		);
		expect(result.state.confirmation).toBeNull();
		expect(result.state.confirmDueAt).toBeNull();
		expect(result.state.alertOutbox).toEqual([]);
		const evidenceFiles = readdirSync(confirmationEvidenceDir);
		expect(evidenceFiles).toHaveLength(1);
		expect(
			JSON.parse(
				readFileSync(join(confirmationEvidenceDir, evidenceFiles[0]), "utf8"),
			).recovered,
		).toBe(1);
	});

	it("reconciles a manual active marker change before polling and migrates state to the new generation", async () => {
		writeConfig(99);
		writeFileSync(join(poolDir, ".active"), "school\n", { mode: 0o600 });
		writeFileSync(
			claudeJsonPath,
			JSON.stringify({ oauthAccount: { emailAddress: "school@example.com" } }),
			{ mode: 0o600 },
		);
		writeStore(
			{
				generation: 5,
				activeAccount: "school",
				accounts: [
					{ name: "shopping", quotaExhaustedUntil: null, weeklyResetAt: null },
					{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
				],
			},
			storePath,
		);
		const runtime = makeQuotaMonitorRuntime({
			now: () => NOW,
			reconcileMachine: noMachineDrift,
			paths: {
				poolDir,
				configPath,
				statePath,
				storePath,
				cachePath,
				lockPath,
				claudeJsonPath,
			},
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
		let clock = NOW;
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
			now: () => clock,
			reconcileMachine: noMachineDrift,
			paths: {
				poolDir,
				configPath,
				statePath,
				storePath,
				cachePath,
				lockPath,
				claudeJsonPath,
			},
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
		clock += 20 * 60_000;
		result = await runtime.tick();
		expect(result.outcome).toBe("switched");
		expect(switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({ preferredOrder: ["school"] }),
		);
		expect(alerts).toEqual([
			expect.objectContaining({ kind: "account_switched" }),
		]);
	});

	it("fails closed before usage or switching when machine-account witnesses conflict", async () => {
		writeConfig(90);
		writeFileSync(
			claudeJsonPath,
			JSON.stringify({ oauthAccount: { emailAddress: "school@example.com" } }),
			{ mode: 0o600 },
		);
		const fetchUsage = vi.fn(async () => usageResult(95, 20));
		const switchAccount = vi.fn(async () => ({
			outcome: "switched" as const,
			from: "shopping",
			to: "school",
			generation: 5,
		}));
		const alerts: unknown[] = [];
		const runtime = makeQuotaMonitorRuntime({
			now: () => NOW,
			reconcileMachine: noMachineDrift,
			paths: {
				poolDir,
				configPath,
				statePath,
				storePath,
				cachePath,
				lockPath,
				claudeJsonPath,
			},
			readKeychainCredential: async () => ({
				accessToken: "active-secret",
				expiresAt: NOW + 3_600_000,
			}),
			fetchUsage,
			switchAccount,
			tmux: {
				listPanes: async () => [],
				capturePane: async () => "",
				sendContinue: async () => ({ sent: true }),
			},
			alert: async (alert) => {
				alerts.push(alert);
			},
		});

		await expect(runtime.tick()).resolves.toMatchObject({
			outcome: "identity_conflict",
		});
		expect(fetchUsage).not.toHaveBeenCalled();
		expect(switchAccount).not.toHaveBeenCalled();
		expect(alerts).toContainEqual(
			expect.objectContaining({ kind: "machine_account_conflict" }),
		);
	});

	it("recovers a committed model switch, durably finalizes it, and clears outbox only after a receipt", async () => {
		writeConfig(90);
		writeFileSync(join(poolDir, ".active"), "school\n", { mode: 0o600 });
		writeFileSync(
			claudeJsonPath,
			JSON.stringify({ oauthAccount: { emailAddress: "school@example.com" } }),
			{ mode: 0o600 },
		);
		const benchUntil = new Date(NOW + 30 * 60_000).toISOString();
		writeStore(
			{
				generation: 5,
				activeAccount: "school",
				accounts: [
					{
						name: "shopping",
						modelCaps: {
							"Fable 5": { until: benchUntil, backoffMs: 30 * 60_000 },
						},
					},
					{ name: "school" },
				],
			},
			storePath,
		);
		const state = emptyQuotaMonitorState(4);
		state.nextUsageDueAt = NOW + 60 * 60_000;
		state.nextPaneScanDueAt = NOW + 60 * 60_000;
		state.pendingDetection = createModelDetectionIntent({
			socket: "flywheel",
			observedGeneration: 4,
			observedAt: NOW - 1_000,
			sourceAccount: "shopping",
			detections: [
				{
					model: "Fable 5",
					pane: {
						paneId: "%1",
						panePid: 4_001,
						sessionName: "flywheel",
						windowName: "FLY-1182-claude-runner",
						currentCommand: "2.1.211",
						dead: false,
						qaInjection: false,
					},
				},
			],
		});
		writeQuotaMonitorState(state, statePath);
		const deliverAlert = vi.fn(async () => "sent" as const);
		const fetchUsage = vi.fn(async () => usageResult(5, 5));
		const runtime = makeQuotaMonitorRuntime({
			now: () => NOW,
			reconcileMachine: noMachineDrift,
			paths: {
				poolDir,
				configPath,
				statePath,
				storePath,
				cachePath,
				lockPath,
				claudeJsonPath,
			},
			readKeychainCredential: async () => null,
			fetchUsage,
			deliverAlert,
			tmux: {
				listPanes: async () => [],
				capturePane: async () => "",
				sendContinue: async () => ({ sent: true }),
			},
			alert: async () => {},
		});

		await runtime.tick();

		const persisted = JSON.parse(readFileSync(statePath, "utf8"));
		expect(persisted).toMatchObject({
			version: 2,
			observedGeneration: 5,
			pendingDetection: null,
			alertOutbox: [],
			confirmation: { targetAccount: "school", generation: 5 },
		});
		expect(deliverAlert).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "model_cap_switched" }),
		);
		expect(fetchUsage).not.toHaveBeenCalled();
	});

	it("alerts after three consecutive store projection failures without stopping polls", async () => {
		writeConfig(99);
		let clock = NOW;
		const alerts: unknown[] = [];
		const recordObservation = vi.fn(
			async (): Promise<RecordObservationResult> => "write_failed",
		);
		const runtime = makeQuotaMonitorRuntime({
			now: () => clock,
			reconcileMachine: noMachineDrift,
			paths: {
				poolDir,
				configPath,
				statePath,
				storePath,
				cachePath,
				lockPath,
				claudeJsonPath,
			},
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
			clock = result.state.nextUsageDueAt;
		}

		expect(recordObservation).toHaveBeenCalledTimes(3);
		expect(alerts).toEqual([
			expect.objectContaining({
				kind: "quota_monitor_down",
				signature: "quota-monitor-store-projection-2026-07-14",
			}),
		]);
	});

	// FLY-1366: switching onto an idle account makes the next statusline cache
	// carry `resets_at: null`. Pin that round-trip — the statusline reader treats
	// it as absent (`jq ... // empty`), so the null must survive verbatim rather
	// than being dropped, stringified, or replaced with a fabricated instant.
	it("round-trips an unopened window's null reset through the statusline cache", async () => {
		writeConfig(99);
		const runtime = makeQuotaMonitorRuntime({
			now: () => NOW,
			reconcileMachine: noMachineDrift,
			paths: {
				poolDir,
				configPath,
				statePath,
				storePath,
				cachePath,
				lockPath,
				claudeJsonPath,
			},
			readKeychainCredential: async () => ({
				accessToken: "active-secret",
				expiresAt: NOW + 3_600_000,
			}),
			fetchUsage: async () => usageResult(0, 12, { five: null }),
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
		const cached = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(cached.five_hour).toEqual({ utilization: 0, resets_at: null });
		expect(cached.seven_day.resets_at).toBe("2026-07-21T14:00:00.000Z");
	});
});
