import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ProfileIdentity,
	ProfileIdentityResult,
} from "../account-heal/account-identity.js";
import {
	type AccountQuotaObservation,
	type AccountStore,
	selectNextAccount,
	writeStore,
} from "../account-heal/account-store.js";
import { formatSwitchNotification } from "../account-heal/account-switch-notification.js";
import { makeClaudeProfileSwitchDeps } from "../account-heal/claude-profile-cli.js";
import {
	formatModelBenchRetryNote,
	pollOnce,
	type QuotaMonitorAlert,
	type QuotaMonitorDeps,
	verifyAndRankCandidates,
} from "../account-heal/quota-monitor.js";
import type { DeliveryReport } from "../account-heal/quota-monitor-alert.js";
import {
	DEFAULT_QUOTA_MONITOR_CONFIG,
	type LoadedQuotaMonitorConfig,
} from "../account-heal/quota-monitor-config.js";
import { emptyQuotaMonitorState } from "../account-heal/quota-monitor-state.js";
import type {
	QuotaPaneRef,
	QuotaPaneSnapshot,
} from "../account-heal/quota-revive-scan.js";
import type { AccountUsageResult } from "../account-heal/quota-usage-api.js";
import {
	type SwitchResult,
	switchAccount,
} from "../account-heal/switch-executor.js";

const NOW = Date.parse("2026-07-14T20:00:00Z");
const FIVE_RESET = "2026-07-14T23:00:00.000Z";
const WEEK_RESET = "2026-07-21T14:00:00.000Z";

function usage(
	fivePct: number,
	sevenPct: number,
	// `null` is a meaningful value (an unopened window), so default only on
	// `undefined` — `??` would silently swap an explicit null back to a timestamp.
	resets: {
		five?: string | null;
		seven?: string | null;
		fable?: { pct: number; reset: string | null };
	} = {},
): Extract<AccountUsageResult, { ok: unknown }> {
	const five = resets.five === undefined ? FIVE_RESET : resets.five;
	const seven = resets.seven === undefined ? WEEK_RESET : resets.seven;
	const raw = {
		five_hour: { utilization: fivePct, resets_at: five },
		seven_day: { utilization: sevenPct, resets_at: seven },
		...(resets.fable
			? {
					limits: [
						{
							kind: "weekly_scoped",
							percent: resets.fable.pct,
							resets_at: resets.fable.reset,
							scope: {
								model: { id: null, display_name: "Fable" },
								surface: null,
							},
						},
					],
				}
			: {}),
	};
	return {
		ok: {
			raw,
			fiveH: { pct: fivePct, resetsAt: five },
			sevenD: { pct: sevenPct, resetsAt: seven },
		},
	};
}

function store(): AccountStore {
	return {
		generation: 4,
		activeAccount: "shopping",
		accounts: [
			{ name: "shopping", quotaExhaustedUntil: null, weeklyResetAt: null },
			{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			{ name: "business", quotaExhaustedUntil: null, weeklyResetAt: null },
		],
	};
}

function loadedConfig(
	overrides: Partial<typeof DEFAULT_QUOTA_MONITOR_CONFIG> = {},
): LoadedQuotaMonitorConfig {
	const config = {
		...DEFAULT_QUOTA_MONITOR_CONFIG,
		order: ["shopping", "school", "business"],
		...overrides,
	};
	return { config, monitorOnly: config.order.length === 0 };
}

type Harness = ReturnType<typeof harness>;

function paneRef(index: number): QuotaPaneRef {
	return {
		paneId: `%${index}`,
		panePid: 4_000 + index,
		sessionName: "flywheel",
		windowName: `FLY-${100 + index}-claude-runner`,
		currentCommand: "2.1.211",
		dead: false,
		qaInjection: false,
	};
}

function paneSnapshot(models: string[] = []): QuotaPaneSnapshot {
	return {
		socket: "flywheel",
		capturedAt: NOW,
		listedCount: models.length,
		complete: true,
		omittedPanes: [],
		observations: models.map((model, index) => ({
			pane: paneRef(index + 1),
			capture: `model cap ${model}`,
			managed: true,
			quotaClass: "other",
			modelVerdict: { state: "capped", model },
		})),
	};
}

function harness() {
	let now = NOW;
	let lockDepth = 0;
	let activeName = "shopping";
	let generation = 4;
	let accountStore = store();
	const events: string[] = [];
	const persisted: unknown[] = [];
	const cacheWrites: unknown[] = [];
	const alerts: QuotaMonitorAlert[] = [];
	const observations: Array<{
		name: string;
		observation: AccountQuotaObservation;
		expectedGeneration: number;
	}> = [];
	const credentials: Record<
		string,
		{ accessToken: string; expiresAt: number }
	> = {
		shopping: { accessToken: "secret-shopping", expiresAt: NOW + 3_600_000 },
		school: { accessToken: "secret-school", expiresAt: NOW + 3_600_000 },
		business: { accessToken: "secret-business", expiresAt: NOW + 3_600_000 },
	};
	const usages = new Map<string, AccountUsageResult>([
		["secret-shopping", usage(40, 20)],
		["secret-school", usage(10, 30)],
		["secret-business", usage(20, 40)],
	]);
	const fetchUsage = vi.fn(async (token: string) => {
		expect(lockDepth).toBe(0);
		events.push(`fetch:${token.replace("secret-", "")}`);
		return usages.get(token) ?? { error: "network" };
	});
	const fetchIdentity = vi.fn(
		async (token: string): Promise<ProfileIdentityResult> => {
			expect(lockDepth).toBe(0);
			events.push(`identity:${token.replace("secret-", "")}`);
			const label = token.replace("secret-", "");
			return { email: `${label}@example.com`, uuid: `uuid-${label}` };
		},
	);
	const resolveIdentityName = vi.fn(
		async (identity: Exclude<ProfileIdentityResult, { error: string }>) =>
			identity.email.split("@")[0] ?? null,
	);
	const poolIdentities: Record<string, ProfileIdentity> = {
		shopping: {
			email: "real-shopping@identity.test",
			uuid: "uuid-shopping",
		},
		school: { email: "real-school@identity.test", uuid: "uuid-school" },
		business: { email: "real-business@identity.test", uuid: "uuid-business" },
	};
	const readPoolIdentity = vi.fn(
		async (name: string) => poolIdentities[name] ?? null,
	);
	const verifyCandidate = vi.fn(async (name: string) => {
		expect(lockDepth).toBe(1);
		events.push(`verify:${name}`);
		return { fresh: "refreshed" as const, expiresAt: NOW + 3_600_000 };
	});
	const recordObservation = vi.fn<QuotaMonitorDeps["recordObservation"]>(
		async (name, observation, expectedGeneration) => {
			expect(lockDepth).toBe(0);
			events.push(`record:${name}`);
			observations.push({ name, observation, expectedGeneration });
			return "updated";
		},
	);
	const switchImpl = vi.fn<
		(
			input: Parameters<QuotaMonitorDeps["switchAccount"]>[0],
		) => Promise<SwitchResult>
	>(async (input) => {
		expect(lockDepth).toBe(0);
		events.push(`switch:${input.preferredOrder?.join(",") ?? "none"}`);
		return {
			outcome: "switched",
			from: "shopping",
			to: input.preferredOrder?.[0] ?? "school",
			generation: 5,
		};
	});
	const scanPanes = vi.fn(async () => paneSnapshot());
	const reviveSnapshot = vi.fn(
		async (
			state: ReturnType<typeof emptyQuotaMonitorState>,
			_snapshot: QuotaPaneSnapshot,
		) => {
			expect(lockDepth).toBe(0);
			events.push("revive");
			return {
				state,
				summary: { revived: 1, pending: 0, loginExpired: 0 },
			};
		},
	);
	const confirmSnapshot = vi.fn(
		async (
			state: ReturnType<typeof emptyQuotaMonitorState>,
			_snapshot: QuotaPaneSnapshot,
		) => state,
	);
	const alertImpl = vi.fn(
		async (): Promise<DeliveryReport> => ({
			primary: "sent",
		}),
	);
	const reconcileActive = vi.fn<QuotaMonitorDeps["reconcileActive"]>(
		async () => ({
			result: "noop",
			generation,
		}),
	);
	const reconcileMachine = vi.fn(async () => ({
		ok: true as const,
		outcome: "already_consistent" as const,
		exitCode: 0,
		detail: "",
	}));
	const readSnapshot = vi.fn(async () => {
		expect(lockDepth).toBe(1);
		return {
			activeName,
			store: structuredClone(accountStore),
			activeCredential: credentials[activeName] ?? null,
			poolAccounts: Object.keys(credentials),
		};
	});

	const deps: QuotaMonitorDeps = {
		now: () => now,
		config: loadedConfig(),
		state: emptyQuotaMonitorState(4),
		reconcileActive,
		reconcileMachine,
		withAccountsLock: async (fn) => {
			expect(lockDepth).toBe(0);
			lockDepth++;
			events.push("lock:start");
			try {
				return await fn();
			} finally {
				events.push("lock:end");
				lockDepth--;
			}
		},
		readSnapshot,
		readIdentity: async () => {
			expect(lockDepth).toBe(1);
			return { activeName, storeGeneration: generation };
		},
		readPoolCredential: async (name) => {
			expect(lockDepth).toBe(1);
			return credentials[name] ?? null;
		},
		verifyCandidate,
		fetchUsage,
		fetchIdentity,
		resolveIdentityName,
		readPoolIdentity,
		recordObservation,
		writeStatuslineCache: async (raw) => {
			expect(lockDepth).toBe(1);
			events.push("cache");
			cacheWrites.push(raw);
		},
		persistState: async (state) => {
			events.push(`persist:${lockDepth}`);
			persisted.push(structuredClone(state));
		},
		switchAccount: switchImpl,
		scanPanes,
		reviveSnapshot,
		confirmSnapshot,
		alert: async (alert) => {
			expect(lockDepth).toBe(0);
			events.push(`alert:${alert.kind}`);
			alerts.push(alert);
			return alertImpl();
		},
		log: vi.fn(),
	};

	return {
		deps,
		events,
		persisted,
		cacheWrites,
		alerts,
		observations,
		credentials,
		usages,
		fetchUsage,
		fetchIdentity,
		resolveIdentityName,
		readPoolIdentity,
		readSnapshot,
		verifyCandidate,
		recordObservation,
		switchImpl,
		scanPanes,
		reviveSnapshot,
		confirmSnapshot,
		reconcileActive,
		reconcileMachine,
		alertImpl,
		getLockDepth: () => lockDepth,
		setIdentity(name: string, nextGeneration = generation) {
			activeName = name;
			generation = nextGeneration;
		},
		setStore(next: AccountStore) {
			accountStore = next;
			generation = next.generation;
		},
		setNow(value: number) {
			now = value;
		},
	};
}

let h: Harness;

beforeEach(() => {
	h = harness();
});

describe("pollOnce", () => {
	it("renders the centralized switch copy with emails, every reset, and Fable quota", () => {
		const body = formatSwitchNotification({
			from: {
				name: "shopping",
				email: "shopping@example.com",
				usage: usage(91, 74, {
					five: "2026-07-14T23:00:00.000Z",
					seven: "2026-07-21T14:00:00.000Z",
					fable: { pct: 92, reset: "2026-07-17T07:00:00.000Z" },
				}).ok,
			},
			to: {
				name: "school",
				email: "school@example.com",
				usage: usage(12, 8, {
					five: "2026-07-15T02:00:00.000Z",
					seven: "2026-07-19T15:00:00.000Z",
					fable: { pct: 12, reset: "2026-07-20T15:00:00.000Z" },
				}).ok,
			},
			trigger: { kind: "quota", scope: "5h" },
			panorama: [],
			timezone: "America/Los_Angeles",
		});

		expect(body).toBe(
			[
				"Claude 已切号：**shopping → school**（quota:5h）",
				"",
				"原账号 **shopping**",
				"shopping@example.com",
				"```text",
				"window  used   left   reset (PT)",
				"5h      91%    9%     07-14 Tue 16:00",
				"7d      74%    26%    07-21 Tue 07:00",
				"Fable   92%    8%     07-17 Fri 00:00",
				"```",
				"",
				"新账号 **school**",
				"school@example.com",
				"```text",
				"window  used   left   reset (PT)",
				"5h      12%    88%    07-14 Tue 19:00",
				"7d      8%     92%    07-19 Sun 08:00",
				"Fable   12%    88%    07-20 Mon 08:00",
				"```",
			].join("\n"),
		);
		const table = body.split("```text\n")[1]?.split("\n```")[0]?.split("\n");
		expect(table?.every((line) => /^[\x20-\x7e]+$/.test(line))).toBe(true);
		expect([
			table?.[0]?.indexOf("used"),
			table?.[1]?.indexOf("91%"),
			table?.[2]?.indexOf("74%"),
			table?.[3]?.indexOf("92%"),
		]).toEqual([8, 8, 8, 8]);
		expect([
			table?.[0]?.indexOf("left"),
			table?.[1]?.indexOf("9%"),
			table?.[2]?.indexOf("26%"),
			table?.[3]?.indexOf("8%"),
		]).toEqual([15, 15, 15, 15]);
		expect([
			table?.[0]?.indexOf("reset"),
			table?.[1]?.indexOf("07-"),
			table?.[2]?.indexOf("07-"),
			table?.[3]?.indexOf("07-"),
		]).toEqual([22, 22, 22, 22]);
		const asciiWcwidth = (value: string) =>
			Array.from(value).reduce((width, character) => {
				const code = character.codePointAt(0) ?? 0;
				return width + (code >= 0x20 && code <= 0x7e ? 1 : 2);
			}, 0);
		const columnMarkers = [
			["used", "left", "reset"],
			["91%", "9%", "07-"],
			["74%", "26%", "07-"],
			["92%", "8%", "07-"],
		];
		expect(
			table?.map((line, row) =>
				columnMarkers[row]!.map((marker) =>
					asciiWcwidth(line.slice(0, line.indexOf(marker))),
				),
			),
		).toEqual([
			[8, 15, 22],
			[8, 15, 22],
			[8, 15, 22],
			[8, 15, 22],
		]);
		expect(body).not.toMatch(
			/from5h|to5h|revived=|pending=|unknown|切号时|继续指令|仍在等待|已恢复/,
		);
	});

	it("keeps missing quota facts explicit without pane-revive status", () => {
		const body = formatSwitchNotification({
			from: { name: "shopping", email: null, usage: usage(100, 90).ok },
			to: {
				name: "school",
				email: "school@example.com",
				usage: usage(0, 0, { five: null, seven: null }).ok,
			},
			trigger: { kind: "quota", scope: "weekly" },
			panorama: [],
			headroomDegraded: true,
			timezone: "America/Los_Angeles",
		});

		expect(body).toContain("weekly 有粮但 5h 已过 trigger");
		expect(body).toContain("邮箱暂时未读到");
		expect(body).toContain("Fable   n/a    n/a    n/a");
		expect(body).toContain("not started");
		expect(body).not.toMatch(/切号时|继续指令|仍在等待|已恢复/);
	});

	it("describes model bench expiry as a retry boundary, never a quota recovery promise", () => {
		const accountStore = store();
		accountStore.accounts = accountStore.accounts.map((account) =>
			account.name === "school"
				? {
						...account,
						modelCaps: {
							"Fable 5": {
								until: new Date(NOW + 45 * 60_000).toISOString(),
								backoffMs: 45 * 60_000,
							},
						},
					}
				: account,
		);

		const finite = formatModelBenchRetryNote(
			accountStore.accounts.filter((account) => account.name === "school"),
			["Fable 5"],
			NOW,
		);
		expect(finite).toContain("next retry / revalidation after");
		expect(finite).toContain("2026-07-14T20:45:00.000Z");
		expect(finite).toContain("not a quota recovery guarantee");

		const malformed = formatModelBenchRetryNote(
			[
				{
					...accountStore.accounts[0],
					modelCaps: {
						"Fable 5": { until: "unknown", backoffMs: -1 },
					},
				},
			],
			["Fable 5"],
			NOW,
		);
		expect(malformed).toBe(
			"next retry / revalidation unknown; malformed model bench state requires manual inspection; this is not a quota recovery guarantee",
		);
	});

	it("filters active and malformed model benches before freshness or usage I/O", async () => {
		const accountStore = store();
		accountStore.accounts = accountStore.accounts.map((account) => {
			if (account.name === "school") {
				return {
					...account,
					modelCaps: {
						"Fable 5": {
							until: new Date(NOW + 30 * 60_000).toISOString(),
							backoffMs: 30 * 60_000,
						},
					},
				};
			}
			if (account.name === "business") {
				return {
					...account,
					modelCaps: {
						"Fable 5": { until: "malformed", backoffMs: -1 },
					},
				};
			}
			return account;
		});

		const candidates = await verifyAndRankCandidates(
			h.deps,
			{
				activeName: "shopping",
				store: accountStore,
				activeCredential: h.credentials.shopping,
				poolAccounts: ["shopping", "school", "business"],
			},
			["Fable 5"],
		);

		expect(candidates.ranked).toEqual([]);
		expect(candidates.panorama).toEqual([
			expect.objectContaining({
				name: "business",
				status: expect.stringContaining("model_bench_malformed"),
			}),
			expect.objectContaining({
				name: "school",
				status: expect.stringContaining("model_benched_until"),
			}),
		]);
		expect(candidates.malformedModelBenches).toEqual(["business"]);
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(h.fetchUsage).not.toHaveBeenCalled();
	});

	it("successful apply reports open capture-back identity episodes after the switch lock", async () => {
		h.usages.set("secret-shopping", usage(100, 20));
		h.switchImpl.mockResolvedValueOnce({
			outcome: "switched",
			from: "shopping",
			to: "school",
			generation: 5,
			applyReports: [
				{
					identityChecks: [
						{
							label: "shopping",
							checkpoint: "capture_back",
							verdict: "mismatch",
							expectedKey: "b".repeat(64),
							actualDigest: "a".repeat(64),
						},
					],
				},
			],
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(result.state.identityMismatchEpisodes?.shopping).toMatchObject({
			checkpoint: "capture_back",
		});
		expect(
			h.alerts.some((alert) => alert.kind === "account_identity_mismatch"),
		).toBe(true);
	});

	it("services at most two identity labels per tick with a durable round-robin cursor", async () => {
		const episode = (label: string) => ({
			checkpoint: "candidate" as const,
			expectedKey: "b".repeat(64),
			actualDigest: label.charCodeAt(0).toString(16).padStart(64, "0"),
			startedAt: new Date(NOW - 60_000).toISOString(),
			lastConfirmedAlertAt: null,
			alertCount: 0,
			round: 1,
			activeDelivery: { round: 1, attempts: 0, lastAttemptAt: null },
		});
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			backoffUntilMs: NOW + 60_000,
			identityMismatchEpisodes: {
				business: episode("business"),
				school: episode("school"),
				shopping: episode("shopping"),
			},
		};
		h.alertImpl.mockResolvedValue({ primary: "dead_lettered" });

		const first = await pollOnce(h.deps);
		h.deps.state = first.state;
		const second = await pollOnce(h.deps);

		const identityBodies = h.alerts
			.filter((alert) => alert.kind === "account_identity_mismatch")
			.map((alert) => alert.body);
		expect(identityBodies.slice(0, 2).join("\n")).toMatch(/business.*school/s);
		expect(identityBodies.slice(2).join("\n")).toContain("label=shopping");
		expect(second.state.identityAlertCursor).not.toBeNull();
	});
	it("turns a transition-journal conflict into a persistent switch-failure episode before domain reads", async () => {
		h.reconcileActive.mockResolvedValueOnce({
			result: "transition_journal_conflict",
			generation: null,
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("error");
		expect(result.state.pendingSwitchFailure).toMatchObject({
			reasonCode: "transition_journal_conflict",
			alertCount: 1,
		});
		expect(h.alerts.map((alert) => alert.kind)).toEqual([
			"account_switch_failed",
		]);
		expect(h.events.some((event) => event === "lock:start")).toBe(false);
		expect(h.switchImpl).not.toHaveBeenCalled();
	});

	it("reconciles an externally advanced generation before stale delivery, revive, and backoff", async () => {
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			backoffUntilMs: NOW + 60_000,
			lastSwitchAt: NOW - 60_000,
			reviveEpoch: {
				open: true,
				sourceAccount: "shopping",
				generation: 4,
				openedAt: NOW - 60_000,
				expiresAt: NOW + 60_000,
				panes: {},
			},
			blockedEpisode: {
				scope: "weekly",
				startedAt: new Date(NOW - 60_000).toISOString(),
				lastConfirmedAlertAt: null,
				alertCount: 0,
				blockedRound: 0,
				recoveryRound: 0,
				activeDelivery: {
					kind: "blocked",
					round: 0,
					attempts: 0,
					lastAttemptAt: null,
				},
			},
			pendingSwitchFailure: {
				reasonCode: "apply_failed",
				degraded: false,
				startedAt: new Date(NOW - 60_000).toISOString(),
				lastConfirmedAlertAt: null,
				alertCount: 0,
				activeDelivery: {
					round: 0,
					attempts: 0,
					lastAttemptAt: null,
				},
			},
		};
		h.reconcileActive.mockImplementationOnce(async () => {
			h.events.push("reconcile");
			return { result: "noop", generation: 5 };
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("backoff");
		expect(result.state).toMatchObject({
			observedGeneration: 5,
			lastSwitchAt: NOW,
			reviveEpoch: null,
			blockedEpisode: null,
			pendingSwitchFailure: null,
		});
		expect(h.reviveSnapshot).toHaveBeenCalledTimes(1);
		expect(h.reviveSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ reviveEpoch: null }),
			expect.objectContaining({ observations: [] }),
			true,
		);
		expect(h.alerts).toHaveLength(0);
		expect(h.events.slice(0, 2)).toEqual(["reconcile", "persist:0"]);
	});

	it("consumes noop_reconciled as a conservative generation migration", async () => {
		h.usages.set("secret-shopping", usage(100, 40));
		h.switchImpl.mockResolvedValueOnce({
			outcome: "noop_reconciled",
			activeAccount: "school",
			generation: 6,
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("noop_already_switched");
		expect(result.state).toMatchObject({
			observedGeneration: 6,
			lastSwitchAt: NOW,
			reviveEpoch: null,
			blockedEpisode: null,
			pendingSwitchFailure: null,
		});
	});

	it("observes active usage outside the lock, then revalidates and commits cache+state in one lock", async () => {
		h.deps.state.lastCandidateSweepAt = NOW;
		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("observed");
		expect(result.state).toMatchObject({
			lastPollAt: NOW,
			lastSuccessfulUsageAt: NOW,
			errorStreak: 0,
			tier: "base",
			nextUsageDueAt: NOW + h.deps.config.config.basePollMinutes * 60_000,
			observedGeneration: 4,
		});
		expect(h.fetchUsage).toHaveBeenCalledTimes(1);
		expect(h.cacheWrites).toHaveLength(1);
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(h.switchImpl).not.toHaveBeenCalled();
		expect(h.events).toEqual([
			"lock:start",
			"lock:end",
			"fetch:shopping",
			"lock:start",
			"cache",
			"persist:1",
			"lock:end",
			"record:shopping",
			"revive",
		]);
		expect(h.observations).toEqual([
			{
				name: "shopping",
				expectedGeneration: 4,
				observation: {
					fiveHPct: 40,
					sevenDPct: 20,
					fiveHResetAt: FIVE_RESET,
					sevenDResetAt: WEEK_RESET,
					observedAt: new Date(NOW).toISOString(),
				},
			},
		]);
	});

	it("discards an observation when account identity changed before locked commit", async () => {
		h.fetchUsage.mockImplementationOnce(async () => {
			h.setIdentity("school", 5);
			return usage(95, 20);
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("stale_snapshot");
		expect(h.cacheWrites).toHaveLength(0);
		expect(h.persisted).toHaveLength(0);
		expect(h.recordObservation).not.toHaveBeenCalled();
		expect(h.switchImpl).not.toHaveBeenCalled();
	});

	it("never refreshes an expired or unauthorized active credential and emits quota_read_blind outside the lock", async () => {
		h.credentials.shopping.expiresAt = NOW;
		let result = await pollOnce(h.deps);
		expect(result.outcome).toBe("blind");
		expect(h.fetchUsage).not.toHaveBeenCalled();
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(h.alerts.at(-1)?.kind).toBe("quota_read_blind");

		h = harness();
		h.usages.set("secret-shopping", { error: "unauthorized" });
		result = await pollOnce(h.deps);
		expect(result.outcome).toBe("blind");
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(h.alerts.at(-1)?.kind).toBe("quota_read_blind");
	});

	it("persists Retry-After backoff and skips network work until it expires", async () => {
		h.usages.set("secret-shopping", {
			error: "rate_limited",
			retryAfterMs: 300_000,
		});
		let result = await pollOnce(h.deps);
		expect(result.outcome).toBe("backoff");
		expect(result.state.backoffUntilMs).toBe(NOW + 300_000);
		expect(result.state.nextUsageDueAt).toBe(NOW + 300_000);

		h = harness();
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			backoffUntilMs: NOW + 1,
		};
		result = await pollOnce(h.deps);
		expect(result.outcome).toBe("backoff");
		expect(h.fetchUsage).not.toHaveBeenCalled();
	});

	it("runs the local pane/revive tick without usage work while nextUsageDueAt is backed off", async () => {
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			backoffUntilMs: NOW + 15 * 60_000,
			nextUsageDueAt: NOW + 15 * 60_000,
			nextPaneScanDueAt: NOW,
			reviveEpoch: {
				open: true,
				sourceAccount: "shopping",
				generation: 4,
				openedAt: NOW - 60_000,
				expiresAt: NOW + 60_000,
				panes: {},
			},
		};
		h.deps.reviveSnapshot = vi.fn(async (state) => ({
			state: {
				...state,
				reviveEpoch: state.reviveEpoch && {
					...state.reviveEpoch,
					panes: {
						"fleet:%12:4321": { attempts: 1, lastAttemptAt: NOW },
					},
				},
			},
			summary: { revived: 1, pending: 0, loginExpired: 0 },
		}));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("local_scan");
		expect(h.deps.reviveSnapshot).toHaveBeenCalledTimes(1);
		expect(h.fetchUsage).not.toHaveBeenCalled();
		expect(result.state.reviveEpoch?.panes).toEqual({
			"fleet:%12:4321": { attempts: 1, lastAttemptAt: NOW },
		});
		expect(result.state.nextPaneScanDueAt).toBe(
			NOW + h.deps.config.config.paneScanSeconds * 1_000,
		);
	});

	it("runs pane detection on its own deadline even before any revive epoch exists", async () => {
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			nextUsageDueAt: NOW + 15 * 60_000,
			nextPaneScanDueAt: NOW,
			reviveEpoch: null,
		};

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("local_scan");
		expect(h.reviveSnapshot).toHaveBeenCalledTimes(1);
		expect(h.fetchUsage).not.toHaveBeenCalled();
	});

	it("uses one snapshot to persist a canonical model detection, switch, open the bounded epoch, and revive", async () => {
		const snapshot = paneSnapshot(["Sonnet 5", "Fable 5", "Fable 5"]);
		h.scanPanes.mockResolvedValueOnce(snapshot);
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			nextUsageDueAt: NOW + 15 * 60_000,
			nextPaneScanDueAt: NOW,
		};
		h.switchImpl.mockImplementationOnce(async (input) => {
			expect(
				h.persisted.some(
					(item) =>
						(item as ReturnType<typeof emptyQuotaMonitorState>)
							.pendingDetection !== null,
				),
			).toBe(true);
			return {
				outcome: "switched",
				from: "shopping",
				to: input.preferredOrder?.[0] ?? "school",
				generation: 5,
				benchUntilByModel: {
					"Fable 5": new Date(NOW + 30 * 60_000).toISOString(),
					"Sonnet 5": new Date(NOW + 45 * 60_000).toISOString(),
				},
			};
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.scanPanes).toHaveBeenCalledTimes(1);
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: { kind: "model", models: ["Fable 5", "Sonnet 5"] },
				observedAccount: "shopping",
				observedGeneration: 4,
				preferredOrder: ["business", "school"],
			}),
		);
		expect(result.state).toMatchObject({
			observedGeneration: 5,
			pendingDetection: null,
			confirmation: {
				generation: 5,
				models: ["Fable 5", "Sonnet 5"],
			},
			reviveEpoch: {
				generation: 5,
				expiresAt: NOW + 75 * 60_000,
				trigger: { kind: "model", models: ["Fable 5", "Sonnet 5"] },
			},
		});
		expect(result.state.alertOutbox).toEqual([]);
		expect(h.reviveSnapshot).toHaveBeenCalledTimes(1);
		expect(h.reviveSnapshot.mock.calls[0]?.[1]).toBe(snapshot);
		expect(h.reviveSnapshot.mock.calls[0]?.[0].reviveEpoch).toMatchObject({
			trigger: { kind: "model", models: ["Fable 5", "Sonnet 5"] },
		});
	});

	it("does not attribute a switched pane's stale model cap to the new machine account", async () => {
		const nextStore = store();
		nextStore.generation = 5;
		nextStore.activeAccount = "school";
		h.setIdentity("school", 5);
		h.setStore(nextStore);
		h.scanPanes.mockResolvedValueOnce(paneSnapshot(["Fable 5"]));
		h.deps.state = {
			...emptyQuotaMonitorState(5),
			nextUsageDueAt: NOW,
			nextPaneScanDueAt: NOW,
			modelPaneSuppressions: {
				"flywheel:%1:4001": { models: ["Fable 5"], lastSeenAt: NOW - 1 },
			},
		};

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("observed");
		expect(result.state.pendingDetection).toBeNull();
		expect(result.state.modelPaneSuppressions).toEqual({
			"flywheel:%1:4001": { models: ["Fable 5"], lastSeenAt: NOW },
		});
		expect(h.switchImpl).not.toHaveBeenCalled();
	});

	it("releases a clear pane suppression even when an unrelated pane makes the fleet snapshot incomplete", async () => {
		const clear = paneSnapshot();
		clear.listedCount = 1;
		clear.complete = false;
		clear.omittedPanes = [paneRef(2)];
		clear.observations = [
			{
				pane: paneRef(1),
				capture: "healthy runner",
				managed: true,
				quotaClass: "other",
				modelVerdict: { state: "clear" },
			},
		];
		h.scanPanes.mockResolvedValueOnce(clear);
		h.deps.state = {
			...emptyQuotaMonitorState(5),
			nextUsageDueAt: NOW + 60_000,
			nextPaneScanDueAt: NOW,
			modelPaneSuppressions: {
				"flywheel:%1:4001": { models: ["Fable 5"], lastSeenAt: NOW - 1 },
			},
		};

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("local_scan");
		expect(result.state.modelPaneSuppressions).toEqual({});
		expect(h.switchImpl).not.toHaveBeenCalled();
	});

	it("lets an account-level threshold dominate simultaneous model caps and clears the model intent before switching", async () => {
		const snapshot = paneSnapshot(["Fable 5", "Sonnet 5"]);
		h.scanPanes.mockResolvedValueOnce(snapshot);
		h.usages.set("secret-shopping", usage(95, 20));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: { kind: "quota", scope: "5h", resetAt: FIVE_RESET },
			}),
		);
		expect(h.switchImpl).not.toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: expect.objectContaining({ kind: "model" }),
			}),
		);
		expect(result.state.pendingDetection).toBeNull();
		expect(result.state.alertOutbox).toEqual([]);
		expect(h.alerts.some((alert) => alert.kind === "account_switched")).toBe(
			false,
		);
		expect(h.reviveSnapshot.mock.calls[0]?.[1]).toBe(snapshot);
	});

	it("an account-level switch retires any older-generation model confirmation", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			confirmDueAt: NOW + 5 * 60_000,
			confirmation: {
				eventId: "model-cap-g3-old:confirm",
				generation: 4,
				dueAt: NOW + 5 * 60_000,
				sourceAccount: "personal",
				targetAccount: "shopping",
				models: ["Fable 5"],
				affectedPanes: [
					{
						socket: "flywheel",
						paneId: "%1",
						panePid: 4_001,
						sessionName: "flywheel",
						windowName: "FLY-101-claude-runner",
					},
				],
			},
		};

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(result.state.observedGeneration).toBe(5);
		expect(result.state.confirmation).toBeNull();
		expect(result.state.confirmDueAt).toBeNull();
	});

	it("persists a model detection but never switches or opens an epoch while active usage is blind", async () => {
		const snapshot = paneSnapshot(["Fable 5"]);
		h.scanPanes.mockResolvedValueOnce(snapshot);
		h.usages.set("secret-shopping", { error: "unauthorized" });

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("blind");
		expect(result.state.pendingDetection).toMatchObject({
			sourceAccount: "shopping",
			models: ["Fable 5"],
		});
		expect(result.state.reviveEpoch).toBeNull();
		expect(h.switchImpl).not.toHaveBeenCalled();
		expect(h.alerts.at(-1)?.kind).toBe("quota_read_blind");
		expect(h.reviveSnapshot.mock.calls[0]?.[1]).toBe(snapshot);
	});

	it("disables every revive action when the machine account witnesses conflict", async () => {
		const snapshot = paneSnapshot(["Fable 5"]);
		h.scanPanes.mockResolvedValueOnce(snapshot);
		const readSnapshot = h.deps.readSnapshot;
		h.deps.readSnapshot = async () => ({
			...(await readSnapshot()),
			authority: {
				kind: "conflict" as const,
				activeMarker: "shopping",
				identityAccount: "school",
				ledgerAccount: "shopping",
			},
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("identity_conflict");
		expect(h.switchImpl).not.toHaveBeenCalled();
		expect(h.reviveSnapshot).toHaveBeenCalledWith(
			expect.anything(),
			snapshot,
			false,
		);
		expect(result.state.pendingDetection).toBeNull();
	});

	it("retains a pending detection across an incomplete scan and clears it only after a complete clear snapshot", async () => {
		h.scanPanes.mockResolvedValueOnce(paneSnapshot(["Fable 5"]));
		h.usages.set("secret-shopping", { error: "unauthorized" });
		let result = await pollOnce(h.deps);
		expect(result.state.pendingDetection).not.toBeNull();

		h.deps.state = {
			...result.state,
			nextUsageDueAt: NOW + 15 * 60_000,
			nextPaneScanDueAt: NOW,
		};
		h.scanPanes.mockResolvedValueOnce({
			...paneSnapshot(),
			complete: false,
			listError: "tmux unavailable",
		});
		result = await pollOnce(h.deps);
		expect(result.state.pendingDetection).not.toBeNull();

		h.deps.state = {
			...result.state,
			nextUsageDueAt: NOW + 15 * 60_000,
			nextPaneScanDueAt: NOW,
		};
		h.scanPanes.mockResolvedValueOnce(paneSnapshot());
		result = await pollOnce(h.deps);
		expect(result.state.pendingDetection).toBeNull();
	});

	it("warns on malformed model benches, performs zero candidate I/O, and reports only a retry boundary", async () => {
		const accountStore = store();
		accountStore.accounts = accountStore.accounts.map((account) => {
			if (account.name === "school") {
				return {
					...account,
					modelCaps: {
						"Fable 5": {
							until: new Date(NOW + 30 * 60_000).toISOString(),
							backoffMs: 30 * 60_000,
						},
					},
				};
			}
			if (account.name === "business") {
				return {
					...account,
					modelCaps: {
						"Fable 5": { until: "malformed", backoffMs: -1 },
					},
				};
			}
			return account;
		});
		h.setStore(accountStore);
		h.scanPanes.mockResolvedValueOnce(paneSnapshot(["Fable 5"]));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(h.fetchUsage).toHaveBeenCalledTimes(1);
		expect(h.switchImpl).not.toHaveBeenCalled();
		expect(h.alerts).toContainEqual(
			expect.objectContaining({
				kind: "model_bench_malformed",
				body: expect.stringContaining("business"),
			}),
		);
		const noTarget = h.alerts.find((alert) => alert.kind === "quota_no_target");
		expect(noTarget?.body).toContain("next retry / revalidation after");
		expect(noTarget?.body).toContain("not a quota recovery guarantee");
		expect(noTarget?.body).not.toContain("quota recovered");
	});

	it("does not let the unrelated quota alert outbox block an atomic model switch notification", async () => {
		h.scanPanes.mockResolvedValueOnce(paneSnapshot(["Fable 5"]));
		h.switchImpl.mockResolvedValueOnce({
			outcome: "switched",
			from: "shopping",
			to: "school",
			generation: 5,
			benchUntilByModel: {
				"Fable 5": new Date(NOW + 30 * 60_000).toISOString(),
			},
		});
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			alertOutbox: Array.from({ length: 64 }, (_, index) => ({
				eventId: `existing-${index}`,
				generation: 4,
				createdAt: NOW - index,
				alert: {
					kind: "model_cap_switched",
					severity: "info" as const,
					title: "existing",
					body: "existing",
					signature: `existing-${index}`,
				},
			})),
		};

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.verifyCandidate).toHaveBeenCalled();
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: { kind: "model", models: ["Fable 5"] },
			}),
		);
		expect(result.state.pendingDetection).toBeNull();
		expect(result.state.alertOutbox).toHaveLength(64);
	});

	it("wakes on confirmation independently and passes the exact same snapshot to revive and confirmation", async () => {
		const snapshot = paneSnapshot();
		h.scanPanes.mockResolvedValueOnce(snapshot);
		const affected = {
			socket: "flywheel",
			paneId: "%1",
			panePid: 4_001,
			sessionName: "flywheel",
			windowName: "FLY-101-claude-runner",
		};
		h.deps.state = {
			...emptyQuotaMonitorState(5),
			nextUsageDueAt: NOW + 15 * 60_000,
			nextPaneScanDueAt: NOW + 15 * 60_000,
			confirmDueAt: NOW,
			confirmation: {
				eventId: "model-cap-g4-test:confirm",
				generation: 5,
				dueAt: NOW,
				sourceAccount: "shopping",
				targetAccount: "school",
				models: ["Fable 5"],
				affectedPanes: [affected],
			},
		};
		h.confirmSnapshot.mockImplementationOnce(async (state, received) => {
			expect(received).toBe(snapshot);
			return { ...state, confirmDueAt: null, confirmation: null };
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("local_scan");
		expect(h.scanPanes).toHaveBeenCalledTimes(1);
		expect(h.reviveSnapshot.mock.calls[0]?.[1]).toBe(snapshot);
		expect(h.confirmSnapshot).toHaveBeenCalledTimes(1);
		expect(result.state.confirmDueAt).toBeNull();
		expect(result.state.confirmation).toBeNull();
		expect(h.fetchUsage).not.toHaveBeenCalled();
	});

	it("periodically proves the live identity and probe-refreshes every non-active pool slot", async () => {
		h.usages.set("secret-shopping", usage(71, 20));

		const result = await pollOnce(h.deps);

		expect(result.state.tier).toBe("accelerated");
		expect(result.state.nextUsageDueAt).toBe(
			NOW + h.deps.config.config.acceleratedPollMinutes * 60_000,
		);
		expect(result.state.lastCandidateSweepAt).toBe(NOW);
		expect(h.fetchIdentity).toHaveBeenCalledWith("secret-shopping");
		expect(h.resolveIdentityName).toHaveBeenCalledWith({
			email: "shopping@example.com",
			uuid: "uuid-shopping",
		});
		expect(h.verifyCandidate.mock.calls.map(([name]) => name)).toEqual([
			"school",
			"business",
		]);
		expect(h.fetchUsage.mock.calls.map(([token]) => token)).toEqual([
			"secret-shopping",
			"secret-school",
			"secret-business",
		]);
		expect(h.observations.map(({ name }) => name)).toEqual([
			"shopping",
			"school",
			"business",
		]);
	});

	it("runs the freshness sweep in the base tier and skips it when oauth/profile cannot prove the active anchor", async () => {
		let result = await pollOnce(h.deps);
		expect(result.state.tier).toBe("base");
		expect(h.verifyCandidate.mock.calls.map(([name]) => name)).toEqual([
			"school",
			"business",
		]);

		h = harness();
		h.fetchIdentity.mockResolvedValueOnce({
			email: "school@example.com",
			uuid: "uuid-school",
		});
		result = await pollOnce(h.deps);
		expect(h.fetchIdentity).toHaveBeenCalledWith("secret-shopping");
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(result.state.lastCandidateSweepAt).toBe(NOW);
	});

	it("abandons a due sweep when the active Keychain witness changes after oauth/profile proof", async () => {
		h.fetchIdentity.mockImplementationOnce(async () => {
			h.setIdentity("school", 5);
			return {
				email: "shopping@example.com",
				uuid: "uuid-shopping",
			};
		});

		const result = await pollOnce(h.deps);

		expect(h.resolveIdentityName).toHaveBeenCalled();
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(result.state.lastCandidateSweepAt).toBe(NOW);
	});

	it("aborts a sweep when the live Keychain witness changes before candidate refresh", async () => {
		const snapshot = {
			activeName: "shopping",
			store: store(),
			activeCredential: h.credentials.shopping,
			poolAccounts: Object.keys(h.credentials),
		};
		h.readSnapshot
			.mockResolvedValueOnce(snapshot)
			.mockResolvedValueOnce(snapshot)
			.mockResolvedValueOnce({
				...snapshot,
				activeName: null,
				activeCredential: h.credentials.school,
			});

		await pollOnce(h.deps);

		expect(h.verifyCandidate).not.toHaveBeenCalled();
	});

	it("does not mutate pooled credentials in monitor-only mode", async () => {
		h.deps.config = {
			...h.deps.config,
			monitorOnly: true,
			config: { ...h.deps.config.config, order: [] },
		};

		await pollOnce(h.deps);

		expect(h.verifyCandidate).not.toHaveBeenCalled();
	});

	it("weekly exhaustion triggers even when 5h is below its proactive threshold and ranks verified targets by 7d reset", async () => {
		h.usages.set("secret-shopping", usage(30, 100));
		h.usages.set(
			"secret-school",
			usage(99, 20, { seven: "2026-07-20T14:00:00.000Z" }),
		);
		h.usages.set(
			"secret-business",
			usage(10, 20, { seven: "2026-07-19T14:00:00.000Z" }),
		);

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.verifyCandidate.mock.calls.map(([name]) => name)).toEqual([
			"business",
			"school",
		]);
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: { kind: "quota", scope: "weekly", resetAt: WEEK_RESET },
				preferredOrder: ["business"],
				verifiedAt: new Date(NOW).toISOString(),
			}),
		);
		expect(h.observations.map(({ name }) => name)).toEqual([
			"shopping",
			"business",
			"school",
		]);
		expect(result.state.reviveEpoch).toMatchObject({
			open: true,
			sourceAccount: "shopping",
			generation: 5,
			expiresAt: Date.parse(WEEK_RESET) + 30 * 60_000,
		});
	});

	it("uses the ledger reset for a null live reset and logs every candidate decision input", async () => {
		const nextStore = store();
		nextStore.accounts.find((entry) => entry.name === "school")!.weeklyResetAt =
			"2026-07-20T14:00:00.000Z";
		h.setStore(nextStore);
		h.usages.set("secret-shopping", usage(30, 100));
		h.usages.set("secret-school", usage(10, 20, { seven: null }));
		h.usages.set(
			"secret-business",
			usage(15, 20, { seven: "2026-07-19T14:00:00.000Z" }),
		);

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({ preferredOrder: ["business", "school"] }),
		);
		const line = vi
			.mocked(h.deps.log)
			.mock.calls.map(([entry]) => entry)
			.find((entry) => entry.includes('"event":"quota_switch_decision"'));
		expect(JSON.parse(line ?? "{}").candidates).toEqual([
			{
				name: "business",
				resetsAt: "2026-07-19T14:00:00.000Z",
				fiveHPct: 15,
			},
			{
				name: "school",
				resetsAt: "2026-07-20T14:00:00.000Z",
				fiveHPct: 10,
			},
		]);
		expect(line).not.toContain("secret-");
	});

	it("ranks healthy candidates ahead of low-headroom candidates even when the latter reset sooner", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set(
			"secret-school",
			usage(95, 20, { seven: "2026-07-19T14:00:00.000Z" }),
		);
		h.usages.set(
			"secret-business",
			usage(10, 20, { seven: "2026-07-21T14:00:00.000Z" }),
		);

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				preferredOrder: ["business"],
				quotaPreverified: true,
			}),
		);
	});

	it("never promotes unverifiable candidates through the legacy degraded-switch flag", async () => {
		const nextStore = store();
		nextStore.accounts.find((entry) => entry.name === "school")!.weeklyResetAt =
			"2026-07-21T14:00:00.000Z";
		nextStore.accounts.find(
			(entry) => entry.name === "business",
		)!.weeklyResetAt = "2026-07-19T14:00:00.000Z";
		h.setStore(nextStore);
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", { error: "network" });
		h.usages.set("secret-business", { error: "rate_limited" });
		h.deps.config = loadedConfig({ degradedSwitch: true });

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		expect(h.switchImpl).not.toHaveBeenCalled();
		expect(h.alerts.at(-1)?.kind).toBe("quota_no_target");
	});

	it("keeps degraded switching disabled by default", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", { error: "network" });
		h.usages.set("secret-business", { error: "network" });

		const result = await pollOnce(h.deps);
		expect(result.outcome).toBe("no_target");
		expect(h.switchImpl).not.toHaveBeenCalled();
	});

	it("does not invoke the executor for unverifiable candidates even when degraded switching is configured", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", { error: "network" });
		h.usages.set("secret-business", { error: "network" });
		h.deps.config = loadedConfig({ degradedSwitch: true });
		h.switchImpl.mockResolvedValueOnce({
			outcome: "failed",
			reason: "lease lost",
			reasonCode: "lock_lease_lost",
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		expect(h.switchImpl).not.toHaveBeenCalled();
		expect(h.alerts.at(-1)?.kind).toBe("quota_no_target");
	});

	it("maps a degraded no-account result back to no_target instead of an execution failure", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", { error: "network" });
		h.usages.set("secret-business", { error: "network" });
		h.deps.config = loadedConfig({ degradedSwitch: true });
		h.switchImpl.mockResolvedValueOnce({
			outcome: "no_account",
			earliestReset: null,
			reasonCode: "no_eligible_account",
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		expect(h.alerts.at(-1)?.kind).toBe("quota_no_target");
		expect(
			h.alerts.some((alert) => alert.kind === "account_switch_failed"),
		).toBe(false);
	});

	it("requires both candidate windows below 100 and never considers accounts outside pool∩store∩order", async () => {
		h.usages.set("secret-shopping", usage(90, 20));
		h.usages.set("secret-school", usage(100, 10));
		delete h.credentials.business;

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		expect(h.switchImpl).not.toHaveBeenCalled();
		expect(h.alerts.at(-1)).toMatchObject({ kind: "quota_no_target" });
		expect(h.alerts.at(-1)?.body).toContain("school: quota_exhausted");
		expect(h.alerts.at(-1)?.body).toContain("business: not_in_pool");
	});

	it("live-verifies a cooldown candidate and can rank it after a healthy observation", async () => {
		const nextStore = store();
		const school = nextStore.accounts.find((entry) => entry.name === "school");
		if (school) {
			school.quotaExhaustedUntil = "2026-07-15T20:00:00Z";
			school.lastObservedAt = "2026-07-14T19:00:00Z";
		}
		nextStore.accounts.find((entry) => entry.name === "business")!.authExpired =
			true;
		h.setStore(nextStore);
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", usage(20, 30));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.verifyCandidate).toHaveBeenCalledWith("school", "shopping");
		expect(h.recordObservation).toHaveBeenCalledWith(
			"school",
			expect.objectContaining({ fiveHPct: 20, sevenDPct: 30 }),
			4,
		);
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({ preferredOrder: ["school"] }),
		);
	});

	it("does not re-verify or rank the account carrying a post-switch cooldown", async () => {
		const nextStore = store();
		nextStore.generation = 5;
		nextStore.activeAccount = "school";
		nextStore.accounts.find(
			(entry) => entry.name === "shopping",
		)!.switchCooldownUntil = "2026-07-14T23:00:00Z";
		nextStore.accounts.find((entry) => entry.name === "business")!.authExpired =
			true;
		h.setStore(nextStore);
		h.setIdentity("school", 5);
		h.deps.state = {
			...emptyQuotaMonitorState(5),
			lastSwitchAt: NOW - 20 * 60_000,
		};
		h.usages.set("secret-school", usage(95, 20));
		h.usages.set("secret-shopping", usage(10, 20));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		expect(h.verifyCandidate).not.toHaveBeenCalledWith("shopping", "school");
		expect(h.recordObservation).not.toHaveBeenCalledWith(
			"shopping",
			expect.anything(),
			expect.anything(),
		);
		expect(h.alerts.at(-1)?.body).toContain("shopping: switch_cooldown");
	});

	it("keeps a live-verified candidate eligible when observation projection fails", async () => {
		const nextStore = store();
		nextStore.accounts.find((entry) => entry.name === "business")!.authExpired =
			true;
		h.setStore(nextStore);
		h.usages.set("secret-shopping", usage(95, 20));
		h.recordObservation.mockImplementation(async (name) =>
			name === "school" ? "write_failed" : "updated",
		);

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({ preferredOrder: ["school"] }),
		);
		expect(h.deps.log).toHaveBeenCalledWith(
			expect.stringContaining("result=write_failed"),
		);
	});

	it("propagates a typed projection interruption before using a stale snapshot", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		const interrupted = new Error("account lock reconciled");
		h.recordObservation.mockRejectedValueOnce(interrupted);

		await expect(pollOnce(h.deps)).rejects.toBe(interrupted);
		expect(h.switchImpl).not.toHaveBeenCalled();
	});

	it("passes a verification timestamp so a newer exhausted fact wins before apply", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		const selected: string[] = [];
		h.switchImpl.mockImplementationOnce(async (input) => {
			const nextStore = store();
			nextStore.accounts.find(
				(entry) => entry.name === "school",
			)!.quotaExhaustedUntil = "2026-07-15T20:00:00Z";
			nextStore.accounts.find(
				(entry) => entry.name === "school",
			)!.lastObservedAt = new Date(NOW + 1).toISOString();
			const next = selectNextAccount(nextStore, input);
			if (next) selected.push(next);
			return next === null
				? {
						outcome: "no_account" as const,
						earliestReset: null,
						reasonCode: "no_eligible_account" as const,
					}
				: {
						outcome: "switched" as const,
						from: "shopping",
						to: next,
						generation: 5,
					};
		});

		await pollOnce(h.deps);

		expect(selected).toEqual(["business"]);
	});

	it("does not project failed candidate fetches and keeps quota-exhausted slots fresh", async () => {
		h.usages.set("secret-shopping", usage(71, 20));
		h.usages.set("secret-school", { error: "network" });
		const nextStore = store();
		nextStore.accounts.find(
			(entry) => entry.name === "business",
		)!.quotaExhaustedUntil = "2026-07-15T20:00:00Z";
		h.setStore(nextStore);

		await pollOnce(h.deps);

		expect(h.fetchUsage.mock.calls.map(([token]) => token)).toEqual([
			"secret-shopping",
			"secret-school",
			"secret-business",
		]);
		expect(h.observations.map(({ name }) => name)).toEqual([
			"shopping",
			"business",
		]);
	});

	it("monitor-only and persisted switch cooldown stop before candidate freshness or switching", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.deps.config = loadedConfig({ order: [] });
		let result = await pollOnce(h.deps);
		expect(result.outcome).toBe("no_target");
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(h.alerts.at(-1)?.body).toContain("monitor-only");

		h = harness();
		h.usages.set("secret-shopping", usage(95, 20));
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			lastSwitchAt: NOW - 5 * 60_000,
		};
		result = await pollOnce(h.deps);
		expect(result.outcome).toBe("cooldown");
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(h.switchImpl).not.toHaveBeenCalled();
	});

	it("persists switch ownership and refreshes the new active without a caller-side success alert", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.switchImpl.mockImplementationOnce(async (input) => {
			const selected = input.preferredOrder?.[0] ?? "school";
			h.setIdentity(selected, 5);
			const next = store();
			next.generation = 5;
			next.activeAccount = selected;
			h.setStore(next);
			return {
				outcome: "switched",
				from: "shopping",
				to: selected,
				generation: 5,
			};
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		const firstSwitchPersist = h.events.findIndex((e) => e === "persist:0");
		const revive = h.events.lastIndexOf("revive");
		const newPoll = h.events.lastIndexOf("fetch:business");
		expect(firstSwitchPersist).toBeGreaterThanOrEqual(0);
		expect(firstSwitchPersist).toBeLessThan(revive);
		expect(revive).toBeLessThan(newPoll);
		expect(h.alerts.some((alert) => alert.kind === "account_switched")).toBe(
			false,
		);
		expect(h.readPoolIdentity.mock.calls.map(([name]) => name)).toEqual([
			"shopping",
			"business",
			"school",
		]);
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: { kind: "quota", scope: "5h", resetAt: FIVE_RESET },
				notificationContext: expect.objectContaining({
					identityByName: expect.any(Map),
					usageByName: expect.any(Map),
				}),
			}),
		);
	});

	it("maps typed switch exhaustion and environment failures to account_switch_failed", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.switchImpl.mockResolvedValueOnce({
			outcome: "no_account",
			earliestReset: null,
			reasonCode: "target_stale_exhausted",
		});
		let result = await pollOnce(h.deps);
		expect(result.outcome).toBe("switch_failed");
		expect(h.alerts.at(-1)?.kind).toBe("account_switch_failed");

		h = harness();
		h.usages.set("secret-shopping", usage(95, 20));
		h.switchImpl.mockResolvedValueOnce({
			outcome: "failed",
			reason: "helper unavailable",
			reasonCode: "freshness_unavailable",
		});
		result = await pollOnce(h.deps);
		expect(result.outcome).toBe("switch_failed");
		expect(h.alerts.at(-1)?.body).toContain(
			"reason=freshness_unavailable; degraded=false; exit=none; child=unknown; detail=",
		);
	});

	it("persists and reports atomic-apply contract evidence without attempting reconcile", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		const detail =
			"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH | Error: delegated profile mutation requires marker";
		h.switchImpl.mockResolvedValueOnce({
			outcome: "failed",
			reason: "must not reach operator output sk-ant-oat01-FAKETOKEN",
			reasonCode: "apply_contract_mismatch",
			applyEvidence: { exitCode: 48, childStarted: true, detail },
			applyProfileChildStarted: true,
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switch_failed");
		expect(h.reconcileMachine).not.toHaveBeenCalled();
		expect(result.state.pendingSwitchFailure).toMatchObject({
			reasonCode: "apply_contract_mismatch",
			applyExitCode: 48,
			childStarted: true,
			detail,
		});
		const failureLog = vi
			.mocked(h.deps.log)
			.mock.calls.map(([line]) => line)
			.find((line) => line.includes('"event":"account_switch_failed"'));
		expect(JSON.parse(failureLog ?? "{}")).toEqual({
			event: "account_switch_failed",
			trigger: { kind: "quota", scope: "5h" },
			reasonCode: "apply_contract_mismatch",
			exitCode: 48,
			childStarted: true,
			detail,
		});
		expect(h.alerts.at(-1)?.body).toBe(
			[
				"daemon runtime predates the switch script; restart quota-monitor or re-run the deploy wave",
				`reason=apply_contract_mismatch; degraded=false; exit=48; child=started; detail=${detail}`,
			].join("\n"),
		);
		expect(JSON.stringify(result.state)).not.toContain("FAKETOKEN");
		expect(h.alerts.at(-1)?.body).not.toContain("FAKETOKEN");
		expect(failureLog).not.toContain("FAKETOKEN");
	});

	it("carries real adapter and executor exit-48 evidence into daemon logs, state, and alert", async () => {
		const fixture = mkdtempSync(join(tmpdir(), "fly2271-quota-integration-"));
		try {
			const storePath = join(fixture, "accounts.json");
			const lockPath = join(fixture, "accounts.lock");
			writeStore(store(), storePath);
			const lease = {
				lockPath,
				markerPath: join(lockPath, "holder.1.fixture"),
				ownershipToken: "fixture",
			};
			const profileDeps = makeClaudeProfileSwitchDeps({
				binPath: "/fixture/flywheel-claude-profile",
				storePath,
				lockPath,
				execFile: vi.fn(async () => {
					throw Object.assign(new Error("delegated mutation refused"), {
						code: 48,
						stderr:
							"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH\nError: delegated profile mutation requires marker",
						profileChildStarted: true,
					});
				}) as never,
				withLock: async (_path, fn) => ({
					kind: "ok",
					value: await fn(lease),
				}),
			});
			h.deps.switchAccount = (input) =>
				switchAccount(input, {
					...profileDeps,
					renewLock: () => true,
					validateLease: () => true,
					resolveMachineAccount: () => ({
						kind: "resolved",
						name: "shopping",
					}),
				});
			h.usages.set("secret-shopping", usage(95, 20));

			const result = await pollOnce(h.deps);
			const failureLog = vi
				.mocked(h.deps.log)
				.mock.calls.map(([line]) => line)
				.find((line) => line.includes('"event":"account_switch_failed"'));
			const marker = "FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH";

			expect(result.outcome).toBe("switch_failed");
			expect(failureLog).toContain(marker);
			expect(result.state.pendingSwitchFailure).toMatchObject({
				applyExitCode: 48,
				childStarted: true,
				detail: expect.stringContaining(marker),
			});
			expect(h.alerts.at(-1)?.body).toContain(marker);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("strictly reconciles active-marker drift outside the lock and retries from a fresh snapshot once", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.switchImpl
			.mockResolvedValueOnce({
				outcome: "failed",
				reason: "drift",
				reasonCode: "active_marker_drift",
				applyEvidence: {
					exitCode: 46,
					childStarted: true,
					detail: "FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE shopping",
				},
			})
			.mockResolvedValueOnce({
				outcome: "switched",
				from: "school",
				to: "business",
				generation: 6,
			});
		h.reconcileMachine.mockImplementationOnce(async () => {
			expect(h.getLockDepth()).toBe(0);
			const next = store();
			next.generation = 5;
			next.activeAccount = "school";
			h.setIdentity("school", 5);
			h.setStore(next);
			return {
				ok: true,
				outcome: "repaired",
				from: "shopping",
				to: "school",
				exitCode: 0,
				detail: "FLYWHEEL_STALE_ACTIVE_RECONCILED shopping school",
			};
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.reconcileMachine).toHaveBeenCalledTimes(1);
		expect(h.switchImpl).toHaveBeenCalledTimes(2);
		expect(h.switchImpl.mock.calls[1]?.[0]).toMatchObject({
			observedAccount: "school",
			observedGeneration: 5,
			preferredOrder: ["business"],
		});
		expect(h.deps.log).toHaveBeenCalledWith(
			JSON.stringify({
				event: "account_switch_reconcile",
				trigger: "drift_recovery",
				ok: true,
				outcome: "repaired",
				from: "shopping",
				to: "school",
				exitCode: 0,
				detail: "FLYWHEEL_STALE_ACTIVE_RECONCILED shopping school",
			}),
		);
		expect(
			h.alerts.some((alert) => alert.kind === "account_switch_failed"),
		).toBe(false);
	});

	it("does not retry when reconcile makes the sole preferred target active", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.deps.config = loadedConfig({ order: ["shopping", "school"] });
		delete h.credentials.business;
		h.switchImpl.mockResolvedValueOnce({
			outcome: "failed",
			reason: "drift",
			reasonCode: "active_marker_drift",
			applyEvidence: {
				exitCode: 46,
				childStarted: true,
				detail: "FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE shopping",
			},
		});
		h.reconcileMachine.mockImplementationOnce(async () => {
			const next = store();
			next.generation = 5;
			next.activeAccount = "school";
			h.setIdentity("school", 5);
			h.setStore(next);
			return {
				ok: true,
				outcome: "repaired",
				from: "shopping",
				to: "school",
				exitCode: 0,
				detail: "FLYWHEEL_STALE_ACTIVE_RECONCILED shopping school",
			};
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("noop_already_switched");
		expect(h.switchImpl).toHaveBeenCalledTimes(1);
		expect(result.state.pendingSwitchFailure).toBeNull();
	});

	it("reconciles and retries active-marker drift at most once", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		const drift = (detail: string) => ({
			outcome: "failed" as const,
			reason: "drift",
			reasonCode: "active_marker_drift" as const,
			applyEvidence: { exitCode: 46, childStarted: true, detail },
		});
		h.switchImpl
			.mockResolvedValueOnce(drift("FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE first"))
			.mockResolvedValueOnce(
				drift("FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE second"),
			);
		h.reconcileMachine.mockImplementationOnce(async () => {
			const next = store();
			next.generation = 5;
			next.activeAccount = "school";
			h.setIdentity("school", 5);
			h.setStore(next);
			return {
				ok: true,
				outcome: "repaired",
				from: "shopping",
				to: "school",
				exitCode: 0,
				detail: "FLYWHEEL_STALE_ACTIVE_RECONCILED shopping school",
			};
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switch_failed");
		expect(h.switchImpl).toHaveBeenCalledTimes(2);
		expect(h.reconcileMachine).toHaveBeenCalledTimes(1);
		expect(result.state.pendingSwitchFailure?.detail).toBe(
			"drift persisted after reconcile: FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE second",
		);
	});

	it("records a failed strict reconcile and does not retry the switch", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.switchImpl.mockResolvedValueOnce({
			outcome: "failed",
			reason: "drift",
			reasonCode: "active_marker_drift",
			applyEvidence: {
				exitCode: 46,
				childStarted: true,
				detail: "FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE shopping",
			},
		});
		h.reconcileMachine.mockResolvedValueOnce({
			ok: false,
			outcome: "unresolvable",
			reason: "anchor_ambiguous",
			exitCode: 20,
			detail: "FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE shopping",
		});

		const result = await pollOnce(h.deps);

		expect(h.switchImpl).toHaveBeenCalledTimes(1);
		expect(result.state.pendingSwitchFailure?.detail).toBe(
			"reconcile unresolvable: anchor_ambiguous: FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE shopping: FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE shopping",
		);
	});

	it.each(["retry", "noop"] as const)(
		"keeps first-attempt identity reports when drift recovery ends in %s",
		async (ending) => {
			h.usages.set("secret-shopping", usage(95, 20));
			if (ending === "noop") {
				h.deps.config = loadedConfig({ order: ["shopping", "school"] });
				delete h.credentials.business;
			}
			const identityCheck = {
				label: "school",
				checkpoint: "pre_write" as const,
				verdict: "mismatch" as const,
				expectedKey: "b".repeat(64),
				actualDigest: "a".repeat(64),
			};
			h.switchImpl.mockResolvedValueOnce({
				outcome: "failed",
				reason: "drift",
				reasonCode: "active_marker_drift",
				applyReports: [
					{
						identityChecks: [identityCheck],
						freshened: {
							name: "business",
							identityProof: {
								email: "business@example.com",
								uuid: "uuid-business",
							},
						},
					},
				],
				applyEvidence: {
					exitCode: 46,
					childStarted: true,
					detail: "FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE shopping",
				},
			});
			if (ending === "retry") {
				h.switchImpl.mockResolvedValueOnce({
					outcome: "switched",
					from: "school",
					to: "business",
					generation: 6,
					applyReports: [{ identityChecks: [identityCheck] }],
				});
			}
			h.reconcileMachine.mockImplementationOnce(async () => {
				const next = store();
				next.generation = 5;
				next.activeAccount = "school";
				h.setIdentity("school", 5);
				h.setStore(next);
				return {
					ok: true,
					outcome: "repaired",
					from: "shopping",
					to: "school",
					exitCode: 0,
					detail: "FLYWHEEL_STALE_ACTIVE_RECONCILED shopping school",
				};
			});

			const result = await pollOnce(h.deps);

			expect(result.outcome).toBe(
				ending === "retry" ? "switched" : "noop_already_switched",
			);
			expect(result.state.identityMismatchEpisodes?.school).toMatchObject({
				checkpoint: "pre_write",
				expectedKey: "b".repeat(64),
				actualDigest: "a".repeat(64),
			});
			expect(
				h.alerts.filter((alert) => alert.kind === "account_identity_mismatch"),
			).toHaveLength(1);
		},
	);

	it("updates child evidence without reopening the same failure episode", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		const failure = (exitCode: number, detail: string): SwitchResult => ({
			outcome: "failed",
			reason: "safe",
			reasonCode: "apply_failed",
			applyEvidence: { exitCode, childStarted: true, detail },
		});
		h.switchImpl.mockResolvedValue(failure(31, "first"));

		let result = await pollOnce(h.deps);
		const startedAt = result.state.pendingSwitchFailure?.startedAt;
		h.deps.state = result.state;
		h.switchImpl.mockResolvedValue(failure(31, "second"));
		h.setNow(result.state.nextUsageDueAt);
		result = await pollOnce(h.deps);
		expect(result.state.pendingSwitchFailure).toMatchObject({
			startedAt,
			detail: "second",
			alertCount: 1,
		});
		expect(h.persisted).toContainEqual(
			expect.objectContaining({
				pendingSwitchFailure: expect.objectContaining({ detail: "second" }),
			}),
		);

		h.deps.state = result.state;
		h.switchImpl.mockResolvedValue(failure(32, "third"));
		h.setNow(result.state.nextUsageDueAt);
		result = await pollOnce(h.deps);
		expect(result.state.pendingSwitchFailure).toMatchObject({
			applyExitCode: 32,
			detail: "third",
			alertCount: 1,
		});
		expect(result.state.pendingSwitchFailure?.startedAt).toBe(startedAt);
		expect(
			h.alerts.filter((alert) => alert.kind === "account_switch_failed"),
		).toHaveLength(1);
	});

	it("keeps model-cap failure evidence immediate and out of the durable quota episode", async () => {
		h.scanPanes.mockResolvedValueOnce(paneSnapshot(["Fable 5"]));
		h.switchImpl.mockResolvedValueOnce({
			outcome: "failed",
			reason: "stale runtime",
			reasonCode: "apply_contract_mismatch",
			applyEvidence: {
				exitCode: 48,
				childStarted: true,
				detail: "FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH",
			},
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switch_failed");
		expect(result.state.pendingSwitchFailure).toBeNull();
		expect(h.alerts.at(-1)?.body).toContain(
			"reason=apply_contract_mismatch; degraded=false; exit=48; child=started; detail=FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH",
		);
		const failureLog = vi
			.mocked(h.deps.log)
			.mock.calls.map(([line]) => line)
			.find((line) => line.includes('"event":"account_switch_failed"'));
		expect(JSON.parse(failureLog ?? "{}")).toMatchObject({
			trigger: { kind: "model", models: ["Fable 5"] },
			exitCode: 48,
			childStarted: true,
		});
	});

	it("alerts quota_monitor_down after six consecutive current-usage errors", async () => {
		h.usages.set("secret-shopping", { error: "network" });
		h.deps.state = { ...emptyQuotaMonitorState(4), errorStreak: 5 };

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("error");
		expect(result.state.errorStreak).toBe(6);
		expect(h.alerts.at(-1)?.kind).toBe("quota_monitor_down");
	});

	it("opens and confirms a no-target episode with persist-before-deliver ordering", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", usage(100, 20));
		h.usages.set("secret-business", usage(100, 20));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		expect(h.alerts.at(-1)).toMatchObject({
			kind: "quota_no_target",
			signature: expect.stringMatching(/-r1-a0$/),
		});
		expect(result.state.blockedEpisode).toMatchObject({
			scope: "5h",
			alertCount: 1,
			blockedRound: 1,
			activeDelivery: null,
		});
		const persisted = h.events.indexOf("persist:0");
		const delivered = h.events.indexOf("alert:quota_no_target");
		expect(persisted).toBeGreaterThanOrEqual(0);
		expect(persisted).toBeLessThan(delivered);
	});

	it("retries an unconfirmed no-target round with a new attempt signature before backoff", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", usage(100, 20));
		h.usages.set("secret-business", usage(100, 20));
		h.alertImpl
			.mockResolvedValueOnce({ primary: "dead_lettered" })
			.mockResolvedValueOnce({ primary: "duplicate" });

		let result = await pollOnce(h.deps);
		expect(result.state.blockedEpisode?.activeDelivery).toMatchObject({
			kind: "blocked",
			round: 1,
			attempts: 1,
		});
		expect(h.alerts.at(-1)?.signature).toMatch(/-r1-a0$/);

		h.deps.state = {
			...result.state,
			backoffUntilMs: NOW + 10 * 60_000,
		};
		h.setNow(NOW + 59_000);
		result = await pollOnce(h.deps);

		expect(result.outcome).toBe("backoff");
		expect(h.alerts.at(-1)?.signature).toMatch(/-r1-a1$/);
		expect(result.state.blockedEpisode?.activeDelivery).toMatchObject({
			round: 1,
			attempts: 2,
		});
	});

	it("re-alerts a confirmed blocked episode on a new round after the interval", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", usage(100, 20));
		h.usages.set("secret-business", usage(100, 20));

		let result = await pollOnce(h.deps);
		h.deps.state = result.state;
		h.setNow(NOW + 31 * 60_000);
		result = await pollOnce(h.deps);

		expect(
			h.alerts.filter((alert) => alert.kind === "quota_no_target"),
		).toHaveLength(2);
		expect(h.alerts.at(-1)?.signature).toMatch(/-r2-a0$/);
		expect(result.state.blockedEpisode).toMatchObject({
			alertCount: 2,
			blockedRound: 2,
			activeDelivery: null,
		});
	});

	it("sends and confirms recovery in the first healthy tick before clearing the episode", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", usage(100, 20));
		h.usages.set("secret-business", usage(100, 20));

		let result = await pollOnce(h.deps);
		h.deps.state = result.state;
		h.usages.set("secret-shopping", usage(40, 20));
		h.setNow(result.state.nextUsageDueAt);
		result = await pollOnce(h.deps);

		expect(result.outcome).toBe("observed");
		expect(h.alerts.at(-1)).toMatchObject({
			kind: "quota_blocked_recovered",
			signature: expect.stringMatching(/-r1-a0$/),
		});
		expect(result.state.blockedEpisode).toBeNull();
	});

	it("opens monitor-only no-target as a persistent episode", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.deps.config = loadedConfig({ order: [] });

		const result = await pollOnce(h.deps);

		expect(result.state.blockedEpisode).toMatchObject({
			scope: "5h",
			alertCount: 1,
			activeDelivery: null,
		});
	});

	it("keeps switch failures in their own retryable episode across observational backoff", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.switchImpl.mockResolvedValue({
			outcome: "failed",
			reason: "lease lost",
			reasonCode: "lock_lease_lost",
		});
		h.alertImpl
			.mockResolvedValueOnce({ primary: "dead_lettered" })
			.mockResolvedValueOnce({ primary: "duplicate" });

		let result = await pollOnce(h.deps);
		expect(result.state.pendingSwitchFailure?.activeDelivery).toMatchObject({
			round: 0,
			attempts: 1,
		});
		expect(h.alerts.at(-1)?.signature).toMatch(/-r0-a0$/);

		h.deps.state = {
			...result.state,
			backoffUntilMs: NOW + 10 * 60_000,
		};
		h.setNow(NOW + 59_000);
		result = await pollOnce(h.deps);

		expect(result.outcome).toBe("backoff");
		expect(h.alerts.at(-1)?.signature).toMatch(/-r0-a1$/);
		expect(result.state.pendingSwitchFailure?.activeDelivery).toMatchObject({
			round: 0,
			attempts: 2,
		});
	});

	it("allows attempt a5 immediately, then interval-throttles a6 without reusing a signature", async () => {
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			backoffUntilMs: NOW + 60 * 60_000,
			blockedEpisode: {
				scope: "5h",
				startedAt: new Date(NOW - 60_000).toISOString(),
				lastConfirmedAlertAt: null,
				alertCount: 0,
				blockedRound: 1,
				recoveryRound: 0,
				activeDelivery: {
					kind: "blocked",
					round: 1,
					attempts: 5,
					lastAttemptAt: new Date(NOW - 1_000).toISOString(),
				},
			},
		};
		h.alertImpl.mockResolvedValue({ primary: "dead_lettered" });

		let result = await pollOnce(h.deps);
		expect(h.alerts.at(-1)?.signature).toMatch(/-r1-a5$/);
		expect(result.state.blockedEpisode?.activeDelivery?.attempts).toBe(6);

		h.deps.state = result.state;
		h.setNow(NOW + 60_000);
		result = await pollOnce(h.deps);
		expect(h.alerts).toHaveLength(1);
		expect(result.state.blockedEpisode?.activeDelivery?.attempts).toBe(6);

		h.deps.state = result.state;
		h.setNow(NOW + 31 * 60_000);
		result = await pollOnce(h.deps);
		expect(h.alerts.at(-1)?.signature).toMatch(/-r1-a6$/);
		expect(result.state.blockedEpisode?.activeDelivery?.attempts).toBe(7);
	});

	it("can retry recovery then reopen blocked on a distinct round in the same tick", async () => {
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			blockedEpisode: {
				scope: "5h",
				startedAt: new Date(NOW - 60_000).toISOString(),
				lastConfirmedAlertAt: new Date(NOW - 60_000).toISOString(),
				alertCount: 1,
				blockedRound: 1,
				recoveryRound: 1,
				activeDelivery: {
					kind: "recovered",
					round: 1,
					attempts: 1,
					lastAttemptAt: new Date(NOW - 60_000).toISOString(),
				},
			},
		};
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", usage(100, 20));
		h.usages.set("secret-business", usage(100, 20));
		h.alertImpl
			.mockResolvedValueOnce({ primary: "duplicate" })
			.mockResolvedValueOnce({ primary: "dead_lettered" });

		const result = await pollOnce(h.deps);

		expect(h.alerts.map((alert) => alert.kind)).toEqual([
			"quota_blocked_recovered",
			"quota_no_target",
		]);
		expect(h.alerts[0]?.signature).toMatch(/-r1-a1$/);
		expect(h.alerts[1]?.signature).toMatch(/-r2-a0$/);
		expect(result.state.blockedEpisode?.activeDelivery).toMatchObject({
			kind: "blocked",
			round: 2,
			attempts: 1,
		});
	});

	it("attempts a carried switch-failure round only once when the same failure recurs", async () => {
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			pendingSwitchFailure: {
				reasonCode: "lock_lease_lost",
				degraded: false,
				startedAt: new Date(NOW - 60_000).toISOString(),
				lastConfirmedAlertAt: null,
				alertCount: 0,
				activeDelivery: {
					round: 0,
					attempts: 1,
					lastAttemptAt: new Date(NOW - 60_000).toISOString(),
				},
			},
		};
		h.usages.set("secret-shopping", usage(95, 20));
		h.switchImpl.mockResolvedValue({
			outcome: "failed",
			reason: "lease lost",
			reasonCode: "lock_lease_lost",
		});
		h.alertImpl.mockResolvedValue({ primary: "dead_lettered" });

		const result = await pollOnce(h.deps);

		expect(
			h.alerts.filter((alert) => alert.kind === "account_switch_failed"),
		).toHaveLength(1);
		expect(h.alerts.at(-1)?.signature).toMatch(/-r0-a1$/);
		expect(result.state.pendingSwitchFailure?.activeDelivery).toMatchObject({
			round: 0,
			attempts: 2,
		});
	});

	it("stops re-alerting a confirmed blocked episode after the alert cap", async () => {
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			blockedEpisode: {
				scope: "5h",
				startedAt: new Date(NOW - 24 * 60 * 60_000).toISOString(),
				lastConfirmedAlertAt: new Date(NOW - 60 * 60_000).toISOString(),
				alertCount: 10,
				blockedRound: 10,
				recoveryRound: 0,
				activeDelivery: null,
			},
		};
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", usage(100, 20));
		h.usages.set("secret-business", usage(100, 20));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		expect(h.alerts).toHaveLength(0);
		expect(result.state.blockedEpisode?.alertCount).toBe(10);
	});

	it("emits one token-safe structured outcome line with panorama and delivery summaries", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", usage(100, 20));
		h.usages.set("secret-business", { error: "network" });
		h.alertImpl.mockResolvedValue({
			primary: "queued_transient",
			secondary: "process_error",
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		const lines = vi
			.mocked(h.deps.log)
			.mock.calls.map(([line]) => line)
			.filter((line) => line.includes('"event":"quota_poll"'));
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			event: "quota_poll",
			outcome: "no_target",
			panorama: ["business:usage_network", "school:quota_exhausted"],
			delivery: [
				{
					kind: "quota_no_target",
					primary: "queued_transient",
					secondary: "process_error",
				},
			],
		});
		expect(lines[0]).not.toContain("secret-");
	});

	// FLY-1366: an account with no open window reports `resets_at: null`. The old
	// validator called that malformed, so every idle standby read as unverifiable
	// and a 100%-quota active account had "no target" to switch to.
	it("switches to an idle candidate whose 5h window has not opened yet", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", usage(0, 88, { five: null }));
		h.usages.set("secret-business", usage(100, 20));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: { kind: "quota", scope: "5h", resetAt: FIVE_RESET },
				preferredOrder: ["school"],
				quotaPreverified: true,
			}),
		);
		const line = vi
			.mocked(h.deps.log)
			.mock.calls.map(([entry]) => entry)
			.find((entry) => entry.includes('"event":"quota_poll"'));
		expect(JSON.parse(line ?? "{}").panorama).toEqual([
			"business:quota_exhausted",
			"school:qualified",
		]);
	});

	it("projects an unopened window as a null reset rather than a fabricated instant", async () => {
		h.usages.set("secret-shopping", usage(0, 10, { five: null }));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("observed");
		expect(h.observations).toContainEqual(
			expect.objectContaining({
				name: "shopping",
				observation: expect.objectContaining({
					fiveHPct: 0,
					fiveHResetAt: null,
					sevenDResetAt: WEEK_RESET,
				}),
			}),
		);
		expect(h.cacheWrites).toEqual([
			expect.objectContaining({
				five_hour: { utilization: 0, resets_at: null },
			}),
		]);
	});

	it("ranks a candidate with an unknown weekly reset after one with a dated reset", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		// `business` has neither a live nor ledger reset, so its unknown reset must
		// remain behind `school`'s dated reset.
		h.usages.set(
			"secret-school",
			usage(10, 20, { seven: "2026-07-19T14:00:00.000Z" }),
		);
		h.usages.set("secret-business", usage(10, 0, { seven: null }));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({ preferredOrder: ["school", "business"] }),
		);
	});

	it("carries the freshness refusal reason into the panorama and keeps the candidate unverifiable", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-business", usage(100, 20));
		h.verifyCandidate.mockImplementation(async (name: string) => {
			if (name === "school") {
				return {
					fresh: "stale" as const,
					reason: "refresh refused (HTTP 403)",
				};
			}
			return { fresh: "refreshed" as const, expiresAt: NOW + 3_600_000 };
		});
		h.deps.config = loadedConfig({ degradedSwitch: true });

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		expect(h.switchImpl).not.toHaveBeenCalled();
		const line = vi
			.mocked(h.deps.log)
			.mock.calls.map(([entry]) => entry)
			.find((entry) => entry.includes('"event":"quota_poll"'));
		expect(JSON.parse(line ?? "{}").panorama).toContain(
			"school:freshness_stale: refresh refused (HTTP 403)",
		);
	});

	it("fails closed before candidate or switch I/O when a triggering window reports no reset instant", async () => {
		// pct >= trigger means the window IS active, so a null reset is a contract
		// violation, not an idle account. Never fabricate a revive deadline from it.
		h.usages.set("secret-shopping", usage(95, 20, { five: null }));

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("error");
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(h.switchImpl).not.toHaveBeenCalled();
		expect(h.events.filter((event) => event.startsWith("fetch:"))).toEqual([
			"fetch:shopping",
		]);
		expect(result.state.reviveEpoch).toBeNull();
		expect(h.alerts).toEqual([
			expect.objectContaining({
				kind: "quota_monitor_down",
				// Distinct namespace: the usage-failure path already owns
				// `quota-monitor-down-<day>`, and lead-alert.sh dedupes on
				// project|lead|kind|signature — a shared signature would swallow one.
				signature: "quota-usage-reset-missing-shopping-5h-2026-07-14",
			}),
		]);
		const reported = vi
			.mocked(h.deps.log)
			.mock.calls.map(([entry]) => entry)
			.filter((entry) => entry.includes("usage_reset_missing"));
		expect(reported).toHaveLength(1);
		expect(JSON.parse(reported[0] ?? "{}")).toMatchObject({
			event: "usage_reset_missing",
			account: "shopping",
			scope: "5h",
		});
	});

	it("keeps failing closed on a missing reset even when the switch cooldown would have returned first", async () => {
		h.usages.set("secret-shopping", usage(95, 20, { five: null }));
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			lastSwitchAt: NOW - 60_000,
		};

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("error");
		expect(h.alerts.map((alert) => alert.kind)).toEqual(["quota_monitor_down"]);
	});
});
