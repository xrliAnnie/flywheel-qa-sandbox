import { describe, expect, it, vi } from "vitest";
import type { ClaudeAccountDetailStore } from "../../claude-quota/account-detail-store.js";
import type { CodexAccountQuotaStore } from "../../codex-quota/codex-account-quota-store.js";
import type { CodexSubscriptionStore } from "../../codex-quota/codex-subscription-store.js";
import {
	type CodexAccountQuotaRefreshDeps,
	createAccountQuotaRefresh,
	createCodexAccountQuotaRefresh,
} from "../account-quota-refresh.js";

const codexStore: CodexAccountQuotaStore = {
	version: 1,
	generatedAt: "2026-09-24T23:30:00.000Z",
	activeAccount: null,
	accounts: [],
} as unknown as CodexAccountQuotaStore;
const subscriptionStore: CodexSubscriptionStore = {
	version: 1,
	generatedAt: "2026-09-24T23:30:05.000Z",
	accounts: [],
};
const claudeStore: ClaudeAccountDetailStore = {
	version: 1,
	generatedAt: "2026-09-24T23:30:01.000Z",
	accounts: [],
};

type HarnessDeps = CodexAccountQuotaRefreshDeps & {
	observeClaudeAccountDetails: (
		signal: AbortSignal,
	) => Promise<ClaudeAccountDetailStore>;
	writeClaudeAccountDetailStore: (store: ClaudeAccountDetailStore) => void;
};

function harness(overrides: Partial<HarnessDeps> = {}) {
	const calls: string[] = [];
	const deps: HarnessDeps = {
		ceilingMs: 90_000,
		observeCodexAccounts: vi.fn(async () => {
			calls.push("observeCodexAccounts");
			return {
				...codexStore,
				accounts: [{ name: "a" }, { name: "b" }],
			} as unknown as CodexAccountQuotaStore;
		}),
		writeCodexAccountQuotaStore: vi.fn(() => {
			calls.push("writeCodexAccountQuotaStore");
		}),
		observeCodexSubscriptions: vi.fn(async () => {
			calls.push("observeCodexSubscriptions");
			return subscriptionStore;
		}),
		writeCodexSubscriptionStore: vi.fn(() => {
			calls.push("writeCodexSubscriptionStore");
		}),
		observeClaudeAccountDetails: vi.fn(async () => {
			calls.push("observeClaudeAccountDetails");
			return claudeStore;
		}),
		writeClaudeAccountDetailStore: vi.fn(() => {
			calls.push("writeClaudeAccountDetailStore");
		}),
		warn: vi.fn(),
		...overrides,
	};
	const refreshCodex = createCodexAccountQuotaRefresh(deps);
	return {
		deps,
		calls,
		refreshCodex,
		refresh: createAccountQuotaRefresh({
			ceilingMs: deps.ceilingMs,
			refreshCodex,
			observeClaudeAccountDetails: deps.observeClaudeAccountDetails,
			writeClaudeAccountDetailStore: deps.writeClaudeAccountDetailStore,
		}),
	};
}

describe("FLY-2864 — account quota refresh composition", () => {
	it("reads subscriptions only after the refreshed Codex quota store is written", async () => {
		const { calls, refresh } = harness();
		await expect(refresh()).resolves.toEqual({
			generatedAt: "2026-09-24T23:30:00.000Z",
			accountCount: 2,
		});
		const codexOrder = calls.filter((call) => call.includes("Codex"));
		expect(codexOrder).toEqual([
			"observeCodexAccounts",
			"writeCodexAccountQuotaStore",
			"observeCodexSubscriptions",
			"writeCodexSubscriptionStore",
		]);
		expect(calls).toContain("writeClaudeAccountDetailStore");
	});

	it("never fails the refresh because the subscription read or write failed", async () => {
		for (const overrides of [
			{
				observeCodexSubscriptions: vi.fn(async () => {
					throw new Error("subscriptions down");
				}),
			},
			{
				writeCodexSubscriptionStore: vi.fn(() => {
					throw new Error("disk full");
				}),
			},
		]) {
			const { deps, refresh } = harness(overrides);
			await expect(refresh()).resolves.toEqual({
				generatedAt: "2026-09-24T23:30:00.000Z",
				accountCount: 2,
			});
			expect(deps.writeCodexAccountQuotaStore).toHaveBeenCalledTimes(1);
			expect(deps.writeClaudeAccountDetailStore).toHaveBeenCalledTimes(1);
			expect(deps.warn).toHaveBeenCalledWith(
				"[Bridge] Codex subscription refresh failed",
				expect.any(String),
			);
		}
	});

	it("keeps the existing Codex and Claude failure semantics", async () => {
		const codexDown = harness({
			observeCodexAccounts: vi.fn(async () => {
				throw new Error("codex_quota_runtime_unavailable");
			}),
		});
		await expect(codexDown.refresh()).rejects.toThrow(
			"codex_quota_runtime_unavailable",
		);
		// Claude still ran and was persisted; subscriptions were never read.
		expect(codexDown.deps.writeClaudeAccountDetailStore).toHaveBeenCalledTimes(
			1,
		);
		expect(codexDown.deps.observeCodexSubscriptions).not.toHaveBeenCalled();

		const claudeDown = harness({
			observeClaudeAccountDetails: vi.fn(async () => {
				throw new Error("claude pool unreadable");
			}),
		});
		await expect(claudeDown.refresh()).rejects.toThrow(
			"claude pool unreadable",
		);
		expect(claudeDown.deps.writeCodexAccountQuotaStore).toHaveBeenCalledTimes(
			1,
		);
		expect(claudeDown.deps.writeCodexSubscriptionStore).toHaveBeenCalledTimes(
			1,
		);
	});

	it("coalesces concurrent calls into one round and runs a new round afterwards", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { deps, refresh } = harness({
			observeCodexAccounts: vi.fn(async () => {
				await gate;
				return codexStore;
			}),
		});
		const first = refresh();
		const second = refresh();
		expect(second).toBe(first);
		release();
		await Promise.all([first, second]);
		expect(deps.observeCodexAccounts).toHaveBeenCalledTimes(1);
		expect(deps.observeClaudeAccountDetails).toHaveBeenCalledTimes(1);

		await refresh();
		expect(deps.observeCodexAccounts).toHaveBeenCalledTimes(2);
		expect(deps.observeCodexSubscriptions).toHaveBeenCalledTimes(2);
	});

	it("aborts each branch at its own ceiling", async () => {
		vi.useFakeTimers();
		try {
			const signals: AbortSignal[] = [];
			const hang = (signal: AbortSignal) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
			const { refresh } = harness({
				ceilingMs: 1_000,
				observeCodexAccounts: vi.fn((signal: AbortSignal) => {
					signals.push(signal);
					return hang(signal);
				}),
				observeClaudeAccountDetails: vi.fn((signal: AbortSignal) => {
					signals.push(signal);
					return hang(signal);
				}),
			});
			const pending = refresh();
			const settled = expect(pending).rejects.toThrow("aborted");
			expect(signals).toHaveLength(2);
			expect(signals.every((signal) => !signal.aborted)).toBe(true);
			await vi.advanceTimersByTimeAsync(1_000);
			await settled;
			expect(signals.every((signal) => signal.aborted)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("FLY-2869: a scheduled Codex refresh and a page refresh share one Codex round", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { deps, refresh, refreshCodex } = harness({
			observeCodexAccounts: vi.fn(async () => {
				await gate;
				return codexStore;
			}),
		});
		const scheduled = refreshCodex();
		const page = refresh();
		release();
		await Promise.all([scheduled, page]);
		expect(deps.observeCodexAccounts).toHaveBeenCalledTimes(1);
		expect(deps.observeClaudeAccountDetails).toHaveBeenCalledTimes(1);
		await refreshCodex();
		expect(deps.observeCodexAccounts).toHaveBeenCalledTimes(2);
		expect(deps.observeClaudeAccountDetails).toHaveBeenCalledTimes(1);
	});
});
