/**
 * FLY-696 M1/C5+C8c — the account-switch repair adapter.
 *
 * canAttempt decides attemptability; enqueue writes the durable pending record
 * (AutoRepairBot's action on a cap); executeSwitch does the actual switch (fired
 * by a bot claim or the deadline sweep) and resolves the record. Switch deps are
 * mocked so no real Keychain is touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CandidateSelectionDeps,
	CandidateSnapshot,
} from "../account-heal/account-candidate-selector.js";
import { readStore, writeStore } from "../account-heal/account-store.js";
import { makeAccountSwitchRepair } from "../account-heal/account-switch-repair.js";
import {
	type PendingSwitch,
	pendingKey,
	readPending,
} from "../account-heal/pending-store.js";
import type { AccountUsageResult } from "../account-heal/quota-usage-api.js";
import type { SwitchResult } from "../account-heal/switch-executor.js";
import type { AlertPayload } from "../LeadAlertNotifier.js";

const NOW = new Date("2026-07-03T20:00:00Z");

let dir: string;
let storePath: string;
let pendingPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly696-repair-"));
	storePath = join(dir, "claude-accounts.json");
	pendingPath = join(dir, "account-switch-pending.json");
	writeStore(
		{
			generation: 3,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		},
		storePath,
	);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
	return {
		leadId: "product-lead",
		projectName: "flywheel",
		eventId: "alert-1",
		eventType: "usage_limit",
		title: "usage cap",
		body: "",
		severity: "warning",
		metadata: {
			accountLimit: {
				provider: "claude",
				scope: "5h",
				resetAt: "2026-07-04T02:30:00.000Z",
				observedAccount: "personal",
				observedGeneration: 3,
			},
		},
		...over,
	};
}

function pending(over: Partial<PendingSwitch> = {}): PendingSwitch {
	return {
		key: pendingKey("alert-1", "personal", 3),
		provider: "claude",
		sourceAlertId: "alert-1",
		observedAccount: "personal",
		observedGeneration: 3,
		scope: "5h",
		resetAt: "2026-07-04T02:30:00.000Z",
		deadlineAt: "2026-07-03T20:00:20.000Z",
		createdAt: "2026-07-03T20:00:00.000Z",
		...over,
	};
}

function repair(
	switchImpl: (i: unknown, d: unknown) => Promise<SwitchResult>,
	enabled = true,
	candidateDeps = makeCandidateDeps(),
) {
	return makeAccountSwitchRepair({
		switchDeps: {} as never,
		now: () => NOW.getTime(),
		storePath,
		pendingPath,
		isEnabled: () => enabled,
		switchImpl: switchImpl as never,
		candidateDeps,
		// inline lock for tests (no real filesystem lock churn)
		withLock: async (_l, fn) => fn(),
	});
}

function usage(
	fiveH: number,
	sevenD: number,
	reset: string,
): AccountUsageResult {
	return {
		ok: {
			fiveH: { pct: fiveH, resetsAt: "2026-07-03T22:00:00.000Z" },
			sevenD: { pct: sevenD, resetsAt: reset },
		},
	};
}

function makeCandidateDeps(): CandidateSelectionDeps {
	const snapshot = (): CandidateSnapshot => ({
		activeName: readStore(storePath).activeAccount,
		activeCredential: {
			accessToken: "active-secret",
			expiresAt: NOW.getTime() + 60_000,
			rawDigest: "active-digest",
		},
		store: readStore(storePath),
		poolAccounts: readStore(storePath).accounts.map((account) => account.name),
	});
	return {
		now: () => NOW.getTime(),
		withAccountsLock: async (fn) => fn(),
		readSnapshot: async () => snapshot(),
		verifyCandidate: async () => ({
			fresh: "refreshed",
			expiresAt: NOW.getTime() + 60_000,
		}),
		readPoolCredential: async (name) => ({
			accessToken: `secret-${name}`,
			expiresAt: NOW.getTime() + 60_000,
		}),
		fetchUsage: async () => usage(10, 20, "2026-07-04T01:00:00.000Z"),
		recordObservation: async () => "updated",
	};
}

describe("account-switch-repair · canAttempt", () => {
	it("true when flag on + accountLimit metadata + an available account", () => {
		expect(repair(vi.fn()).canAttempt(payload())).toBe(true);
	});
	it("false when the flag is off (byte-compat)", () => {
		expect(repair(vi.fn(), false).canAttempt(payload())).toBe(false);
	});
	it("false when there is no accountLimit metadata", () => {
		expect(repair(vi.fn()).canAttempt(payload({ metadata: {} }))).toBe(false);
	});
	it("false for a non-claude provider (MVP switch is Claude-only)", () => {
		const p = payload();
		p.metadata!.accountLimit!.provider = "codex";
		expect(repair(vi.fn()).canAttempt(p)).toBe(false);
	});
	it("false when no account is available (all exhausted)", () => {
		writeStore(
			{
				generation: 3,
				activeAccount: "personal",
				accounts: [
					{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
					{
						name: "school",
						quotaExhaustedUntil: "2026-07-10T00:00:00Z",
						weeklyResetAt: null,
					},
				],
			},
			storePath,
		);
		expect(repair(vi.fn()).canAttempt(payload())).toBe(false);
	});
});

describe("account-switch-repair · enqueue", () => {
	it("writes a durable pending record + returns a queued disposition", async () => {
		const r = await repair(vi.fn()).enqueue(payload());
		expect(r.outcome).toBe("attempted");
		expect(r.action).toBe("account_switch");
		expect(r.detail).toContain("排队");
		const recs = readPending(pendingPath);
		expect(recs).toHaveLength(1);
		expect(recs[0]).toMatchObject({
			provider: "claude",
			observedAccount: "personal",
			observedGeneration: 3,
			scope: "5h",
			sourceAlertId: "alert-1",
		});
	});

	it("flag off → needs_human, no pending record", async () => {
		const r = await repair(vi.fn(), false).enqueue(payload());
		expect(r.outcome).toBe("needs_human");
		expect(readPending(pendingPath)).toEqual([]);
	});

	it("no available account → needs_human, no pending record", async () => {
		writeStore(
			{
				generation: 3,
				activeAccount: "personal",
				accounts: [
					{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
					{
						name: "school",
						quotaExhaustedUntil: "2026-07-10T00:00:00Z",
						weeklyResetAt: null,
					},
				],
			},
			storePath,
		);
		const r = await repair(vi.fn()).enqueue(payload());
		expect(r.outcome).toBe("needs_human");
		expect(readPending(pendingPath)).toEqual([]);
	});
});

describe("account-switch-repair · executeSwitch", () => {
	it("switched → attempted (from→to) and resolves the pending record", async () => {
		// seed a pending record, then execute it
		await repair(vi.fn()).enqueue(payload());
		expect(readPending(pendingPath)).toHaveLength(1);
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "switched",
				from: "personal",
				to: "school",
				generation: 4,
			}),
		);
		const r = await repair(switchImpl).executeSwitch(pending());
		expect(r.outcome).toBe("attempted");
		expect(r.detail).toContain("personal→school");
		expect(readPending(pendingPath)).toEqual([]); // resolved
	});

	it("already switched → attempted no-op", async () => {
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "noop_already_switched",
				activeAccount: "school",
			}),
		);
		const r = await repair(switchImpl).executeSwitch(pending());
		expect(r.outcome).toBe("attempted");
		expect(r.detail).toContain("school");
	});

	it("reconciled an interrupted switch → attempted no-op with generation", async () => {
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "noop_reconciled",
				activeAccount: "shopping",
				generation: 8,
			}),
		);
		const r = await repair(switchImpl).executeSwitch(pending());
		expect(r.outcome).toBe("attempted");
		expect(r.detail).toContain("shopping");
		expect(r.detail).toContain("generation 8");
	});

	it("no account → needs_human with the earliest reset", async () => {
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "no_account",
				earliestReset: "2026-07-06T14:00:00Z",
			}),
		);
		const r = await repair(switchImpl).executeSwitch(pending());
		expect(r.outcome).toBe("needs_human");
		expect(r.detail).toContain("2026-07-06T14:00:00Z");
	});

	it("failed (keychain) → needs_human, keeps the old account", async () => {
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "failed",
				reason: "keychain locked",
			}),
		);
		const r = await repair(switchImpl).executeSwitch(pending());
		expect(r.outcome).toBe("needs_human");
		expect(r.detail).toContain("keychain locked");
	});
});

describe("account-switch-repair · live selector + centralized notification", () => {
	it("switched disposition has no caller-side notification payload", async () => {
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "switched",
				from: "personal",
				to: "school",
				generation: 4,
			}),
		);
		const r = await repair(switchImpl).executeSwitch(pending());
		expect(Object.keys(r).sort()).toEqual(["action", "detail", "outcome"]);
	});

	it("live-verifies repair candidates and passes only the fresh ranked panorama", async () => {
		writeStore(
			{
				generation: 3,
				activeAccount: "personal",
				accounts: ["personal", "school", "business"].map((name) => ({
					name,
					quotaExhaustedUntil: null,
					weeklyResetAt: null,
				})),
			},
			storePath,
		);
		const candidateDeps = makeCandidateDeps();
		candidateDeps.verifyCandidate = vi.fn(async (name) =>
			name === "business"
				? { fresh: "stale" as const, reason: "refresh refused" }
				: {
						fresh: "refreshed" as const,
						expiresAt: NOW.getTime() + 60_000,
					},
		);
		candidateDeps.fetchUsage = async (token) =>
			token === "secret-business"
				? usage(10, 20, "2026-07-03T21:00:00.000Z")
				: usage(10, 20, "2026-07-03T23:00:00.000Z");
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "switched",
				from: "personal",
				to: "school",
				generation: 4,
			}),
		);
		await repair(switchImpl, true, candidateDeps).executeSwitch(pending());
		expect(switchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: expect.objectContaining({ kind: "repair", scope: "5h" }),
				preferredOrder: ["school"],
				quotaPreverified: true,
				notificationContext: expect.objectContaining({
					panorama: expect.arrayContaining([
						expect.objectContaining({
							name: "business",
							excludedBy: "unverifiable",
						}),
					]),
				}),
			}),
			expect.anything(),
		);
	});

	it("resolves an all-dead pending repair with a loud panorama and no executor call", async () => {
		const candidateDeps = makeCandidateDeps();
		candidateDeps.verifyCandidate = vi.fn(async () => ({
			fresh: "stale" as const,
			reason: "refresh refused",
		}));
		const switchImpl = vi.fn();
		await repair(vi.fn()).enqueue(payload());
		const r = await repair(
			switchImpl as never,
			true,
			candidateDeps,
		).executeSwitch(pending());

		expect(r).toMatchObject({ outcome: "needs_human", action: "none" });
		expect(r.detail).toContain("school:freshness_stale");
		expect(switchImpl).not.toHaveBeenCalled();
		expect(readPending(pendingPath)).toEqual([]);
	});
});
