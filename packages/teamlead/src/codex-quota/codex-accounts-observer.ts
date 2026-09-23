/**
 * FLY-2688 — real per-account Codex quota readings for the account page.
 *
 * Enumerates the profile slots on disk (so accounts the registry does not list
 * are read too), reads each one's `account/rateLimits/read` in an isolated
 * CODEX_HOME, and persists back any refresh-token rotation the read caused.
 *
 * Deliberately on-demand only: nothing here is scheduled. An account in use by
 * a live Codex process is read only through WHAM GET; that path never refreshes,
 * persists, leases, or otherwise shares the single-use refresh-token family.
 */

import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type CodexAccountPool,
	identifyCodexAuth,
} from "flywheel-claude-runner/bin/codex-account-core.mjs";
import {
	acquireCodexAccountLease,
	codexInstallAccountKey,
	persistCodexProfileQuotaRefresh,
} from "flywheel-claude-runner/bin/codex-account-install.mjs";
import type {
	CodexAccountQuotaStore,
	CodexAccountReading,
} from "./codex-account-quota-store.js";
import { CodexCandidateWorkspace, codexQuotaIdentityReader } from "./probe.js";
import { readCodexQuota } from "./quota-reader.js";
import { parseCodexRateLimitDetail } from "./rate-limit-detail.js";
import {
	type ReadCodexReadonlyUsageOptions,
	readCodexReadonlyUsage,
} from "./readonly-usage-reader.js";

const DEFAULT_TOTAL_DEADLINE_MS = 45_000;

export type CodexInUseVerdict = boolean | "unknown";

export interface CodexAccountsObserverOptions {
	profilesRoot: string;
	/** `<codex home>/auth.json`; its identity names the currently active slot. */
	canonicalAuthPath: string;
	workspaceRoot: string;
	binary: string;
	/** Loaded once at the beginning of each refresh round. */
	pool: () => CodexAccountPool;
	limitId: string;
	now?: () => number;
	totalDeadlineMs?: number;
	signal?: AbortSignal;
	/**
	 * True while a live Codex process holds this account's credentials;
	 * "unknown" when the host inventory could not be read (also skips the probe,
	 * but must not be reported to the founder as "in use").
	 */
	isInUse?: (accountKey: string, slot: string) => CodexInUseVerdict;
	/**
	 * Re-reads the in-use inventory right before each slot, mirroring
	 * `CodexQuotaRuntime.observe()`. A round can run for a minute, so a Lead that
	 * launches mid-round must still be seen.
	 */
	refreshInUse?: () => Promise<
		(accountKey: string, slot: string) => CodexInUseVerdict
	>;
	readInUseQuota?: (
		options: ReadCodexReadonlyUsageOptions,
	) => ReturnType<typeof readCodexReadonlyUsage>;
	/** Last store, so an unread account still shows its previous reading. */
	previous?: CodexAccountQuotaStore | null;
}

const EMPTY_CREDITS: CodexAccountReading["credits"] = {
	known: false,
	hasCredits: null,
	unlimited: null,
	balance: null,
};
const EMPTY_RESET_CREDITS: CodexAccountReading["resetCredits"] = {
	known: false,
	value: null,
	availableCount: null,
	credits: null,
};

function carried(
	previous: CodexAccountReading | undefined,
	identityKey: string,
): Pick<
	CodexAccountReading,
	| "observedAt"
	| "planType"
	| "fiveH"
	| "weekly"
	| "credits"
	| "creditsObservedAt"
	| "resetCredits"
	| "resetCreditsObservedAt"
	| "unclassifiedWindows"
> {
	if (previous?.identityKey !== identityKey) previous = undefined;
	return {
		observedAt: previous?.observedAt ?? null,
		planType: previous?.planType ?? null,
		fiveH: previous?.fiveH ?? null,
		weekly: previous?.weekly ?? null,
		credits: previous?.credits ?? EMPTY_CREDITS,
		creditsObservedAt:
			previous?.creditsObservedAt ?? previous?.observedAt ?? null,
		resetCredits: previous?.resetCredits ?? EMPTY_RESET_CREDITS,
		resetCreditsObservedAt:
			previous?.resetCreditsObservedAt ?? previous?.observedAt ?? null,
		unclassifiedWindows: previous?.unclassifiedWindows ?? 0,
	};
}

/** Clears a pending candidate recovery so the next read can take the lease. */
function clearPendingRecovery(
	options: CodexAccountsObserverOptions,
	pool: CodexAccountPool,
	slot: string,
	accountKey: string,
): boolean {
	const lease = acquireCodexAccountLease(options.profilesRoot, accountKey);
	try {
		const pending = lease.orphanRecovery;
		if (!pending) return true;
		const persisted = persistCodexProfileQuotaRefresh({
			profilesRoot: options.profilesRoot,
			profileDir: slot,
			registry: pool,
			accountKey,
			finalAuthPath: pending.authPath,
			expectedProfileDigest: pending.originalAuthDigest,
			accountLease: lease,
		}).profilePersisted;
		if (persisted) {
			// The credentials are durable in the slot now; the isolated home still
			// holds a 0600 copy, so drop it instead of leaving tokens on disk.
			const home = dirname(pending.authPath);
			const root = resolve(options.workspaceRoot);
			if (resolve(home) !== root && resolve(home).startsWith(`${root}/`)) {
				rmSync(home, { recursive: true, force: true });
			}
		}
		return persisted;
	} catch {
		return false;
	} finally {
		try {
			lease.release();
		} catch {
			/* the lock is already gone */
		}
	}
}

async function readSlot(
	options: CodexAccountsObserverOptions,
	pool: CodexAccountPool,
	input: {
		slot: string;
		accountKey: string;
		email: string;
		profile: string;
		nowIso: string;
		previous: CodexAccountReading | undefined;
	},
): Promise<
	Pick<CodexAccountReading, "authHealth" | "note"> & ReturnType<typeof carried>
> {
	const workspace = new CodexCandidateWorkspace(options.workspaceRoot, {
		profilesRoot: options.profilesRoot,
	});
	const slotAuthPath = join(options.profilesRoot, input.slot, "auth.json");
	return workspace.run(
		input.accountKey,
		() => Promise.resolve(readFileSync(slotAuthPath, "utf8")),
		async (candidate) => {
			let captured: unknown;
			const read = await readCodexQuota({
				workspace: candidate,
				binary: options.binary,
				profile: input.profile,
				accountKey: input.accountKey,
				limitId: options.limitId,
				identify: codexQuotaIdentityReader(pool),
				...(options.signal ? { signal: options.signal } : {}),
				accountMatches: (account) =>
					!!account &&
					typeof account === "object" &&
					"email" in account &&
					(account as { email: unknown }).email === input.email,
				captureResult: (result) => {
					captured = result;
				},
			});
			const persisted = persistCodexProfileQuotaRefresh({
				profilesRoot: options.profilesRoot,
				profileDir: input.slot,
				registry: pool,
				accountKey: input.accountKey,
				finalAuthPath: read.finalAuthPath,
				expectedProfileDigest: candidate.originalAuthDigest,
				accountLease: candidate.accountLease,
			});
			if (persisted.profilePersisted) {
				await candidate.discardAfterCredentialPersistence(slotAuthPath);
			}
			if (read.reason === "refresh_invalid") {
				return {
					authHealth: "refresh_invalid" as const,
					note:
						read.refreshFailure === "revoked"
							? "token_revoked"
							: read.refreshFailure === "expired"
								? "token_expired"
								: "refresh_invalid",
					...carried(input.previous, input.accountKey),
				};
			}
			if (read.reason === "identity_mismatch") {
				return {
					authHealth: "unknown" as const,
					note: "identity_mismatch",
					...carried(input.previous, input.accountKey),
				};
			}
			const detail =
				read.reason === "ok"
					? parseCodexRateLimitDetail(
							captured,
							options.limitId,
							Date.parse(input.nowIso),
						)
					: null;
			if (detail === null) {
				return {
					authHealth: persisted.profilePersisted
						? ("unknown" as const)
						: ("recovery_uncertain" as const),
					note: persisted.profilePersisted
						? "read_failed"
						: "recovery_uncertain",
					...carried(input.previous, input.accountKey),
				};
			}
			return {
				authHealth: persisted.profilePersisted
					? ("valid" as const)
					: ("recovery_uncertain" as const),
				note: persisted.profilePersisted ? null : "recovery_uncertain",
				observedAt: input.nowIso,
				planType: detail.planType,
				fiveH: detail.fiveH,
				weekly: detail.weekly,
				credits: detail.credits,
				creditsObservedAt: input.nowIso,
				resetCredits: detail.resetCredits,
				resetCreditsObservedAt: input.nowIso,
				unclassifiedWindows: detail.unclassifiedWindows,
			};
		},
	);
}

export async function observeCodexAccounts(
	options: CodexAccountsObserverOptions,
): Promise<CodexAccountQuotaStore> {
	const now = options.now ?? Date.now;
	const nowIso = new Date(now()).toISOString();
	const pool = options.pool();
	const identify = codexQuotaIdentityReader(pool);
	const deadlineAt =
		Date.now() + (options.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS);
	const previousByName = new Map(
		(options.previous?.accounts ?? []).map((account) => [
			account.name,
			account,
		]),
	);
	let canonicalAccountKey: string | null = null;
	try {
		canonicalAccountKey = identify(
			readFileSync(options.canonicalAuthPath, "utf8"),
		).accountKey;
	} catch {
		/* an unreadable canonical home only means "active slot unprovable" */
	}

	const accounts: CodexAccountReading[] = [];
	let activeAccount: string | null = null;
	for (const slotRecord of pool.slots) {
		if (slotRecord.state === "invalid_name") continue;
		const slot = slotRecord.name;
		const previous = previousByName.get(slot);
		const base = { name: slot, registeredProfile: null as string | null };
		const problem = pool.problems.find((entry) => entry.name === slot)?.code;
		if (problem) {
			const identityKey = slotRecord.identity
				? codexInstallAccountKey(slotRecord.identity)
				: undefined;
			if (identityKey === canonicalAccountKey) activeAccount = slot;
			accounts.push({
				...base,
				...(identityKey ? { identityKey } : {}),
				authHealth: problem === "duplicate_email" ? "unknown" : "missing",
				note: problem,
				observedAt: null,
				planType: null,
				fiveH: null,
				weekly: null,
				credits: EMPTY_CREDITS,
				resetCredits: EMPTY_RESET_CREDITS,
				unclassifiedWindows: 0,
			});
			continue;
		}
		let identity: ReturnType<typeof identifyCodexAuth>;
		try {
			identity = identifyCodexAuth(
				readFileSync(join(options.profilesRoot, slot, "auth.json"), "utf8"),
				pool,
			);
		} catch {
			accounts.push({
				...base,
				authHealth: "missing",
				note: "read_failed",
				...carried(previous, ""),
			});
			continue;
		}
		const accountKey = codexInstallAccountKey(identity);
		const registeredProfile =
			pool.profiles.find((entry) => entry.email === identity.email)?.name ??
			null;
		if (accountKey === canonicalAccountKey) activeAccount = slot;
		const reading = (
			extra: Pick<CodexAccountReading, "authHealth" | "note"> &
				ReturnType<typeof carried>,
		): CodexAccountReading => ({
			...base,
			registeredProfile,
			identityKey: accountKey,
			...extra,
		});

		// Deadline first: an expired round must not pay for an inventory scan.
		if (Date.now() >= deadlineAt || options.signal?.aborted === true) {
			accounts.push(
				reading({
					authHealth: "unknown",
					note: "deadline",
					...carried(previous, accountKey),
				}),
			);
			continue;
		}
		const guard = options.refreshInUse
			? await options.refreshInUse().catch(() => () => "unknown" as const)
			: options.isInUse;
		const inUse = guard?.(accountKey, slot) ?? false;
		if (inUse === "unknown") {
			accounts.push(
				reading({
					authHealth: "unknown",
					note: "inventory_unavailable",
					...carried(previous, accountKey),
				}),
			);
			continue;
		}
		if (inUse === true) {
			const matchingPrevious =
				previous?.identityKey === accountKey ? previous : undefined;
			const readonly = await (options.readInUseQuota ?? readCodexReadonlyUsage)(
				{
					authPath:
						accountKey === canonicalAccountKey
							? options.canonicalAuthPath
							: join(options.profilesRoot, slot, "auth.json"),
					registry: pool,
					expectedAccountKey: accountKey,
					now,
					...(options.signal ? { signal: options.signal } : {}),
				},
			);
			if ("ok" in readonly) {
				const creditsKnown = readonly.ok.credits.known;
				const resetCreditsKnown = readonly.ok.resetCredits.known;
				accounts.push(
					reading({
						authHealth: "valid",
						note: null,
						...readonly.ok,
						credits: creditsKnown
							? readonly.ok.credits
							: (matchingPrevious?.credits ?? readonly.ok.credits),
						creditsObservedAt: creditsKnown
							? readonly.ok.observedAt
							: (matchingPrevious?.creditsObservedAt ??
								matchingPrevious?.observedAt ??
								null),
						resetCredits: resetCreditsKnown
							? readonly.ok.resetCredits
							: (matchingPrevious?.resetCredits ?? readonly.ok.resetCredits),
						resetCreditsObservedAt: resetCreditsKnown
							? readonly.ok.observedAt
							: (matchingPrevious?.resetCreditsObservedAt ??
								matchingPrevious?.observedAt ??
								null),
					}),
				);
				continue;
			}
			const note =
				readonly.error === "identity_mismatch"
					? "identity_mismatch"
					: readonly.error === "unauthorized"
						? "readonly_unauthorized"
						: readonly.error === "forbidden"
							? "readonly_forbidden"
							: "read_failed";
			accounts.push(
				reading({
					authHealth: "unknown",
					note,
					...carried(previous, accountKey),
				}),
			);
			continue;
		}
		if (!clearPendingRecovery(options, pool, slot, accountKey)) {
			accounts.push(
				reading({
					authHealth: "recovery_uncertain",
					note: "recovery_uncertain",
					...carried(previous, accountKey),
				}),
			);
			continue;
		}
		try {
			accounts.push(
				reading(
					await readSlot(options, pool, {
						slot,
						accountKey,
						email: identity.email,
						profile: identity.profile,
						nowIso,
						previous,
					}),
				),
			);
		} catch {
			accounts.push(
				reading({
					authHealth: "unknown",
					note: "read_failed",
					...carried(previous, accountKey),
				}),
			);
		}
	}
	return { version: 1, generatedAt: nowIso, activeAccount, accounts };
}
