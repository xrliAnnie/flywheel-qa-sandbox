import { describe, expect, it, vi } from "vitest";
import type { CodexAccountQuotaStore } from "../codex-account-quota-store.js";
import {
	CODEX_READING_REFRESH_INTERVAL_MS,
	CODEX_READING_RESET_GRACE_MS,
	createCodexReadingScheduler,
	latestCodexObservationAt,
	nextCodexReadingRefreshAt,
} from "../reading-scheduler.js";

const T0 = Date.parse("2026-09-25T04:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function store(
	accounts: Array<{
		observedAt: string | null;
		weekly?: { usedPercent: number; resetAt: string | null } | null;
		fiveH?: { usedPercent: number; resetAt: string | null } | null;
	}>,
): CodexAccountQuotaStore {
	return {
		version: 1,
		generatedAt: iso(T0),
		activeAccount: null,
		accounts: accounts.map((account, index) => ({
			name: `account${index}`,
			registeredProfile: null,
			authHealth: "valid",
			note: null,
			planType: null,
			fiveH: account.fiveH ? { windowMinutes: 300, ...account.fiveH } : null,
			weekly: account.weekly
				? { windowMinutes: 10080, ...account.weekly }
				: null,
			credits: {
				known: false,
				hasCredits: null,
				unlimited: null,
				balance: null,
			},
			resetCredits: {
				known: false,
				value: null,
				availableCount: null,
				credits: null,
			},
			unclassifiedWindows: 0,
			observedAt: account.observedAt,
		})),
	} as CodexAccountQuotaStore;
}

describe("FLY-2869 — Codex reading schedule", () => {
	it("refreshes every fifteen minutes and one minute after a known exhausted reset", () => {
		expect(CODEX_READING_REFRESH_INTERVAL_MS).toBe(15 * 60_000);
		expect(CODEX_READING_RESET_GRACE_MS).toBe(60_000);
		expect(nextCodexReadingRefreshAt(null, T0)).toBe(
			T0 + CODEX_READING_REFRESH_INTERVAL_MS,
		);
		const soon = store([
			{
				observedAt: iso(T0),
				weekly: { usedPercent: 100, resetAt: iso(T0 + 5 * 60_000) },
			},
			{
				observedAt: iso(T0),
				weekly: { usedPercent: 80, resetAt: iso(T0 + 60_000) },
			},
		]);
		expect(nextCodexReadingRefreshAt(soon, T0)).toBe(T0 + 6 * 60_000);
		const passed = store([
			{
				observedAt: iso(T0),
				weekly: { usedPercent: 100, resetAt: iso(T0 - 5 * 60_000) },
			},
		]);
		expect(nextCodexReadingRefreshAt(passed, T0)).toBe(
			T0 + CODEX_READING_REFRESH_INTERVAL_MS,
		);
	});

	it("takes the newest valid observation and ignores future or broken ones", () => {
		expect(latestCodexObservationAt(null, T0)).toBeNull();
		expect(
			latestCodexObservationAt(
				store([
					{ observedAt: iso(T0 - 60_000) },
					{ observedAt: iso(T0 - 5_000) },
					{ observedAt: iso(T0 + 10 * 60_000) },
					{ observedAt: "garbage" },
					{ observedAt: null },
				]),
				T0,
			),
		).toBe(iso(T0 - 5_000));
	});
});

function harness(options: { fail?: string; advance?: boolean } = {}) {
	let now = T0;
	let current: CodexAccountQuotaStore | null = null;
	const releases: Array<() => void> = [];
	const refresh = vi.fn(
		() =>
			new Promise<void>((resolve, reject) => {
				releases.push(() => {
					if (options.fail) reject(new Error(options.fail));
					else {
						if (options.advance !== false)
							current = store([{ observedAt: iso(now) }]);
						resolve();
					}
				});
			}),
	);
	const reports: Array<{
		nowIso: string;
		latestObservedAt: string | null;
		failureCode: string | null;
	}> = [];
	const warn = vi.fn();
	const scheduler = createCodexReadingScheduler({
		now: () => now,
		refresh,
		readStore: () => current,
		observePipeline: (input) => {
			reports.push(input);
		},
		warn,
	});
	return {
		scheduler,
		refresh,
		reports,
		warn,
		setNow: (next: number) => {
			now = next;
		},
		setStore: (next: CodexAccountQuotaStore | null) => {
			current = next;
		},
		release: async () => {
			releases.shift()?.();
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

describe("FLY-2869 — Codex reading scheduler", () => {
	it("refreshes on the first tick, never twice in flight, then waits for the next due time", async () => {
		const h = harness();
		h.scheduler.tick();
		h.scheduler.tick();
		expect(h.refresh).toHaveBeenCalledTimes(1);
		expect(h.reports).toEqual([]);
		await h.release();
		expect(h.reports.at(-1)).toEqual({
			nowIso: iso(T0),
			latestObservedAt: iso(T0),
			failureCode: null,
		});
		h.setNow(T0 + 14 * 60_000);
		h.scheduler.tick();
		expect(h.refresh).toHaveBeenCalledTimes(1);
		h.setNow(T0 + 15 * 60_000);
		h.scheduler.tick();
		expect(h.refresh).toHaveBeenCalledTimes(2);
	});

	it("reports a round that resolved without any new observation", async () => {
		const h = harness({ advance: false });
		h.scheduler.tick();
		await h.release();
		expect(h.reports.at(-1)).toMatchObject({
			latestObservedAt: null,
			failureCode: "no_observation_advanced",
		});
	});

	it("keeps only an allowlisted failure code from a rejected round", async () => {
		const bad = harness({ fail: "codex_quota_runtime_unavailable" });
		bad.scheduler.tick();
		await bad.release();
		expect(bad.reports.at(-1)?.failureCode).toBe(
			"codex_quota_runtime_unavailable",
		);
		const leaky = harness({ fail: "EACCES: /Users/someone/.codex/auth.json" });
		leaky.scheduler.tick();
		await leaky.release();
		expect(leaky.reports.at(-1)?.failureCode).toBe("refresh_failed");
	});

	it("keeps reporting the pipeline on later ticks between rounds", async () => {
		const h = harness();
		h.scheduler.tick();
		await h.release();
		h.setNow(T0 + 40 * 60_000);
		h.scheduler.tick();
		expect(h.reports.at(-1)).toEqual({
			nowIso: iso(T0 + 40 * 60_000),
			latestObservedAt: iso(T0),
			failureCode: null,
		});
	});

	it("never throws into the poller when the store or the report fails", async () => {
		const h = harness();
		h.setStore(null);
		const throwing = createCodexReadingScheduler({
			now: () => T0,
			refresh: async () => {},
			readStore: () => {
				throw new Error("disk");
			},
			observePipeline: () => {
				throw new Error("db");
			},
			warn: h.warn,
		});
		expect(() => throwing.tick()).not.toThrow();
		await new Promise((resolve) => setImmediate(resolve));
		expect(() => throwing.tick()).not.toThrow();
		expect(h.warn).toHaveBeenCalled();
	});
});

describe("FLY-2869 — readings for the manual-switch N1", () => {
	it("returns the weekly window only for the same fresh identity", async () => {
		const { codexNotificationWindows } = await import(
			"../reading-scheduler.js"
		);
		const current = store([
			{
				observedAt: iso(T0 - 5 * 60_000),
				weekly: { usedPercent: 100, resetAt: iso(T0 + 86_400_000) },
				fiveH: { usedPercent: 10, resetAt: iso(T0 + 3_600_000) },
			},
			{
				observedAt: iso(T0 - 45 * 60_000),
				weekly: { usedPercent: 20, resetAt: iso(T0 + 86_400_000) },
			},
		]);
		current.accounts[0]!.identityKey = "key-0";
		current.accounts[1]!.identityKey = "key-1";
		expect(codexNotificationWindows(current, "account0", "key-0", T0)).toEqual([
			{ usedPercent: 100, resetsAt: T0 + 86_400_000 },
		]);
		expect(codexNotificationWindows(current, "account0", "other", T0)).toEqual(
			[],
		);
		expect(codexNotificationWindows(current, "account1", "key-1", T0)).toEqual(
			[],
		);
		expect(codexNotificationWindows(null, "account0", "key-0", T0)).toEqual([]);
	});
});
