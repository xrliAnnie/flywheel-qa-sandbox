/**
 * FLY-696 M1/C5 — the Claude account switch executor.
 *
 * The account-keyed, CAS-guarded, interprocess-lock-serialized mechanical switch
 * that the Bridge owns (Codex R5: Claude-only for the MVP; Codex keeps its
 * per-runner fallback). The critical section — read active → reconcile → CAS →
 * select → apply (Keychain write) → commit state — runs entirely inside one lock
 * so a manual `flywheel-claude-profile use`, a QA-slot Bridge, a restarted
 * Bridge, or an Infra Bot can never interleave and double-switch.
 *
 * The A-specific, destructive Keychain write is DELIBERATELY behind the injected
 * `applyProfile` (real = `flywheel-claude-profile use`, verify-before-commit) so
 * this orchestration is fully testable without touching real credentials, and
 * the destructive write stays isolated in its own final commit.
 *
 * `readActiveProfile` is the crash-recovery authority: if a prior switch wrote
 * the Keychain but crashed before committing state, the real profile's `.active`
 * is trusted over the stale JSON, so the CAS sees the true active account and
 * refuses a double-switch.
 */

import {
	type AccountStore,
	defaultStorePath,
	earliestReset,
	readStore,
	selectNextAccount,
	writeStore,
} from "./account-store.js";

export interface SwitchInput {
	scope: "5h" | "weekly" | "both";
	/** The account observed as capped at detection (CAS key). */
	observedAccount: string;
	observedGeneration: number;
	/** ISO reset instant of the hit window — recorded as the account's cooldown. */
	resetAt: string;
	now: Date;
}

export interface SwitchDeps {
	storePath?: string;
	lockPath?: string;
	/** Acquire the interprocess lock, run `fn`, release. Injected (see withLock impls). */
	withLock: <T>(lockPath: string, fn: () => Promise<T>) => Promise<T>;
	/** Write the chosen account into the machine credential source (A: Keychain). Throws on failure → fail-closed. */
	applyProfile: (name: string) => Promise<void>;
	/** The account the real profile is currently active on (crash-recovery authority). */
	readActiveProfile: () => Promise<string | null>;
}

export type SwitchResult =
	| { outcome: "switched"; from: string; to: string; generation: number }
	| { outcome: "noop_already_switched"; activeAccount: string }
	| { outcome: "no_account"; earliestReset: string | null }
	| { outcome: "failed"; reason: string };

/**
 * FLY-871 R1/C3 — the target's pooled credential failed freshness verification
 * (bash `use` exit 30): its OAuth refresh-token family is dead, so writing it to
 * the Keychain would strand live sessions (the 2026-07-04 incident). `switchAccount`
 * catches this, flags the account `authExpired`, and rotates to the next candidate.
 */
export class TargetStaleError extends Error {
	constructor(public readonly account: string) {
		super(
			`target account '${account}' has a stale pooled credential (freshness refresh refused)`,
		);
		this.name = "TargetStaleError";
	}
}

/**
 * FLY-871 R1/C3 — the freshness helper itself was unavailable (bash `use` exit
 * 31: node/helper missing or crashed). This is ENVIRONMENTAL, not an account
 * problem — every candidate would fail identically — so `switchAccount` fails
 * closed WITHOUT flagging any account and WITHOUT trying candidates.
 */
export class FreshnessUnavailableError extends Error {
	constructor(detail?: string) {
		super(
			`token freshness helper unavailable — refusing to switch (fail-closed)${
				detail ? `: ${detail}` : ""
			}`,
		);
		this.name = "FreshnessUnavailableError";
	}
}

function markAuthExpired(store: AccountStore, name: string): AccountStore {
	return {
		...store,
		accounts: store.accounts.map((a) =>
			a.name === name ? { ...a, authExpired: true } : a,
		),
	};
}

/** Default lockfile beside the state file. */
export function defaultLockPath(): string {
	return defaultStorePath().replace(/\.json$/, ".lock");
}

function commitSwitch(
	store: AccountStore,
	input: SwitchInput,
	to: string,
): AccountStore {
	const isWeekly = input.scope === "weekly" || input.scope === "both";
	const accounts = store.accounts.map((a) =>
		a.name === input.observedAccount
			? {
					...a,
					quotaExhaustedUntil: input.resetAt,
					...(isWeekly ? { weeklyResetAt: input.resetAt } : {}),
				}
			: a,
	);
	return {
		generation: store.generation + 1,
		activeAccount: to,
		accounts,
	};
}

export async function switchAccount(
	input: SwitchInput,
	deps: SwitchDeps,
): Promise<SwitchResult> {
	const storePath = deps.storePath ?? defaultStorePath();
	const lockPath = deps.lockPath ?? defaultLockPath();

	return deps.withLock(lockPath, async () => {
		let store = readStore(storePath);

		// Crash recovery: the real profile's active account wins over stale JSON.
		const realActive = await deps.readActiveProfile();
		if (realActive !== null && realActive !== store.activeAccount) {
			store = { ...store, activeAccount: realActive };
		}

		// CAS: only switch if the active account is still the one observed as capped.
		if (
			store.activeAccount !== null &&
			store.activeAccount !== input.observedAccount
		) {
			return {
				outcome: "noop_already_switched",
				activeAccount: store.activeAccount,
			};
		}
		// CAS part 2 (Codex code R1 MED-3): the GENERATION must also match. The
		// name alone is not enough — after A→B→…→A the active NAME equals the
		// stale pending's observedAccount again, but its generation has bumped;
		// acting on that stale observation would rotate away from a healthy A.
		// (Crash recovery above is unaffected: an uncommitted switch never bumped
		// the stored generation, and its name-mismatch already no-ops.)
		if (store.generation !== input.observedGeneration) {
			return {
				outcome: "noop_already_switched",
				activeAccount: store.activeAccount ?? input.observedAccount,
			};
		}

		// FLY-871 R1/C3 — freshness candidate loop. The destructive Keychain write
		// (inside applyProfile = bash `use`) now probe-refreshes the target's pooled
		// token first. A STALE target throws TargetStaleError → flag it authExpired
		// (persisted in-lock so the flag survives even if the whole switch later
		// fails) and re-select; selectNextAccount already skips authExpired accounts,
		// so the loop converges. A missing helper (FreshnessUnavailableError) is
		// environmental → fail closed with no flag, no loop. On failure the active
		// account is left untouched (never a half-switched pool). Bounded by pool
		// size as a backstop.
		let working = store;
		let applied: string | null = null;
		const maxAttempts = store.accounts.length + 1;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const next = selectNextAccount(working, {
				scope: input.scope,
				currentName: input.observedAccount,
				now: input.now,
			});
			if (next === null) {
				return { outcome: "no_account", earliestReset: earliestReset(working) };
			}
			try {
				await deps.applyProfile(next);
				applied = next;
				break;
			} catch (err) {
				if (err instanceof TargetStaleError) {
					working = markAuthExpired(working, next);
					writeStore(working, storePath); // in-lock, atomic
					continue;
				}
				if (err instanceof FreshnessUnavailableError) {
					return { outcome: "failed", reason: err.message };
				}
				return {
					outcome: "failed",
					reason: err instanceof Error ? err.message : String(err),
				};
			}
		}
		if (applied === null) {
			return { outcome: "no_account", earliestReset: earliestReset(working) };
		}

		const updated = commitSwitch(working, input, applied);
		writeStore(updated, storePath);
		return {
			outcome: "switched",
			from: input.observedAccount,
			to: applied,
			generation: updated.generation,
		};
	});
}
