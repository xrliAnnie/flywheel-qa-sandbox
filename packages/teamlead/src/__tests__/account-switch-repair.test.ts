/**
 * FLY-696 M1/C5+C8c — the account-switch repair adapter.
 *
 * canAttempt decides attemptability; enqueue writes the durable pending record
 * (AutoRepairBot's action on a cap); executeSwitch does the actual switch (fired
 * by a bot claim or the watchdog) and resolves the record. Switch deps are
 * mocked so no real Keychain is touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStore } from "../account-heal/account-store.js";
import { makeAccountSwitchRepair } from "../account-heal/account-switch-repair.js";
import {
	type PendingSwitch,
	pendingKey,
	readPending,
} from "../account-heal/pending-store.js";
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
) {
	return makeAccountSwitchRepair({
		switchDeps: {} as never,
		now: () => NOW.getTime(),
		storePath,
		pendingPath,
		isEnabled: () => enabled,
		switchImpl: switchImpl as never,
		// inline lock for tests (no real filesystem lock churn)
		withLock: async (_l, fn) => fn(),
	});
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

// FLY-929 A4: `notifySuccess` is the STRUCTURED digest payload — present ONLY
// on a real `switched` outcome (a noop/no_account/failed digest would be noise).
describe("account-switch-repair · notifySuccess (FLY-929 digest payload)", () => {
	it("switched → notifySuccess carries from/to/scope/resetAt", async () => {
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "switched",
				from: "personal",
				to: "school",
				generation: 4,
			}),
		);
		const p = pending();
		const r = await repair(switchImpl).executeSwitch(p);
		expect(r.notifySuccess).toEqual({
			from: "personal",
			to: "school",
			scope: p.scope,
			resetAt: p.resetAt,
		});
	});

	it("noop_already_switched → NO notifySuccess", async () => {
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "noop_already_switched",
				activeAccount: "school",
			}),
		);
		const r = await repair(switchImpl).executeSwitch(pending());
		expect(r.notifySuccess).toBeUndefined();
	});

	it("no_account → NO notifySuccess", async () => {
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "no_account",
				earliestReset: null,
			}),
		);
		const r = await repair(switchImpl).executeSwitch(pending());
		expect(r.notifySuccess).toBeUndefined();
	});

	it("failed → NO notifySuccess", async () => {
		const switchImpl = vi.fn(
			async (): Promise<SwitchResult> => ({
				outcome: "failed",
				reason: "keychain locked",
			}),
		);
		const r = await repair(switchImpl).executeSwitch(pending());
		expect(r.notifySuccess).toBeUndefined();
	});

	it("enqueue never carries notifySuccess (no switch happened yet)", async () => {
		const r = await repair(vi.fn()).enqueue(payload());
		expect(r.notifySuccess).toBeUndefined();
	});
});
