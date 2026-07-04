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

		const next = selectNextAccount(store, {
			scope: input.scope,
			currentName: input.observedAccount,
			now: input.now,
		});
		if (next === null) {
			return { outcome: "no_account", earliestReset: earliestReset(store) };
		}

		// The destructive Keychain write. On failure, state is left untouched
		// (fail-closed) — never leave the pool in a half-switched state.
		try {
			await deps.applyProfile(next);
		} catch (err) {
			return {
				outcome: "failed",
				reason: err instanceof Error ? err.message : String(err),
			};
		}

		const updated = commitSwitch(store, input, next);
		writeStore(updated, storePath);
		return {
			outcome: "switched",
			from: input.observedAccount,
			to: next,
			generation: updated.generation,
		};
	});
}
