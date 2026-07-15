import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStore } from "../account-heal/account-store.js";
import {
	pollOnce,
	type QuotaMonitorAlert,
	type QuotaMonitorDeps,
} from "../account-heal/quota-monitor.js";
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
	let lockDepth = 0;
	let activeName = "shopping";
	let generation = 4;
	let accountStore = store();
	const events: string[] = [];
	const persisted: unknown[] = [];
	const cacheWrites: unknown[] = [];
	const alerts: QuotaMonitorAlert[] = [];
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
	const verifyCandidate = vi.fn(async (name: string) => {
		expect(lockDepth).toBe(1);
		events.push(`verify:${name}`);
		return { fresh: "refreshed" as const, expiresAt: NOW + 3_600_000 };
	});
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

	const deps: QuotaMonitorDeps = {
		now: () => NOW,
		config: loadedConfig(),
		state: emptyQuotaMonitorState(4),
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
		},
		log: vi.fn(),
	};

	return {
		deps,
		events,
		persisted,
		cacheWrites,
		alerts,
		credentials,
		usages,
		fetchUsage,
		verifyCandidate,
		switchImpl,
		reviveScan,
		setIdentity(name: string, nextGeneration = generation) {
			activeName = name;
			generation = nextGeneration;
		},
		setStore(next: AccountStore) {
			accountStore = next;
			generation = next.generation;
		},
	};
}

let h: Harness;

beforeEach(() => {
	h = harness();
});

describe("pollOnce", () => {
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
			}),
		);
		expect(result.state.reviveEpoch).toMatchObject({
			open: true,
			sourceAccount: "shopping",
			generation: 5,
			expiresAt: Date.parse(WEEK_RESET) + 30 * 60_000,
		});
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
});
