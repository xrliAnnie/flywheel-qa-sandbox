/**
 * FLY-696 M1/C5 — switchAccount orchestration: the account-keyed, CAS-guarded,
 * flock-serialized Claude switch. The A-specific Keychain write lives inside the
 * injected `applyProfile` (the real one = `flywheel-claude-profile use`, kept in
 * the final isolated commit); this exercises the orchestration with mocks.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AccountStore,
	MAX_SWITCH_NOTIFICATION_OUTBOX,
	readStore,
	type SwitchNotificationIntent,
	writeStore,
} from "../account-heal/account-store.js";
import type { LeaseProof } from "../account-heal/mkdir-lock.js";
import {
	ActiveMarkerDriftError,
	type ApplyProfileReport,
	FreshnessUnavailableError,
	IdentityRollbackFailedError,
	KeychainPreimageConflictError,
	LiveIdentityUnavailableError,
	type SwitchDeps,
	switchAccount,
	TargetIdentityMismatchError,
	TargetIdentityRolledBackError,
	TargetIdentityUnverifiableError,
	TargetQuotaExhaustedError,
	TargetStaleError,
} from "../account-heal/switch-executor.js";

const NOW = new Date("2026-07-03T20:00:00Z");

let dir: string;
let storePath: string;
const lease: LeaseProof = {
	lockPath: "/tmp/fly1252-accounts.lock",
	markerPath: "/tmp/fly1252-accounts.lock/holder.1.token",
	ownershipToken: "token",
};
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly696-switch-"));
	storePath = join(dir, "claude-accounts.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(store: AccountStore): void {
	writeStore(store, storePath);
}

/** Deps that run the critical section inline (no real flock) + record calls. */
function deps(over: Partial<SwitchDeps> = {}): SwitchDeps {
	return {
		storePath,
		applyProfile: vi.fn(async () => ({ identitySynced: true })),
		withLock: async (lockPath, fn) => ({
			kind: "ok",
			value: await fn({ ...lease, lockPath }),
		}),
		renewLock: vi.fn(() => true),
		readActiveProfile: async () => readStore(storePath).activeAccount,
		validateLease: vi.fn(() => true),
		...over,
	};
}

const input = {
	scope: "5h" as const,
	observedAccount: "personal",
	observedGeneration: 1,
	resetAt: "2026-07-04T02:30:00.000Z",
	now: NOW,
};

function pendingIntent(generation: number): SwitchNotificationIntent {
	return {
		eventId: `old-switch-${generation}`,
		generation,
		createdAt: NOW.getTime() - generation,
		alert: {
			kind: "account_switched",
			severity: "info",
			title: `Old switch ${generation}`,
			body: "pending",
			signature: `old-switch-${generation}`,
		},
	};
}

describe("switchAccount", () => {
	it("model trigger canonicalizes the set, benches every model independently in one commit, and leaves account quota fields untouched", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{
					name: "personal",
					quotaExhaustedUntil: null,
					weeklyResetAt: null,
					modelCaps: {
						"Sonnet 5": {
							until: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
							backoffMs: 30 * 60_000,
						},
					},
				},
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});

		const result = await switchAccount(
			{
				scope: "model",
				models: [" Sonnet   5 ", "Fable 5", "Sonnet 5"],
				observedAccount: "personal",
				observedGeneration: 1,
				now: NOW,
			},
			deps(),
		);

		expect(result).toMatchObject({
			outcome: "switched",
			from: "personal",
			to: "school",
			benchUntilByModel: {
				"Fable 5": new Date(NOW.getTime() + 30 * 60_000).toISOString(),
				"Sonnet 5": new Date(NOW.getTime() + 60 * 60_000).toISOString(),
			},
		});
		const personal = readStore(storePath).accounts.find(
			(account) => account.name === "personal",
		);
		expect(personal).toMatchObject({
			quotaExhaustedUntil: null,
			weeklyResetAt: null,
			modelCaps: {
				"Fable 5": {
					until: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
					backoffMs: 30 * 60_000,
				},
				"Sonnet 5": {
					until: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
					backoffMs: 60 * 60_000,
				},
			},
		});
	});

	it("rejects an empty model trigger before selecting or writing a profile", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});
		const d = deps();

		const result = await switchAccount(
			{
				scope: "model",
				models: [] as unknown as [string, ...string[]],
				observedAccount: "personal",
				observedGeneration: 1,
				now: NOW,
			},
			d,
		);

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "invalid_model_trigger",
		});
		expect(d.applyProfile).not.toHaveBeenCalled();
		expect(readStore(storePath).generation).toBe(1);
	});

	it("happy path: applies next profile, marks old exhausted, bumps generation", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});
		const d = deps();
		const res = await switchAccount(input, d);
		expect(res).toMatchObject({
			outcome: "switched",
			from: "personal",
			to: "school",
		});
		expect(d.applyProfile).toHaveBeenCalledWith(
			"school",
			expect.objectContaining({
				lease: expect.objectContaining({ lockPath: expect.any(String) }),
			}),
		);
		const after = readStore(storePath);
		expect(after.activeAccount).toBe("school");
		expect(after.generation).toBe(2);
		expect(after.pendingSwitchNotifications).toEqual([
			expect.objectContaining({
				eventId: "account-switch-g2",
				generation: 2,
				alert: expect.objectContaining({ kind: "account_switched" }),
			}),
		]);
		expect(
			after.accounts.find((a) => a.name === "personal")?.quotaExhaustedUntil,
		).toBe("2026-07-04T02:30:00.000Z");
		expect(
			after.accounts.find((a) => a.name === "personal")?.switchCooldownUntil,
		).toBe("2026-07-04T02:30:00.000Z");
	});

	it("manual use commits a notification without marking the outgoing account exhausted", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});

		const result = await switchAccount(
			{
				trigger: { kind: "manual", mode: "use" },
				observedAccount: "personal",
				observedGeneration: 1,
				now: NOW,
				preferredOrder: ["school"],
				manualOverrides: new Map([
					[
						"school",
						{
							ignoreCooldown: true,
						},
					],
				]),
			},
			deps(),
		);

		expect(result).toMatchObject({ outcome: "switched", to: "school" });
		const after = readStore(storePath);
		expect(
			after.accounts.find((entry) => entry.name === "personal"),
		).toMatchObject({
			quotaExhaustedUntil: null,
			weeklyResetAt: null,
		});
		expect(after.pendingSwitchNotifications?.[0]?.alert.body).toContain(
			"（manual:use）",
		);
	});

	it("applies only the selected account's typed cooldown override", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{
					name: "school",
					quotaExhaustedUntil: null,
					switchCooldownUntil: "2026-07-04T02:30:00.000Z",
					weeklyResetAt: null,
				},
			],
		});
		const applyProfile = vi.fn(async () => ({ identitySynced: true }));
		const manualOverride = { ignoreCooldown: true };

		const result = await switchAccount(
			{
				trigger: { kind: "manual", mode: "use" },
				observedAccount: "personal",
				observedGeneration: 1,
				now: NOW,
				preferredOrder: ["school"],
				manualOverrides: new Map([["school", manualOverride]]),
			},
			deps({ applyProfile }),
		);

		expect(result).toMatchObject({ outcome: "switched", to: "school" });
		expect(applyProfile).toHaveBeenCalledWith(
			"school",
			expect.objectContaining({ manualMode: "use" }),
		);
		expect(applyProfile.mock.calls[0]?.[1]).not.toHaveProperty(
			"manualOverride",
		);
	});

	it("marks a stale manual target unusable instead of bypassing freshness", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{
					name: "school",
					quotaExhaustedUntil: null,
					weeklyResetAt: null,
				},
			],
		});
		const result = await switchAccount(
			{
				trigger: { kind: "manual", mode: "use" },
				observedAccount: "personal",
				observedGeneration: 1,
				now: NOW,
				preferredOrder: ["school"],
				manualOverrides: new Map([
					[
						"school",
						{
							ignoreCooldown: true,
						},
					],
				]),
			},
			deps({
				applyProfile: vi.fn(async () => {
					throw new TargetStaleError("school");
				}),
			}),
		);

		expect(result).toMatchObject({
			outcome: "no_account",
			reasonCode: "target_stale_exhausted",
		});
		expect(readStore(storePath).accounts[1]?.authExpired).toBe(true);
	});

	it("keeps a committed intent pending when notification delivery fails", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});
		const deliverNotification = vi.fn(async () => {
			throw new Error("sender offline");
		});

		const result = await switchAccount(input, deps({ deliverNotification }));

		expect(result).toMatchObject({
			outcome: "switched",
			notification: "pending",
		});
		expect(deliverNotification).toHaveBeenCalledTimes(1);
		expect(readStore(storePath).pendingSwitchNotifications).toHaveLength(1);
	});

	it("drains an older intent before switching and acknowledges the new intent afterward", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
			pendingSwitchNotifications: [pendingIntent(1)],
		});
		const delivered: string[] = [];
		const deliverNotification = vi.fn(async (alert) => {
			delivered.push(alert.signature);
			return { primary: "sent" as const };
		});

		const result = await switchAccount(input, deps({ deliverNotification }));

		expect(result).toMatchObject({
			outcome: "switched",
			notification: "delivered",
		});
		expect(delivered).toEqual(["old-switch-1", "account-switch-g2"]);
		expect(readStore(storePath).pendingSwitchNotifications).toEqual([]);
	});

	it("CAS no-op: active already differs from observedAccount → no switch, no apply", async () => {
		seed({
			generation: 5,
			activeAccount: "school", // already switched by someone else
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});
		const d = deps();
		const res = await switchAccount(input, d);
		expect(res).toEqual({
			outcome: "noop_already_switched",
			activeAccount: "school",
		});
		expect(d.applyProfile).not.toHaveBeenCalled();
		expect(readStore(storePath).generation).toBe(5); // untouched
	});

	it("CAS no-op: stale GENERATION (same name after A→B→A) → no switch, no apply", async () => {
		// Codex code R1 MED-3: after personal→school→personal the active NAME is
		// "personal" again but the generation has bumped past the observation —
		// a stale pending keyed to the OLD cap must not rotate away a healthy
		// account.
		seed({
			generation: 3, // input.observedGeneration is 1 (stale)
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});
		const d = deps();
		const res = await switchAccount(input, d);
		expect(res).toEqual({
			outcome: "noop_already_switched",
			activeAccount: "personal",
		});
		expect(d.applyProfile).not.toHaveBeenCalled();
		expect(readStore(storePath).generation).toBe(3); // untouched
	});

	it("no usable account → no_account, no apply, state untouched", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{
					name: "school",
					quotaExhaustedUntil: "2026-07-10T00:00:00Z",
					weeklyResetAt: null,
				},
			],
		});
		const d = deps();
		const res = await switchAccount(input, d);
		expect(res).toMatchObject({
			outcome: "no_account",
			reasonCode: "no_eligible_account",
		});
		expect(d.applyProfile).not.toHaveBeenCalled();
		expect(readStore(storePath).generation).toBe(1);
	});

	it("fails before profile mutation when the notification outbox is full", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
			pendingSwitchNotifications: Array.from(
				{ length: MAX_SWITCH_NOTIFICATION_OUTBOX },
				(_, index) => pendingIntent(index + 1),
			),
		});
		const d = deps();

		await expect(switchAccount(input, d)).resolves.toMatchObject({
			outcome: "failed",
			reasonCode: "notification_outbox_full",
		});
		expect(d.applyProfile).not.toHaveBeenCalled();
		expect(readStore(storePath).generation).toBe(1);
	});

	it("applyProfile throws → fail-closed: state unchanged, outcome failed", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});
		const d = deps({
			applyProfile: vi.fn(async () => {
				throw new Error("keychain locked");
			}),
		});
		const res = await switchAccount(input, d);
		expect(res).toMatchObject({
			outcome: "failed",
			reasonCode: "apply_failed",
		});
		const after = readStore(storePath);
		expect(after.activeAccount).toBe("personal"); // unchanged
		expect(after.generation).toBe(1);
	});

	it("runs the whole critical section inside withLock", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});
		const withLock: SwitchDeps["withLock"] = vi.fn(async (lockPath, fn) => ({
			kind: "ok",
			value: await fn({ ...lease, lockPath }),
		}));
		await switchAccount(input, deps({ withLock }));
		expect(withLock).toHaveBeenCalledTimes(1);
	});

	it("reconciles store.activeAccount from the real profile before CAS (crash recovery)", async () => {
		// Keychain was switched to school (crash before state commit); state still
		// says personal. readActiveProfile is the authority → reconcile → CAS sees
		// active=school != observed=personal → noop, no double-switch.
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});
		const d = deps({ readActiveProfile: async () => "school" });
		const res = await switchAccount(input, d);
		expect(res).toEqual({
			outcome: "noop_already_switched",
			activeAccount: "school",
		});
		expect(d.applyProfile).not.toHaveBeenCalled();
	});

	it("fails closed before selection or apply when the shared machine authority conflicts", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		});
		const d = deps({
			resolveMachineAccount: () => ({
				kind: "conflict" as const,
				activeMarker: "school",
				identityAccount: "personal",
				ledgerAccount: "personal",
			}),
		});

		await expect(switchAccount(input, d)).resolves.toMatchObject({
			outcome: "failed",
			reasonCode: "machine_account_conflict",
		});
		expect(d.applyProfile).not.toHaveBeenCalled();
		expect(readStore(storePath).generation).toBe(1);
	});

	it.each([
		[false, true, false],
		[true, false, true],
	] as const)(
		"records identity-sync fact after a committed switch (before=%s synced=%s stale=%s)",
		async (before, identitySynced, expectedStale) => {
			seed({
				generation: 1,
				activeAccount: "personal",
				identityStale: before,
				accounts: [
					{
						name: "personal",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
					{
						name: "school",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
				],
			});
			const result = await switchAccount(
				input,
				deps({
					applyProfile: async () => ({ identitySynced }),
				}),
			);

			expect(result.outcome).toBe("switched");
			expect(readStore(storePath).identityStale).toBe(expectedStale);
		},
	);

	// ─────────────────────────────────────────────────────────────────────────
	// FLY-871 R1/C3 — freshness candidate loop. `applyProfile` (the bash `use`)
	// now verifies the target's pooled token is fresh BEFORE the Keychain write.
	// A stale target throws TargetStaleError → mark it authExpired + try the next
	// candidate. A missing freshness helper throws FreshnessUnavailableError →
	// environmental failure: don't mark, don't loop (a candidate would fail the
	// same way), fail-closed with ZERO Keychain writes.
	// ─────────────────────────────────────────────────────────────────────────
	function threeAccountStore(): AccountStore {
		return {
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "business", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		};
	}

	it("target stale → marks it authExpired (in-lock) and switches to the next candidate", async () => {
		seed(threeAccountStore());
		// selectNextAccount is deterministic alphabetical for 5h: business first.
		const applyProfile = vi.fn(async (name: string) => {
			if (name === "business") throw new TargetStaleError("business");
			return { identitySynced: true };
		});
		const res = await switchAccount(input, deps({ applyProfile }));
		expect(res).toMatchObject({ outcome: "switched", to: "school" });
		// business was tried, marked stale, then school succeeded
		expect(applyProfile).toHaveBeenNthCalledWith(
			1,
			"business",
			expect.any(Object),
		);
		expect(applyProfile).toHaveBeenNthCalledWith(
			2,
			"school",
			expect.any(Object),
		);
		const after = readStore(storePath);
		expect(after.accounts.find((a) => a.name === "business")?.authExpired).toBe(
			true,
		);
		expect(after.activeAccount).toBe("school");
	});

	it("a stale target still commits the delegated proof that the outgoing account was freshened", async () => {
		const store = threeAccountStore();
		store.accounts[0] = {
			...store.accounts[0],
			authExpired: true,
			refreshTokenInvalid: true,
			profileVerifyFailed: true,
			identity: {
				email: "annie@example.com",
				uuid: "uuid-personal",
				setAt: NOW.toISOString(),
			},
			identityMismatch: {
				actualDigest: "a".repeat(64),
				markedBy: "executor",
				markedAt: NOW.toISOString(),
			},
		};
		seed(store);
		const report: ApplyProfileReport = {
			identityChecks: [],
			freshened: {
				name: "personal",
				identityProof: { email: "annie@example.com", uuid: "uuid-personal" },
			},
		};
		const applyProfile = vi.fn(async (name: string) => {
			if (name === "business") throw new TargetStaleError(name, report);
			return { identitySynced: true, identityChecks: [] };
		});

		const result = await switchAccount(input, deps({ applyProfile }));

		expect(result).toMatchObject({
			outcome: "switched",
			to: "school",
			applyReports: [report],
		});
		const after = readStore(storePath);
		const personal = after.accounts.find(
			(account) => account.name === "personal",
		);
		expect(personal?.authExpired).toBeUndefined();
		expect(personal?.refreshTokenInvalid).toBeUndefined();
		expect(personal?.profileVerifyFailed).toBeUndefined();
		expect(personal?.identityMismatch).toBeUndefined();
		expect(
			after.accounts.find((account) => account.name === "business")
				?.authExpired,
		).toBe(true);
	});

	it("does not clear flags when a child freshening fact is not for the locked active account", async () => {
		const store = threeAccountStore();
		store.accounts[1] = { ...store.accounts[1], authExpired: true };
		seed(store);
		const report: ApplyProfileReport = {
			identityChecks: [],
			freshened: {
				name: "school",
				identityProof: { email: "school@example.com", uuid: "uuid-school" },
			},
		};
		const applyProfile = vi.fn(async () => {
			throw new FreshnessUnavailableError("offline", report);
		});

		const result = await switchAccount(input, deps({ applyProfile }));

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "freshness_unavailable",
			applyReports: [report],
		});
		expect(readStore(storePath).accounts[1]?.authExpired).toBe(true);
	});

	it("a Keychain preimage conflict is terminal and suppresses the earlier freshening fact", async () => {
		const store = threeAccountStore();
		store.accounts[0] = { ...store.accounts[0], authExpired: true };
		seed(store);
		const report: ApplyProfileReport = {
			identityChecks: [],
			freshened: {
				name: "personal",
				identityProof: { email: "annie@example.com", uuid: "uuid-personal" },
			},
		};
		const applyProfile = vi.fn(async () => {
			throw new KeychainPreimageConflictError("concurrent login", report);
		});

		const result = await switchAccount(input, deps({ applyProfile }));

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "keychain_preimage_conflict",
		});
		expect(result).not.toHaveProperty("applyReports");
		expect(applyProfile).toHaveBeenCalledTimes(1);
		expect(readStore(storePath).accounts[0]?.authExpired).toBe(true);
	});

	it("an unavailable live identity is terminal without poisoning a candidate", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async () => {
			throw new LiveIdentityUnavailableError("probe unavailable");
		});

		const result = await switchAccount(input, deps({ applyProfile }));

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "live_identity_unavailable",
		});
		expect(applyProfile).toHaveBeenCalledTimes(1);
		expect(
			readStore(storePath).accounts.every((account) => !account.authExpired),
		).toBe(true);
	});

	it("two consecutive stale targets → third candidate succeeds", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async (name: string) => {
			if (name === "business") throw new TargetStaleError("business");
			if (name === "school") throw new TargetStaleError("school");
			// "personal" is currentName (excluded); with only 3 accounts and 2
			// stale, no candidate remains → no_account. Add a 4th usable account.
			return { identitySynced: true };
		});
		// add a 4th account so a third distinct candidate exists
		const s = threeAccountStore();
		s.accounts.push({
			name: "shopping",
			quotaExhaustedUntil: null,
			weeklyResetAt: null,
		});
		seed(s);
		const res = await switchAccount(input, deps({ applyProfile }));
		expect(res).toMatchObject({ outcome: "switched", to: "shopping" });
		const after = readStore(storePath);
		expect(after.accounts.find((a) => a.name === "business")?.authExpired).toBe(
			true,
		);
		expect(after.accounts.find((a) => a.name === "school")?.authExpired).toBe(
			true,
		);
	});

	it("identity mismatch marks only identityMismatch, carries the report, and tries the next candidate", async () => {
		seed(threeAccountStore());
		const report: ApplyProfileReport = {
			identityChecks: [
				{
					label: "business",
					checkpoint: "pre_write",
					verdict: "mismatch",
					expectedKey: "expected-digest",
					actualDigest: "actual-digest",
				},
			],
		};
		const applyProfile = vi.fn(async (name: string) => {
			if (name === "business") {
				throw new TargetIdentityMismatchError(name, "actual-digest", report);
			}
		});

		const result = await switchAccount(input, deps({ applyProfile }));

		expect(result).toMatchObject({
			outcome: "switched",
			to: "school",
			applyReports: [report],
		});
		expect(applyProfile.mock.calls.map(([name]) => name)).toEqual([
			"business",
			"school",
		]);
		const marked = readStore(storePath).accounts.find(
			(account) => account.name === "business",
		);
		expect(marked?.identityMismatch).toEqual({
			actualDigest: "actual-digest",
			markedBy: "executor",
			markedAt: NOW.toISOString(),
		});
		expect(marked?.profileVerifyFailed).toBeUndefined();
		expect(readStore(storePath).generation).toBe(2);
	});

	it("rollback-success then unauthorized skip are attempt-local and a third candidate succeeds", async () => {
		const s = threeAccountStore();
		s.accounts.push({
			name: "shopping",
			quotaExhaustedUntil: null,
			weeklyResetAt: null,
		});
		seed(s);
		const applyProfile = vi.fn(async (name: string) => {
			if (name === "business") throw new TargetIdentityRolledBackError(name);
			if (name === "school") throw new TargetIdentityUnverifiableError(name);
		});

		const result = await switchAccount(
			{
				...input,
				preferredOrder: ["business", "school", "shopping"],
			},
			deps({ applyProfile }),
		);

		expect(result).toMatchObject({ outcome: "switched", to: "shopping" });
		expect(applyProfile.mock.calls.map(([name]) => name)).toEqual([
			"business",
			"school",
			"shopping",
		]);
		const after = readStore(storePath);
		expect(after.accounts.every((account) => !account.identityMismatch)).toBe(
			true,
		);
		expect(
			after.accounts.every((account) => !account.profileVerifyFailed),
		).toBe(true);
	});

	it("rollback failure is fatal and preserves its severe reason code", async () => {
		seed(threeAccountStore());
		const report: ApplyProfileReport = {
			identityChecks: [
				{
					label: "personal",
					checkpoint: "capture_back",
					verdict: "mismatch",
					expectedKey: "expected-digest",
					actualDigest: "actual-digest",
				},
			],
		};
		const applyProfile = vi.fn(async (name: string) => {
			throw new IdentityRollbackFailedError(name, report);
		});

		const result = await switchAccount(input, deps({ applyProfile }));

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "identity_rollback_failed",
			applyReports: [report],
		});
		expect(applyProfile).toHaveBeenCalledTimes(1);
		expect(readStore(storePath).activeAccount).toBe("personal");
		expect(readStore(storePath).generation).toBe(1);
	});

	it("a successful apply carries non-secret capture facts to the switched result", async () => {
		seed(threeAccountStore());
		const report: ApplyProfileReport = {
			identityChecks: [
				{
					label: "personal",
					checkpoint: "capture_back",
					verdict: "mismatch",
					expectedKey: "expected-digest",
					actualDigest: "actual-digest",
				},
			],
		};
		const result = await switchAccount(
			input,
			deps({ applyProfile: vi.fn(async () => report) }),
		);
		expect(result).toMatchObject({
			outcome: "switched",
			applyReports: [report],
		});
	});

	it("all candidates stale → no_account (with earliest reset), Keychain never committed", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async (name: string) => {
			throw new TargetStaleError(name);
		});
		const res = await switchAccount(input, deps({ applyProfile }));
		expect(res).toMatchObject({
			outcome: "no_account",
			reasonCode: "target_stale_exhausted",
		});
		const after = readStore(storePath);
		// active never switched; both non-current accounts flagged authExpired
		expect(after.activeAccount).toBe("personal");
		expect(after.accounts.find((a) => a.name === "school")?.authExpired).toBe(
			true,
		);
		expect(after.accounts.find((a) => a.name === "business")?.authExpired).toBe(
			true,
		);
	});

	it("freshness helper unavailable → failed, NO account marked, NO loop, Keychain never written", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async () => {
			throw new FreshnessUnavailableError();
		});
		const res = await switchAccount(input, deps({ applyProfile }));
		expect(res).toMatchObject({
			outcome: "failed",
			reasonCode: "freshness_unavailable",
		});
		// exactly ONE apply attempt (no candidate loop — a candidate fails the same)
		expect(applyProfile).toHaveBeenCalledTimes(1);
		const after = readStore(storePath);
		expect(after.activeAccount).toBe("personal"); // unchanged
		expect(after.generation).toBe(1);
		// no account was flagged authExpired
		expect(after.accounts.every((a) => !a.authExpired)).toBe(true);
	});

	it("active marker drift is environmental: fail closed without flagging or trying another candidate", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async () => {
			throw new ActiveMarkerDriftError("marker/token witnesses disagree");
		});

		const result = await switchAccount(input, deps({ applyProfile }));

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "active_marker_drift",
		});
		expect(applyProfile).toHaveBeenCalledTimes(1);
		const after = readStore(storePath);
		expect(after.activeAccount).toBe("personal");
		expect(after.generation).toBe(1);
		expect(after.accounts.every((account) => !account.authExpired)).toBe(true);
		expect(after.accounts.every((account) => !account.identityMismatch)).toBe(
			true,
		);
	});

	it("non-stale, non-freshness error keeps the current single fail-closed behavior", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async () => {
			throw new Error("keychain locked");
		});
		const res = await switchAccount(input, deps({ applyProfile }));
		expect(res).toMatchObject({
			outcome: "failed",
			reasonCode: "apply_failed",
		});
		expect(applyProfile).toHaveBeenCalledTimes(1); // no loop
		expect(readStore(storePath).accounts.every((a) => !a.authExpired)).toBe(
			true,
		);
	});

	it("authExpired mark persists even when the whole switch ultimately fails (in-lock atomic)", async () => {
		seed(threeAccountStore());
		// business stale, then school throws a generic error (single fail-closed)
		const applyProfile = vi.fn(async (name: string) => {
			if (name === "business") throw new TargetStaleError("business");
			throw new Error("keychain locked");
		});
		const res = await switchAccount(input, deps({ applyProfile }));
		expect(res.outcome).toBe("failed");
		const after = readStore(storePath);
		// the stale flag on business survived even though the switch failed later
		expect(after.accounts.find((a) => a.name === "business")?.authExpired).toBe(
			true,
		);
		expect(after.activeAccount).toBe("personal"); // never switched
	});

	it("weekly cap also records the exhausted account's weekly reset", async () => {
		seed({
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{
					name: "school",
					quotaExhaustedUntil: null,
					weeklyResetAt: "2026-07-06T14:00:00Z",
				},
			],
		});
		const res = await switchAccount(
			{
				...input,
				scope: "weekly",
				resetAt: "2026-07-06T14:00:00.000Z",
			},
			deps(),
		);
		expect(res.outcome).toBe("switched");
		const personal = readStore(storePath).accounts.find(
			(a) => a.name === "personal",
		);
		expect(personal?.quotaExhaustedUntil).toBe("2026-07-06T14:00:00.000Z");
		expect(personal?.weeklyResetAt).toBe("2026-07-06T14:00:00.000Z");
	});

	it("preferredOrder is passed through on every candidate selection and excludes unverified accounts", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async () => ({ identitySynced: true }));
		const res = await switchAccount(
			{ ...input, preferredOrder: ["school"] },
			deps({ applyProfile }),
		);
		expect(res).toMatchObject({ outcome: "switched", to: "school" });
		expect(applyProfile).toHaveBeenCalledTimes(1);
		expect(applyProfile).toHaveBeenCalledWith("school", expect.any(Object));
	});

	it("a stale first preferred target falls through only to the next verified target", async () => {
		const s = threeAccountStore();
		s.accounts.push({
			name: "shopping",
			quotaExhaustedUntil: null,
			weeklyResetAt: null,
		});
		seed(s);
		const applyProfile = vi.fn(async (name: string) => {
			if (name === "school") throw new TargetStaleError(name);
			return { identitySynced: true };
		});
		const res = await switchAccount(
			{ ...input, preferredOrder: ["school", "shopping"] },
			deps({ applyProfile }),
		);
		expect(res).toMatchObject({ outcome: "switched", to: "shopping" });
		expect(applyProfile.mock.calls.map(([name]) => name)).toEqual([
			"school",
			"shopping",
		]);
	});

	it("quota-exhausted target reloads the guard-updated store and tries the next candidate", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async (name: string) => {
			if (name !== "business") return;
			const latest = readStore(storePath);
			writeStore(
				{
					...latest,
					accounts: latest.accounts.map((entry) =>
						entry.name === name
							? {
									...entry,
									quotaExhaustedUntil: "2026-07-04T03:00:00Z",
									lastObservedAt: NOW.toISOString(),
								}
							: entry,
					),
				},
				storePath,
			);
			throw new TargetQuotaExhaustedError(name);
		});

		const result = await switchAccount(input, deps({ applyProfile }));

		expect(result).toMatchObject({ outcome: "switched", to: "school" });
		expect(applyProfile.mock.calls.map(([name]) => name)).toEqual([
			"business",
			"school",
		]);
	});

	it("all quota-exhausted candidates return target_quota_exhausted", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async (name: string) => {
			const latest = readStore(storePath);
			writeStore(
				{
					...latest,
					accounts: latest.accounts.map((entry) =>
						entry.name === name
							? {
									...entry,
									quotaExhaustedUntil: "2026-07-04T03:00:00Z",
								}
							: entry,
					),
				},
				storePath,
			);
			throw new TargetQuotaExhaustedError(name);
		});

		const result = await switchAccount(input, deps({ applyProfile }));

		expect(result).toMatchObject({
			outcome: "no_account",
			reasonCode: "target_quota_exhausted",
		});
		expect(applyProfile).toHaveBeenCalledTimes(2);
	});

	it("renews the actual resolved lock path before every candidate attempt", async () => {
		seed(threeAccountStore());
		const customLock = join(dir, "custom.lock");
		const renewLock = vi.fn(() => true);

		await switchAccount(input, deps({ lockPath: customLock, renewLock }));

		expect(renewLock).toHaveBeenCalledWith(customLock);
		// Candidate entry + parent-side post-settle fence before commit.
		expect(renewLock).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ label: "returns false", renewLock: () => false },
		{
			label: "throws",
			renewLock: () => {
				throw new Error("holder replaced");
			},
		},
	])(
		"stops before any apply when lock renewal $label",
		async ({ renewLock }) => {
			seed(threeAccountStore());
			const applyProfile = vi.fn(async () => {});

			const result = await switchAccount(
				input,
				deps({ applyProfile, renewLock }),
			);

			expect(result).toMatchObject({
				outcome: "failed",
				reasonCode: "lock_lease_lost",
			});
			expect(applyProfile).not.toHaveBeenCalled();
			expect(readStore(storePath).generation).toBe(1);
		},
	);

	it("a mid-loop renewal loss stops all later candidates and shared writes", async () => {
		seed(threeAccountStore());
		const renewLock = vi
			.fn<SwitchDeps["renewLock"]>()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		const applyProfile = vi.fn(async (name: string) => {
			if (name === "business") throw new TargetStaleError(name);
		});

		const result = await switchAccount(
			input,
			deps({ applyProfile, renewLock }),
		);

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "lock_lease_lost",
		});
		expect(applyProfile.mock.calls.map(([name]) => name)).toEqual(["business"]);
		expect(readStore(storePath).activeAccount).toBe("personal");
	});

	it("never applies a preferred target with an exhausted fact newer than verification", async () => {
		const s = threeAccountStore();
		s.accounts.find((entry) => entry.name === "school")!.quotaExhaustedUntil =
			"2026-07-04T03:00:00Z";
		s.accounts.find((entry) => entry.name === "school")!.lastObservedAt =
			"2026-07-03T20:00:01Z";
		seed(s);
		const applyProfile = vi.fn(async () => {});

		const result = await switchAccount(
			{
				...input,
				preferredOrder: ["school", "business"],
				verifiedAt: "2026-07-03T20:00:00Z",
			},
			deps({ applyProfile }),
		);

		expect(result).toMatchObject({ outcome: "switched", to: "business" });
		expect(applyProfile).toHaveBeenCalledWith("business", expect.any(Object));
		expect(applyProfile.mock.calls.some(([name]) => name === "school")).toBe(
			false,
		);
	});

	it("maps completed journal reconciliation to noop_reconciled without running the stale callback", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async () => {});
		const result = await switchAccount(
			input,
			deps({
				applyProfile,
				withLock: async () => ({
					kind: "reconciled",
					activeAccount: "school",
					generation: 8,
				}),
			}),
		);

		expect(result).toEqual({
			outcome: "noop_reconciled",
			activeAccount: "school",
			generation: 8,
		});
		expect(applyProfile).not.toHaveBeenCalled();
	});

	it.each([
		{
			reason: { kind: "writer_alive" } as const,
			reasonCode: "transition_journal_writer_alive",
		},
		{
			reason: {
				kind: "conflict",
				detail: "digest_mismatch_both",
			} as const,
			reasonCode: "transition_journal_conflict",
		},
	])(
		"maps a blocked journal ($reason.kind) without applying",
		async ({ reason, reasonCode }) => {
			seed(threeAccountStore());
			const applyProfile = vi.fn(async () => {});
			const result = await switchAccount(
				input,
				deps({
					applyProfile,
					withLock: async () => ({ kind: "blocked", reason }),
				}),
			);
			expect(result).toMatchObject({ outcome: "failed", reasonCode });
			expect(applyProfile).not.toHaveBeenCalled();
		},
	);

	it("fails loudly when an injected lock returns an untagged callback result", async () => {
		seed(threeAccountStore());
		const offContractLock = (async (lockPath, fn) =>
			fn({ ...lease, lockPath })) as unknown as SwitchDeps["withLock"];

		await expect(
			switchAccount(input, deps({ withLock: offContractLock })),
		).rejects.toThrow(/invalid account lock result/i);
	});

	it("aborts the mutation process group when heartbeat renewal loses the lease", async () => {
		seed(threeAccountStore());
		const renewLock = vi
			.fn<SwitchDeps["renewLock"]>()
			.mockReturnValueOnce(true)
			.mockReturnValue(false);
		let aborted = false;
		const applyProfile: SwitchDeps["applyProfile"] = vi.fn(
			async (_name, context) =>
				new Promise<void>((_resolve, reject) => {
					context.signal.addEventListener("abort", () => {
						aborted = true;
						reject(context.signal.reason);
					});
				}),
		);

		const result = await switchAccount(
			input,
			deps({ applyProfile, renewLock, heartbeatMs: 1 }),
		);

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "lock_lease_lost",
		});
		expect(aborted).toBe(true);
		expect(readStore(storePath).generation).toBe(1);
	});

	it("re-proofs after child settle and refuses the parent commit on ownership change", async () => {
		seed(threeAccountStore());
		const validateLease = vi
			.fn<(proof: LeaseProof) => boolean>()
			.mockReturnValueOnce(true)
			.mockReturnValue(false);
		const result = await switchAccount(
			input,
			deps({ validateLease, heartbeatMs: 60_000 }),
		);

		expect(result).toMatchObject({
			outcome: "failed",
			reasonCode: "lock_lease_lost",
		});
		expect(readStore(storePath).generation).toBe(1);
		expect(readStore(storePath).activeAccount).toBe("personal");
	});
});
