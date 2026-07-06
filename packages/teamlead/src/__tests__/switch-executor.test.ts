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
	readStore,
	writeStore,
} from "../account-heal/account-store.js";
import {
	FreshnessUnavailableError,
	type SwitchDeps,
	switchAccount,
	TargetStaleError,
} from "../account-heal/switch-executor.js";

const NOW = new Date("2026-07-03T20:00:00Z");

let dir: string;
let storePath: string;
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
		withLock: async (_lock, fn) => fn(),
		applyProfile: vi.fn(async () => {}),
		readActiveProfile: async () => readStore(storePath).activeAccount,
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

describe("switchAccount", () => {
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
		expect(d.applyProfile).toHaveBeenCalledWith("school");
		const after = readStore(storePath);
		expect(after.activeAccount).toBe("school");
		expect(after.generation).toBe(2);
		expect(
			after.accounts.find((a) => a.name === "personal")?.quotaExhaustedUntil,
		).toBe("2026-07-04T02:30:00.000Z");
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
		expect(res.outcome).toBe("no_account");
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
		expect(res.outcome).toBe("failed");
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
		const withLock = vi.fn(async (_lock: string, fn: () => Promise<unknown>) =>
			fn(),
		);
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
		});
		const res = await switchAccount(input, deps({ applyProfile }));
		expect(res).toMatchObject({ outcome: "switched", to: "school" });
		// business was tried, marked stale, then school succeeded
		expect(applyProfile).toHaveBeenNthCalledWith(1, "business");
		expect(applyProfile).toHaveBeenNthCalledWith(2, "school");
		const after = readStore(storePath);
		expect(after.accounts.find((a) => a.name === "business")?.authExpired).toBe(
			true,
		);
		expect(after.activeAccount).toBe("school");
	});

	it("two consecutive stale targets → third candidate succeeds", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async (name: string) => {
			if (name === "business") throw new TargetStaleError("business");
			if (name === "school") throw new TargetStaleError("school");
			// "personal" is currentName (excluded); with only 3 accounts and 2
			// stale, no candidate remains → no_account. Add a 4th usable account.
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

	it("all candidates stale → no_account (with earliest reset), Keychain never committed", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async (name: string) => {
			throw new TargetStaleError(name);
		});
		const res = await switchAccount(input, deps({ applyProfile }));
		expect(res.outcome).toBe("no_account");
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
		expect(res.outcome).toBe("failed");
		// exactly ONE apply attempt (no candidate loop — a candidate fails the same)
		expect(applyProfile).toHaveBeenCalledTimes(1);
		const after = readStore(storePath);
		expect(after.activeAccount).toBe("personal"); // unchanged
		expect(after.generation).toBe(1);
		// no account was flagged authExpired
		expect(after.accounts.every((a) => !a.authExpired)).toBe(true);
	});

	it("non-stale, non-freshness error keeps the current single fail-closed behavior", async () => {
		seed(threeAccountStore());
		const applyProfile = vi.fn(async () => {
			throw new Error("keychain locked");
		});
		const res = await switchAccount(input, deps({ applyProfile }));
		expect(res.outcome).toBe("failed");
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
});
