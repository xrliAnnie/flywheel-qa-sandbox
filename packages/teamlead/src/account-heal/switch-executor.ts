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
import type { AccountsLock } from "./accounts-lock.js";
import { type LeaseProof, validateLeaseProof } from "./mkdir-lock.js";

export interface SwitchInput {
	scope: "5h" | "weekly" | "both";
	/** The account observed as capped at detection (CAS key). */
	observedAccount: string;
	observedGeneration: number;
	/** ISO reset instant of the hit window — recorded as the account's cooldown. */
	resetAt: string;
	now: Date;
	/** Quota-verified target ranking; when present, unlisted accounts are excluded. */
	preferredOrder?: string[];
	/** Start instant of the live verification round that produced preferredOrder. */
	verifiedAt?: string;
	/** Whether the bash apply may skip its independent live quota guard. */
	quotaPreverified?: boolean;
}

export interface SwitchDeps {
	storePath?: string;
	lockPath?: string;
	/** Acquire the interprocess lock, run `fn`, release. Injected (see withLock impls). */
	withLock: AccountsLock;
	/** Refresh the lease for the resolved lock path before each candidate attempt. */
	renewLock: (lockPath: string) => boolean;
	/** Write the chosen account into the machine credential source (A: Keychain). Throws on failure → fail-closed. */
	applyProfile: (
		name: string,
		context: { lease: LeaseProof; signal: AbortSignal },
	) => Promise<void>;
	/** The account the real profile is currently active on (crash-recovery authority). */
	readActiveProfile: () => Promise<string | null>;
	/** Parent-side final fence seam. Defaults to marker-token validation. */
	validateLease?: (lease: LeaseProof) => boolean;
	/** Renewal cadence while the detached mutation process group is alive. */
	heartbeatMs?: number;
}

export type SwitchResult =
	| { outcome: "switched"; from: string; to: string; generation: number }
	| { outcome: "noop_already_switched"; activeAccount: string }
	| { outcome: "noop_reconciled"; activeAccount: string; generation: number }
	| {
			outcome: "no_account";
			earliestReset: string | null;
			reasonCode:
				| "no_eligible_account"
				| "target_stale_exhausted"
				| "target_quota_exhausted";
	  }
	| {
			outcome: "failed";
			reason: string;
			reasonCode:
				| "freshness_unavailable"
				| "apply_failed"
				| "lock_lease_lost"
				| "transition_journal_conflict"
				| "transition_journal_writer_alive";
	  };

export class LockLeaseLostError extends Error {
	constructor(detail?: string) {
		super(`account lock lease lost${detail ? `: ${detail}` : ""}`);
		this.name = "LockLeaseLostError";
	}
}

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

export class TargetQuotaExhaustedError extends Error {
	constructor(public readonly account: string) {
		super(`target account '${account}' has exhausted Claude quota`);
		this.name = "TargetQuotaExhaustedError";
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
					switchCooldownUntil: input.resetAt,
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

	const locked = await deps.withLock<SwitchResult>(lockPath, async (lease) => {
		const validate = deps.validateLease ?? validateLeaseProof;
		const fence = (): boolean => {
			try {
				return deps.renewLock(lockPath) && validate(lease);
			} catch {
				return false;
			}
		};
		const leaseLost = (): SwitchResult => ({
			outcome: "failed",
			reason: `lost account lock lease: ${lockPath}`,
			reasonCode: "lock_lease_lost",
		});
		const applyWithHeartbeat = async (name: string): Promise<void> => {
			const controller = new AbortController();
			let lost = false;
			const timer = setInterval(() => {
				if (fence()) return;
				lost = true;
				controller.abort(new LockLeaseLostError(lockPath));
			}, deps.heartbeatMs ?? 1_000);
			try {
				await deps.applyProfile(name, {
					lease,
					signal: controller.signal,
				});
			} catch (error) {
				if (lost || error instanceof LockLeaseLostError) {
					throw new LockLeaseLostError(lockPath);
				}
				throw error;
			} finally {
				clearInterval(timer);
			}
			if (lost) throw new LockLeaseLostError(lockPath);
		};
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
		let targetStaleSeen = false;
		let targetQuotaSeen = false;
		const attemptedNames = new Set<string>();
		const maxAttempts = store.accounts.length + 1;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (!fence()) return leaseLost();
			const next = selectNextAccount(working, {
				scope: input.scope,
				currentName: input.observedAccount,
				now: input.now,
				preferredOrder: input.preferredOrder,
				verifiedAt: input.verifiedAt,
				excludeNames: attemptedNames,
			});
			if (next === null) {
				return {
					outcome: "no_account",
					earliestReset: earliestReset(working, input.now.getTime()),
					reasonCode: targetQuotaSeen
						? "target_quota_exhausted"
						: targetStaleSeen
							? "target_stale_exhausted"
							: "no_eligible_account",
				};
			}
			attemptedNames.add(next);
			try {
				await applyWithHeartbeat(next);
				// The child may settle in the gap before the next heartbeat. Re-proof
				// after the entire process group has exited and before any parent write.
				if (!fence()) return leaseLost();
				applied = next;
				break;
			} catch (err) {
				if (err instanceof LockLeaseLostError || !fence()) return leaseLost();
				if (err instanceof TargetQuotaExhaustedError) {
					targetQuotaSeen = true;
					working = readStore(storePath);
					continue;
				}
				if (err instanceof TargetStaleError) {
					targetStaleSeen = true;
					working = markAuthExpired(working, next);
					if (!fence()) return leaseLost();
					writeStore(working, storePath); // in-lock, atomic
					continue;
				}
				if (err instanceof FreshnessUnavailableError) {
					return {
						outcome: "failed",
						reason: err.message,
						reasonCode: "freshness_unavailable",
					};
				}
				return {
					outcome: "failed",
					reason: err instanceof Error ? err.message : String(err),
					reasonCode: "apply_failed",
				};
			}
		}
		if (applied === null) {
			return {
				outcome: "no_account",
				earliestReset: earliestReset(working, input.now.getTime()),
				reasonCode: targetQuotaSeen
					? "target_quota_exhausted"
					: targetStaleSeen
						? "target_stale_exhausted"
						: "no_eligible_account",
			};
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

	if (typeof locked !== "object" || locked === null || !("kind" in locked)) {
		throw new Error(
			"invalid account lock result: expected tagged LockRunResult",
		);
	}
	switch (locked.kind) {
		case "ok":
			return locked.value;
		case "reconciled":
			return {
				outcome: "noop_reconciled",
				activeAccount: locked.activeAccount,
				generation: locked.generation,
			};
		case "blocked":
			return locked.reason.kind === "conflict"
				? {
						outcome: "failed",
						reason: `transition journal conflict: ${locked.reason.detail}`,
						reasonCode: "transition_journal_conflict",
					}
				: {
						outcome: "failed",
						reason: "transition writer process group is still alive",
						reasonCode: "transition_journal_writer_alive",
					};
		default:
			throw new Error(
				"invalid account lock result: unknown LockRunResult kind",
			);
	}
}
