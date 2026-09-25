import { describe, expect, it, vi } from "vitest";
import type { ClaudeAccountDetailStore } from "../../claude-quota/account-detail-store.js";
import type { CodexAccountQuotaStore } from "../../codex-quota/codex-account-quota-store.js";
import type { CodexSubscriptionStore } from "../../codex-quota/codex-subscription-store.js";
import { createCodexReadingScheduler } from "../../codex-quota/reading-scheduler.js";
import {
	createVercelAccountLatest,
	type VercelAccountStore,
	vercelAccountFailure,
} from "../../vercel-quota/vercel-account-store.js";
import {
	type AccountQuotaRefreshDeps,
	type CodexAccountQuotaRefreshDeps,
	createAccountQuotaRefresh,
	createAccountReadingsRefresh,
	createCodexAccountQuotaRefresh,
	scheduledReadingsRefresh,
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
	vercel?: AccountQuotaRefreshDeps["vercel"];
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
			vercel: deps.vercel,
			warn: deps.warn,
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

describe("FLY-2875 — Vercel branch of the account refresh", () => {
	const FAKE = "vcp_FAKE7777SECRET_do_not_leak";
	const NOW = new Date("2026-09-25T08:00:00.000Z");
	const success: VercelAccountStore = {
		version: 1,
		observedAt: "2026-09-25T08:00:00.000Z",
		account: {
			emailSha256: "a".repeat(64),
			username: "xrliannie",
			teamSlug: "xrliannies-projects",
			plan: "pro",
			billingStatus: "active",
			periodEnd: "2026-10-24T07:00:00.000Z",
			canceled: false,
		},
		accountNote: null,
		blob: {
			status: "available",
			sizeBytes: 1,
			count: 1,
			usageQuotaExceeded: false,
		},
		blobNote: null,
	};

	function vercelHarness(
		vercel: Partial<NonNullable<AccountQuotaRefreshDeps["vercel"]>> = {},
		overrides: Partial<HarnessDeps> = {},
	) {
		const latest = createVercelAccountLatest();
		const order: string[] = [];
		const deps = {
			observe: vi.fn(async () => {
				order.push("observe");
				return success;
			}),
			publish: vi.fn((store: VercelAccountStore) => {
				order.push("publish");
				latest.set(store);
			}),
			write: vi.fn(() => {
				order.push("write");
			}),
			discardStale: vi.fn(() => {
				order.push("discardStale");
			}),
			now: () => NOW,
			...vercel,
		};
		const built = harness({ vercel: deps, ...overrides });
		return { ...built, latest, order, vercel: deps };
	}

	function warnText(warn: unknown): string {
		return JSON.stringify((warn as ReturnType<typeof vi.fn>).mock.calls);
	}

	it("publishes the reading before writing it and keeps the refresh result", async () => {
		const { refresh, latest, order } = vercelHarness();
		await expect(refresh()).resolves.toEqual({
			generatedAt: "2026-09-24T23:30:00.000Z",
			accountCount: 2,
		});
		expect(order).toEqual(["observe", "publish", "write"]);
		expect(latest.get()).toEqual(success);
	});

	it("publishes a fixed failure when the observer throws, without leaking what it threw", async () => {
		const tokenError = new Error(`boom ${FAKE}`);
		tokenError.name = `Name${FAKE}`;
		for (const thrown of [tokenError, FAKE, { token: FAKE }]) {
			const { refresh, latest, deps, vercel } = vercelHarness({
				observe: vi.fn(async () => {
					throw thrown;
				}),
			});
			await expect(refresh()).resolves.toMatchObject({ accountCount: 2 });
			expect(latest.get()).toEqual(vercelAccountFailure("refresh_failed", NOW));
			expect(vercel.write).toHaveBeenCalledWith(
				vercelAccountFailure("refresh_failed", NOW),
			);
			expect(deps.warn).toHaveBeenCalledWith(
				"[Bridge] Vercel account refresh failed",
				"",
			);
			expect(warnText(deps.warn)).not.toContain(FAKE.slice(0, 8));
		}
	});

	it("keeps the published attempt and discards the stale file when the write fails", async () => {
		const unauthorized = vercelAccountFailure("unauthorized", NOW);
		const { refresh, latest, deps, order } = vercelHarness({
			observe: vi.fn(async () => {
				order.push("observe");
				return unauthorized;
			}),
			write: vi.fn(() => {
				order.push("write");
				throw new Error(`ENOSPC ${FAKE}`);
			}),
		});
		await expect(refresh()).resolves.toMatchObject({ accountCount: 2 });
		expect(order).toEqual(["observe", "publish", "write", "discardStale"]);
		expect(latest.get()).toEqual(unauthorized);
		expect(deps.warn).toHaveBeenCalledWith(
			"[Bridge] Vercel account store write failed",
			"",
		);
		expect(warnText(deps.warn)).not.toContain(FAKE.slice(0, 8));
	});

	it("survives a discard that throws too", async () => {
		const { refresh, latest } = vercelHarness({
			write: vi.fn(() => {
				throw new Error("EROFS");
			}),
			discardStale: vi.fn(() => {
				throw new Error("EROFS");
			}),
		});
		await expect(refresh()).resolves.toMatchObject({ accountCount: 2 });
		expect(latest.get()).toEqual(success);
	});

	it("still reads Vercel when Codex fails, and Codex failure still fails the refresh", async () => {
		const { refresh, vercel } = vercelHarness(
			{},
			{
				observeCodexAccounts: vi.fn(async () => {
					throw new Error("codex_quota_runtime_unavailable");
				}),
			},
		);
		await expect(refresh()).rejects.toThrow("codex_quota_runtime_unavailable");
		expect(vercel.publish).toHaveBeenCalledWith(success);
		expect(vercel.write).toHaveBeenCalledWith(success);
	});

	it("aborts a hung Vercel read at its own ceiling without failing the refresh", async () => {
		vi.useFakeTimers();
		try {
			const signals: AbortSignal[] = [];
			const { refresh, latest, deps } = vercelHarness(
				{
					observe: vi.fn(
						(signal: AbortSignal) =>
							new Promise<never>((_resolve, reject) => {
								signals.push(signal);
								signal.addEventListener(
									"abort",
									() => reject(new Error(`aborted ${FAKE}`)),
									{ once: true },
								);
							}),
					),
				},
				{ ceilingMs: 1_000 },
			);
			const pending = refresh();
			await vi.advanceTimersByTimeAsync(0);
			expect(signals).toHaveLength(1);
			expect(signals[0]?.aborted).toBe(false);
			expect(
				(deps.observeCodexAccounts as ReturnType<typeof vi.fn>).mock
					.calls[0]?.[0],
			).not.toBe(signals[0]);
			await vi.advanceTimersByTimeAsync(1_000);
			await expect(pending).resolves.toMatchObject({ accountCount: 2 });
			expect(signals[0]?.aborted).toBe(true);
			expect(latest.get()).toEqual(vercelAccountFailure("refresh_failed", NOW));
			expect(warnText(deps.warn)).not.toContain(FAKE.slice(0, 8));
		} finally {
			vi.useRealTimers();
		}
	});

	it("FLY-2869: the scheduled Codex round never reads Vercel", async () => {
		const { refreshCodex, refresh, vercel } = vercelHarness();
		await refreshCodex();
		expect(vercel.observe).not.toHaveBeenCalled();
		await refresh();
		expect(vercel.observe).toHaveBeenCalledTimes(1);
	});
});

describe("FLY-2830 — scheduled readings also read Claude cards", () => {
	const codexOk = async () => ({
		generatedAt: codexStore.generatedAt,
		accountCount: 2,
	});

	it("reads Codex and Claude details once each, never Vercel", async () => {
		const observeClaude = vi.fn(async () => claudeStore);
		const writeClaude = vi.fn();
		const refreshCodex = vi.fn(codexOk);
		const refresh = createAccountReadingsRefresh({
			ceilingMs: 90_000,
			refreshCodex,
			observeClaudeAccountDetails: observeClaude,
			writeClaudeAccountDetailStore: writeClaude,
		});
		await expect(refresh()).resolves.toEqual({
			codex: { ok: true },
			claude: { ok: true },
		});
		expect(refreshCodex).toHaveBeenCalledTimes(1);
		expect(observeClaude).toHaveBeenCalledTimes(1);
		expect(writeClaude).toHaveBeenCalledWith(claudeStore);
	});

	it("keeps the legs independent and reports each outcome", async () => {
		const refresh = createAccountReadingsRefresh({
			ceilingMs: 90_000,
			refreshCodex: codexOk,
			observeClaudeAccountDetails: async () => {
				throw new Error("claude_down");
			},
			writeClaudeAccountDetailStore: vi.fn(),
		});
		const outcome = await refresh();
		expect(outcome.codex).toEqual({ ok: true });
		expect(outcome.claude).toMatchObject({ ok: false });
	});

	it("lets only the Codex leg decide the reading-stale state machine", async () => {
		const reports: Array<{ failureCode: string | null }> = [];
		const lines: string[] = [];
		let observedAt = "2026-09-24T23:00:00.000Z";
		const scheduler = createCodexReadingScheduler({
			now: () => Date.parse("2026-09-24T23:30:00.000Z"),
			refresh: scheduledReadingsRefresh(
				createAccountReadingsRefresh({
					ceilingMs: 90_000,
					refreshCodex: async () => {
						observedAt = "2026-09-24T23:30:00.000Z";
						return { generatedAt: observedAt, accountCount: 1 };
					},
					observeClaudeAccountDetails: async () => {
						throw new Error("claude_down");
					},
					writeClaudeAccountDetailStore: vi.fn(),
				}),
				(line) => lines.push(line),
			),
			readStore: () =>
				({
					...codexStore,
					accounts: [{ name: "a", observedAt }],
				}) as unknown as CodexAccountQuotaStore,
			observePipeline: (report) => reports.push(report),
		});
		scheduler.tick();
		await vi.waitFor(() => expect(reports).toHaveLength(1));
		expect(reports[0]?.failureCode).toBeNull();
		expect(lines).toEqual([
			"[reading-scheduler] claude_details_failed:claude_down",
		]);
	});

	it("still fails the scheduled round when the Codex leg fails", async () => {
		const run = scheduledReadingsRefresh(
			createAccountReadingsRefresh({
				ceilingMs: 90_000,
				refreshCodex: async () => {
					throw new Error("codex_round_timeout");
				},
				observeClaudeAccountDetails: async () => claudeStore,
				writeClaudeAccountDetailStore: vi.fn(),
			}),
			() => undefined,
		);
		await expect(run()).rejects.toThrow("codex_round_timeout");
	});
});
