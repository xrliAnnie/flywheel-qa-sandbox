import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileIdentityResult } from "../account-heal/account-identity.js";
import {
	type AccountQuotaObservation,
	type AccountStore,
	selectNextAccount,
} from "../account-heal/account-store.js";
import {
	pollOnce,
	type QuotaMonitorAlert,
	type QuotaMonitorDeps,
} from "../account-heal/quota-monitor.js";
import type { DeliveryReport } from "../account-heal/quota-monitor-alert.js";
import {
	DEFAULT_QUOTA_MONITOR_CONFIG,
	type LoadedQuotaMonitorConfig,
} from "../account-heal/quota-monitor-config.js";
import { emptyQuotaMonitorState } from "../account-heal/quota-monitor-state.js";
import type { AccountUsageResult } from "../account-heal/quota-usage-api.js";
import type { SwitchResult } from "../account-heal/switch-executor.js";

const NOW = Date.parse("2026-07-14T20:00:00Z");
const FIVE_RESET = "2026-07-14T23:00:00.000Z";
const WEEK_RESET = "2026-07-21T14:00:00.000Z";

function usage(
	fivePct: number,
	sevenPct: number,
	resets: { five?: string; seven?: string } = {},
): Extract<AccountUsageResult, { ok: unknown }> {
	const five = resets.five ?? FIVE_RESET;
	const seven = resets.seven ?? WEEK_RESET;
	const raw = {
		five_hour: { utilization: fivePct, resets_at: five },
		seven_day: { utilization: sevenPct, resets_at: seven },
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
	const reviveScan = vi.fn(
		async (state: ReturnType<typeof emptyQuotaMonitorState>) => {
			expect(lockDepth).toBe(0);
			events.push("revive");
			return {
				state,
				summary: { revived: 1, pending: 0, loginExpired: 0 },
			};
		},
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

	const deps: QuotaMonitorDeps = {
		now: () => now,
		config: loadedConfig(),
		state: emptyQuotaMonitorState(4),
		reconcileActive,
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
		readSnapshot: async () => {
			expect(lockDepth).toBe(1);
			return {
				activeName,
				store: structuredClone(accountStore),
				activeCredential: credentials[activeName] ?? null,
				poolAccounts: Object.keys(credentials),
			};
		},
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
		reviveScan,
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
		verifyCandidate,
		recordObservation,
		switchImpl,
		reviveScan,
		reconcileActive,
		alertImpl,
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
	delete process.env.FLYWHEEL_QUOTA_DEGRADED_SWITCH;
	delete process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK;
	h = harness();
});

afterEach(() => {
	delete process.env.FLYWHEEL_QUOTA_DEGRADED_SWITCH;
	delete process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK;
});

describe("pollOnce", () => {
	it("active identity mismatch is terminal before usage projection or switching", async () => {
		process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK = "1";
		const next = store();
		next.accounts.find((account) => account.name === "shopping")!.identity = {
			email: "shopping@example.com",
			uuid: "uuid-shopping",
			setAt: new Date(NOW - 60_000).toISOString(),
		};
		h.setStore(next);
		h.fetchIdentity.mockResolvedValueOnce({
			email: "intruder@example.com",
			uuid: "uuid-intruder",
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("identity_mismatch_active");
		expect(h.fetchIdentity).toHaveBeenCalledWith("secret-shopping");
		expect(h.fetchUsage).not.toHaveBeenCalled();
		expect(h.recordObservation).not.toHaveBeenCalled();
		expect(h.switchImpl).not.toHaveBeenCalled();
		expect(h.alerts.map((alert) => alert.kind)).toEqual([
			"account_identity_mismatch",
		]);
		expect(result.state.identityMismatchEpisodes?.shopping).toMatchObject({
			checkpoint: "active",
			alertCount: 1,
		});
	});

	it("active identity unknown warns but keeps the usage tick live", async () => {
		process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK = "1";
		const next = store();
		next.accounts.find((account) => account.name === "shopping")!.identity = {
			email: "shopping@example.com",
			uuid: "uuid-shopping",
			setAt: new Date(NOW - 60_000).toISOString(),
		};
		h.setStore(next);
		h.fetchIdentity.mockResolvedValueOnce({ error: "profile_network" });

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("observed");
		expect(h.fetchUsage).toHaveBeenCalledWith("secret-shopping");
		expect(h.alerts).toEqual([]);
		expect(h.deps.log).toHaveBeenCalledWith(
			expect.stringContaining('"reason":"profile_network"'),
		);
	});

	it("a confirmed active match clears the matching identity episode", async () => {
		process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK = "1";
		const next = store();
		next.accounts.find((account) => account.name === "shopping")!.identity = {
			email: "shopping@example.com",
			uuid: "uuid-shopping",
			setAt: new Date(NOW - 60_000).toISOString(),
		};
		h.setStore(next);
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			identityMismatchEpisodes: {
				shopping: {
					checkpoint: "active",
					expectedKey: "b".repeat(64),
					actualDigest: "a".repeat(64),
					startedAt: new Date(NOW - 60_000).toISOString(),
					lastConfirmedAlertAt: new Date(NOW - 30_000).toISOString(),
					alertCount: 1,
					round: 1,
					activeDelivery: null,
				},
			},
			identityAlertCursor: "shopping",
		};

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("observed");
		expect(result.state.identityMismatchEpisodes).toBeNull();
		expect(result.state.identityAlertCursor).toBeNull();
		expect(h.alerts).toEqual([]);
	});

	it("a confirmed candidate match after audit reconciliation clears an older checkpoint episode", async () => {
		process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK = "1";
		const next = store();
		for (const account of next.accounts) {
			account.identity = {
				email: `${account.name}@example.com`,
				uuid: `uuid-${account.name}`,
				setAt: new Date(NOW - 60_000).toISOString(),
			};
		}
		// The audit has already cleared school.identityMismatch in the store.
		h.setStore(next);
		h.usages.set("secret-shopping", usage(100, 20));
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			identityMismatchEpisodes: {
				school: {
					checkpoint: "pre_write",
					expectedKey: "b".repeat(64),
					actualDigest: "a".repeat(64),
					startedAt: new Date(NOW - 60_000).toISOString(),
					lastConfirmedAlertAt: new Date(NOW - 30_000).toISOString(),
					alertCount: 1,
					round: 1,
					activeDelivery: null,
				},
			},
			identityAlertCursor: "school",
		};

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.fetchIdentity).toHaveBeenCalledWith("secret-school");
		expect(result.state.identityMismatchEpisodes).toBeNull();
		expect(result.state.identityAlertCursor).toBeNull();
	});

	it("candidate mismatch is ineligible while a network-unknown candidate remains rankable", async () => {
		process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK = "1";
		const next = store();
		for (const account of next.accounts) {
			account.identity = {
				email: `${account.name}@example.com`,
				uuid: `uuid-${account.name}`,
				setAt: new Date(NOW - 60_000).toISOString(),
			};
		}
		h.setStore(next);
		h.usages.set("secret-shopping", usage(100, 20));
		h.fetchIdentity.mockImplementation(async (token) => {
			if (token === "secret-school") {
				return { email: "intruder@example.com", uuid: "uuid-intruder" };
			}
			if (token === "secret-business") return { error: "profile_network" };
			const label = token.replace("secret-", "");
			return { email: `${label}@example.com`, uuid: `uuid-${label}` };
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({ preferredOrder: ["business"] }),
		);
		expect(h.fetchIdentity).toHaveBeenCalledWith("secret-school");
		expect(h.fetchIdentity).toHaveBeenCalledWith("secret-business");
		expect(
			h.alerts.some((alert) => alert.kind === "account_identity_mismatch"),
		).toBe(true);
		expect(result.state.identityMismatchEpisodes?.school).toMatchObject({
			checkpoint: "candidate",
		});
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
		expect(h.reviveScan).not.toHaveBeenCalled();
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
		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("observed");
		expect(result.state).toMatchObject({
			lastPollAt: NOW,
			lastSuccessfulUsageAt: NOW,
			errorStreak: 0,
			tier: "base",
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

		h = harness();
		h.deps.state = {
			...emptyQuotaMonitorState(4),
			backoffUntilMs: NOW + 1,
		};
		result = await pollOnce(h.deps);
		expect(result.outcome).toBe("backoff");
		expect(h.fetchUsage).not.toHaveBeenCalled();
	});

	it("accelerates above the configured watermark and sweeps candidates without probe-refresh", async () => {
		h.usages.set("secret-shopping", usage(71, 20));
		h.credentials.business.expiresAt = NOW - 1;

		const result = await pollOnce(h.deps);

		expect(result.state.tier).toBe("accelerated");
		expect(result.state.lastCandidateSweepAt).toBe(NOW);
		expect(h.verifyCandidate).not.toHaveBeenCalled();
		expect(h.fetchUsage.mock.calls.map(([token]) => token)).toEqual([
			"secret-shopping",
			"secret-school",
		]);
		expect(h.observations.map(({ name }) => name)).toEqual([
			"shopping",
			"school",
		]);
	});

	it("does not project a mislabeled credential during the accelerated candidate sweep", async () => {
		process.env.FLYWHEEL_ACCOUNT_IDENTITY_CHECK = "1";
		const next = store();
		for (const account of next.accounts) {
			account.identity = {
				email: `${account.name}@example.com`,
				uuid: `uuid-${account.name}`,
				setAt: new Date(NOW - 60_000).toISOString(),
			};
		}
		h.setStore(next);
		h.usages.set("secret-shopping", usage(71, 20));
		h.credentials.business.expiresAt = NOW - 1;
		h.fetchIdentity.mockImplementation(async (token) =>
			token === "secret-school"
				? { email: "intruder@example.com", uuid: "uuid-intruder" }
				: {
						email: `${token.replace("secret-", "")}@example.com`,
						uuid: `uuid-${token.replace("secret-", "")}`,
					},
		);

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("observed");
		expect(h.fetchUsage.mock.calls.map(([token]) => token)).toEqual([
			"secret-shopping",
		]);
		expect(h.observations.map(({ name }) => name)).toEqual(["shopping"]);
		expect(result.state.identityMismatchEpisodes?.school).toMatchObject({
			checkpoint: "candidate",
		});
		expect(h.alerts.map((alert) => alert.kind)).toContain(
			"account_identity_mismatch",
		);
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
			"school",
			"business",
		]);
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "weekly",
				resetAt: WEEK_RESET,
				preferredOrder: ["business", "school"],
				verifiedAt: new Date(NOW).toISOString(),
			}),
		);
		expect(h.observations.map(({ name }) => name)).toEqual([
			"shopping",
			"school",
			"business",
		]);
		expect(result.state.reviveEpoch).toMatchObject({
			open: true,
			sourceAccount: "shopping",
			generation: 5,
			expiresAt: Date.parse(WEEK_RESET) + 30 * 60_000,
		});
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
				preferredOrder: ["business", "school"],
				quotaPreverified: true,
			}),
		);
	});

	it("uses store-usable unverifiable candidates only when degraded switching is enabled", async () => {
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

		expect(result.outcome).toBe("switched");
		expect(h.switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				preferredOrder: ["business", "school"],
				quotaPreverified: false,
			}),
		);
		expect(h.alerts.at(-1)?.kind).toBe("account_switch_degraded");
	});

	it("keeps degraded switching disabled by default and honors the emergency env suppression", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", { error: "network" });
		h.usages.set("secret-business", { error: "network" });

		let result = await pollOnce(h.deps);
		expect(result.outcome).toBe("no_target");
		expect(h.switchImpl).not.toHaveBeenCalled();

		h = harness();
		h.usages.set("secret-shopping", usage(95, 20));
		h.usages.set("secret-school", { error: "network" });
		h.usages.set("secret-business", { error: "network" });
		h.deps.config = loadedConfig({ degradedSwitch: true });
		process.env.FLYWHEEL_QUOTA_DEGRADED_SWITCH = "0";

		result = await pollOnce(h.deps);
		expect(result.outcome).toBe("no_target");
		expect(h.switchImpl).not.toHaveBeenCalled();
	});

	it("preserves degraded execution failures as account_switch_failed rather than no_target", async () => {
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

		expect(result.outcome).toBe("switch_failed");
		expect(h.alerts.at(-1)?.kind).toBe("account_switch_failed");
		expect(h.alerts.at(-1)?.body).toContain("degraded=true");
		expect(h.alerts.some((alert) => alert.kind === "quota_no_target")).toBe(
			false,
		);
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

	it("does not project failed candidate fetches and preserves sweep cooldown prefilter", async () => {
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
		]);
		expect(h.observations.map(({ name }) => name)).toEqual(["shopping"]);
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

	it("persists switch ownership before revive, then alerts and refreshes the new active", async () => {
		h.usages.set("secret-shopping", usage(95, 20));
		h.switchImpl.mockImplementationOnce(async (input) => {
			h.setIdentity("school", 5);
			const next = store();
			next.generation = 5;
			next.activeAccount = "school";
			h.setStore(next);
			return {
				outcome: "switched",
				from: "shopping",
				to: input.preferredOrder?.[0] ?? "school",
				generation: 5,
			};
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("switched");
		const firstSwitchPersist = h.events.findIndex((e) => e === "persist:0");
		const revive = h.events.indexOf("revive");
		const alert = h.events.indexOf("alert:account_switched");
		const newPoll = h.events.lastIndexOf("fetch:school");
		expect(firstSwitchPersist).toBeGreaterThanOrEqual(0);
		expect(firstSwitchPersist).toBeLessThan(revive);
		expect(revive).toBeLessThan(alert);
		expect(alert).toBeLessThan(newPoll);
		expect(h.alerts.at(-1)?.body).toContain("revived=1");
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
		expect(h.alerts.at(-1)?.body).toContain("freshness_unavailable");
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
		h.setNow(NOW + 60_000);
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
		h.setNow(NOW + 60_000);
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
		h.setNow(NOW + 60_000);
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
			panorama: ["school:quota_exhausted", "business:usage_network"],
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
});
