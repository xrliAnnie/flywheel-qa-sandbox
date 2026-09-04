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

import type { CandidatePanoramaEntry } from "./account-candidate-selector.js";
import {
	type AccountStore,
	defaultStorePath,
	earliestReset,
	enqueueSwitchNotification,
	MAX_SWITCH_NOTIFICATION_OUTBOX,
	readStore,
	selectNextAccount,
	writeStore,
} from "./account-store.js";
import {
	drainSwitchNotification,
	formatSwitchNotification,
	type SwitchNotificationTrigger,
} from "./account-switch-notification.js";
import type { AccountsLock } from "./accounts-lock.js";
import type { ApplyChildEvidence } from "./apply-child-evidence.js";
import type { MachineAccountResolution } from "./machine-account.js";
import { type LeaseProof, validateLeaseProof } from "./mkdir-lock.js";
import { computeModelCapTtlMs } from "./model-cap.js";
import type { DeliveryReport } from "./quota-monitor-alert.js";
import { type CanonicalModels, canonicalizeModels } from "./quota-trigger.js";
import type { AccountUsageResult } from "./quota-usage-api.js";

type SuccessfulUsage = Extract<AccountUsageResult, { ok: unknown }>["ok"];

interface SwitchInputBase {
	/** The account observed as capped at detection (CAS key). */
	observedAccount: string;
	observedGeneration: number;
	now: Date;
	/** Quota-verified target ranking; when present, unlisted accounts are excluded. */
	preferredOrder?: string[];
	/** Start instant of the live verification round that produced preferredOrder. */
	verifiedAt?: string;
	/** Whether the bash apply may skip its independent live quota guard. */
	quotaPreverified?: boolean;
	/** Attempt-local cooldown exceptions minted by the live candidate selector. */
	cooldownFallbacks?: readonly string[];
	/** Pre-fetched, non-secret facts used to format the centralized notification. */
	notificationContext?: SwitchNotificationContext;
}

export interface SwitchNotificationContext {
	founderTimezone?: string;
	usageByName?: ReadonlyMap<string, SuccessfulUsage>;
	identityByName?: ReadonlyMap<string, { email?: string }>;
	panorama?: readonly CandidatePanoramaEntry[];
	headroomDegraded?: boolean;
	cooldownFallbackName?: string;
}

export type SwitchTrigger =
	| { kind: "manual"; mode: "use" | "next" }
	| {
			kind: "quota" | "repair";
			scope: "5h" | "weekly" | "both";
			resetAt: string;
	  }
	| { kind: "model"; models: CanonicalModels };

export interface ManualEligibilityOverride {
	ignoreCooldown: boolean;
}

export type ManualEligibilityOverrides = ReadonlyMap<
	string,
	ManualEligibilityOverride
>;

export type SwitchInput =
	| (SwitchInputBase & {
			trigger: SwitchTrigger;
			manualOverrides?: ManualEligibilityOverrides;
	  })
	| (SwitchInputBase & {
			scope: "5h" | "weekly" | "both";
			/** ISO reset instant of the hit account window. */
			resetAt: string;
	  })
	| (SwitchInputBase & {
			scope: "model";
			/** Canonicalized again under the account lock before use. */
			models: CanonicalModels;
	  });

function normalizedTrigger(input: SwitchInput): SwitchTrigger {
	if ("trigger" in input) return input.trigger;
	return input.scope === "model"
		? { kind: "model", models: input.models }
		: { kind: "quota", scope: input.scope, resetAt: input.resetAt };
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
		context: {
			lease: LeaseProof;
			signal: AbortSignal;
			manualMode?: "use" | "next";
		},
	) => Promise<ApplyProfileInvocation>;
	/** The account the real profile is currently active on (crash-recovery authority). */
	readActiveProfile: () => Promise<string | null>;
	/** Shared fail-closed authority. Production always supplies this. */
	resolveMachineAccount?: (store: AccountStore) => MachineAccountResolution;
	/** Parent-side final fence seam. Defaults to marker-token validation. */
	validateLease?: (lease: LeaseProof) => boolean;
	/** Renewal cadence while the detached mutation process group is alive. */
	heartbeatMs?: number;
	/** Send a committed notification intent after releasing the switch lock. */
	deliverNotification?: (
		alert: NonNullable<
			AccountStore["pendingSwitchNotifications"]
		>[number]["alert"],
	) => Promise<DeliveryReport>;
}

type ApplyProfileInvocation =
	// biome-ignore lint/suspicious/noConfusingVoidType: existing adapters return Promise<void>; identity-sync + reports are additive channels.
	| void
	| (ApplyProfileReport & {
			identitySynced: boolean;
			evidence?: ApplyChildEvidence;
	  });

export type IdentityCheckpoint = "pre_write" | "capture_back" | "capture";

export interface ApplyProfileIdentityCheck {
	label: string;
	checkpoint: IdentityCheckpoint;
	verdict:
		| "match"
		| "mismatch"
		| "unknown_missing"
		| "profile_network"
		| "profile_malformed"
		| "profile_unauthorized";
	expectedKey?: string;
	actualDigest?: string;
}

export interface ApplyProfileReport {
	identityChecks: ApplyProfileIdentityCheck[];
	freshened?: {
		name: string;
		identityProof: { email: string; uuid: string };
	};
}

type SwitchOutcome =
	| {
			outcome: "switched";
			from: string;
			to: string;
			generation: number;
			benchUntilByModel?: Record<string, string>;
			notification?: "delivered" | "pending";
	  }
	| { outcome: "noop_already_switched"; activeAccount: string }
	| { outcome: "noop_reconciled"; activeAccount: string; generation: number }
	| {
			outcome: "no_account";
			earliestReset: string | null;
			reasonCode:
				| "no_eligible_account"
				| "target_stale_exhausted"
				| "target_quota_exhausted"
				| "target_identity_mismatch"
				| "target_identity_unverifiable";
	  }
	| {
			outcome: "failed";
			reason: string;
			reasonCode:
				| "freshness_unavailable"
				| "apply_contract_mismatch"
				| "active_marker_drift"
				| "live_identity_unavailable"
				| "keychain_preimage_conflict"
				| "apply_failed"
				| "machine_account_conflict"
				| "notification_outbox_full"
				| "invalid_model_trigger"
				| "invalid_manual_overrides"
				| "invalid_cooldown_fallbacks"
				| "keychain_readback_mismatch"
				| "identity_rollback_failed"
				| "lock_lease_lost"
				| "transition_journal_conflict"
				| "transition_journal_writer_alive";
	  };

export type SwitchResult = SwitchOutcome & {
	/** Non-secret child facts; consumed only after the account lock is released. */
	applyReports?: ApplyProfileReport[];
	/** Whether the profile mutation child reached a running process. */
	applyProfileChildStarted?: boolean;
	/** Sanitized evidence from the last profile mutation child. */
	applyEvidence?: ApplyChildEvidence;
};

export class LockLeaseLostError extends Error {
	constructor(
		detail?: string,
		public readonly evidence?: ApplyChildEvidence,
	) {
		super(`account lock lease lost${detail ? `: ${detail}` : ""}`);
		this.name = "LockLeaseLostError";
	}
}

export class ApplyContractMismatchError extends Error {
	constructor(
		detail: string | undefined,
		public readonly evidence: ApplyChildEvidence,
	) {
		super(
			`profile child rejected the atomic-apply contract (daemon runtime predates the switch script)${
				detail ? `: ${detail}` : ""
			}`,
		);
		this.name = "ApplyContractMismatchError";
	}
}

/**
 * FLY-871 R1/C3 — the target's pooled credential failed freshness verification
 * (bash `use` exit 30): its OAuth refresh-token family is dead, so writing it to
 * the Keychain would strand live sessions (the 2026-07-04 incident). `switchAccount`
 * catches this, flags the account `authExpired`, and rotates to the next candidate.
 */
export class TargetStaleError extends Error {
	constructor(
		public readonly account: string,
		public readonly report?: ApplyProfileReport,
		public readonly evidence?: ApplyChildEvidence,
	) {
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
	constructor(
		detail?: string,
		public readonly report?: ApplyProfileReport,
		public readonly evidence?: ApplyChildEvidence,
	) {
		super(
			`token freshness helper unavailable — refusing to switch (fail-closed)${
				detail ? `: ${detail}` : ""
			}`,
		);
		this.name = "FreshnessUnavailableError";
	}
}

/**
 * FLY-1201 — `.active` cannot be proven to describe the live Keychain token,
 * or the safe reconciliation prefix could not be completed. This is machine
 * state/environmental, never evidence that the selected target account is bad.
 */
export class ActiveMarkerDriftError extends Error {
	constructor(
		detail?: string,
		public readonly evidence?: ApplyChildEvidence,
	) {
		super(
			`active Claude profile marker could not be safely reconciled${
				detail ? `: ${detail}` : ""
			}`,
		);
		this.name = "ActiveMarkerDriftError";
	}
}

export class TargetQuotaExhaustedError extends Error {
	constructor(
		public readonly account: string,
		public readonly report?: ApplyProfileReport,
		public readonly evidence?: ApplyChildEvidence,
	) {
		super(`target account '${account}' has exhausted Claude quota`);
		this.name = "TargetQuotaExhaustedError";
	}
}

export class LiveIdentityUnavailableError
	extends Error
	implements ApplyProfileReportedError
{
	constructor(
		detail?: string,
		public readonly report?: ApplyProfileReport,
		public readonly evidence?: ApplyChildEvidence,
	) {
		super(`live Claude identity is unavailable${detail ? `: ${detail}` : ""}`);
		this.name = "LiveIdentityUnavailableError";
	}
}

export class KeychainPreimageConflictError
	extends Error
	implements ApplyProfileReportedError
{
	constructor(
		detail?: string,
		public readonly report?: ApplyProfileReport,
		public readonly evidence?: ApplyChildEvidence,
	) {
		super(
			`live Keychain credential changed concurrently${detail ? `: ${detail}` : ""}`,
		);
		this.name = "KeychainPreimageConflictError";
	}
}

interface ApplyProfileReportedError {
	report?: ApplyProfileReport;
}

function freshenVerifiedAccount(
	store: AccountStore,
	fact: NonNullable<ApplyProfileReport["freshened"]>,
	expectedGeneration: number,
	expectedActiveAccount: string,
): AccountStore {
	if (
		store.generation !== expectedGeneration ||
		store.activeAccount !== expectedActiveAccount ||
		fact.name !== expectedActiveAccount ||
		store.accounts.filter((account) => account.name === fact.name).length !== 1
	) {
		return store;
	}
	return {
		...store,
		accounts: store.accounts.map((account) => {
			if (account.name !== fact.name) return account;
			const updated = { ...account };
			delete updated.authExpired;
			delete updated.refreshTokenInvalid;
			delete updated.profileVerifyFailed;
			if (
				account.identity?.email.toLowerCase() ===
					fact.identityProof.email.toLowerCase() &&
				(account.identity.uuid === undefined ||
					account.identity.uuid.toLowerCase() ===
						fact.identityProof.uuid.toLowerCase())
			) {
				delete updated.identityMismatch;
			}
			return updated;
		}),
	};
}

export class TargetIdentityMismatchError
	extends Error
	implements ApplyProfileReportedError
{
	constructor(
		public readonly account: string,
		public readonly actualDigest: string,
		public readonly report?: ApplyProfileReport,
		public readonly evidence?: ApplyChildEvidence,
	) {
		super(`target account '${account}' does not match its trusted identity`);
		this.name = "TargetIdentityMismatchError";
	}
}

export class TargetIdentityRolledBackError
	extends Error
	implements ApplyProfileReportedError
{
	constructor(
		public readonly account: string,
		public readonly report?: ApplyProfileReport,
		public readonly evidence?: ApplyChildEvidence,
	) {
		super(
			`target account '${account}' failed Keychain read-back; previous credential restored`,
		);
		this.name = "TargetIdentityRolledBackError";
	}
}

export class IdentityRollbackFailedError
	extends Error
	implements ApplyProfileReportedError
{
	constructor(
		public readonly account: string,
		public readonly report?: ApplyProfileReport,
		public readonly evidence?: ApplyChildEvidence,
	) {
		super(
			`target account '${account}' failed Keychain read-back and verified rollback`,
		);
		this.name = "IdentityRollbackFailedError";
	}
}

export class TargetIdentityUnverifiableError
	extends Error
	implements ApplyProfileReportedError
{
	constructor(
		public readonly account: string,
		public readonly report?: ApplyProfileReport,
		public readonly evidence?: ApplyChildEvidence,
	) {
		super(`target account '${account}' identity endpoint rejected its token`);
		this.name = "TargetIdentityUnverifiableError";
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

function markIdentityMismatch(
	store: AccountStore,
	name: string,
	actualDigest: string,
	markedAt: string,
): AccountStore {
	return {
		...store,
		accounts: store.accounts.map((account) =>
			account.name === name
				? {
						...account,
						identityMismatch: {
							actualDigest,
							markedBy: "executor" as const,
							markedAt,
						},
					}
				: account,
		),
	};
}

function appendReport(
	reports: ApplyProfileReport[],
	// biome-ignore lint/suspicious/noConfusingVoidType: preserve compatibility with existing void apply mocks.
	value: ApplyProfileReport | void | ApplyProfileReportedError | Error,
): void {
	const report =
		value && "identityChecks" in value
			? value
			: value && "report" in value
				? value.report
				: undefined;
	if (report && (report.identityChecks.length > 0 || report.freshened)) {
		reports.push(report);
	}
}

function withReports<T extends SwitchOutcome>(
	result: T,
	reports: ApplyProfileReport[],
	evidence?: ApplyChildEvidence,
	childStarted: boolean | null | undefined = evidence?.childStarted,
): SwitchResult {
	const reported: SwitchResult =
		reports.length > 0 ? { ...result, applyReports: [...reports] } : result;
	if (
		evidence === undefined ||
		(result.outcome !== "failed" && result.outcome !== "no_account")
	) {
		return reported;
	}
	return {
		...reported,
		applyEvidence: evidence,
		...(childStarted === null || childStarted === undefined
			? {}
			: { applyProfileChildStarted: childStarted }),
	};
}

function evidenceOf(value: unknown): ApplyChildEvidence | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const evidence = (value as { evidence?: unknown }).evidence;
	if (typeof evidence !== "object" || evidence === null) return undefined;
	const candidate = evidence as Record<string, unknown>;
	if (
		candidate.exitCode !== null &&
		(typeof candidate.exitCode !== "number" ||
			!Number.isInteger(candidate.exitCode))
	) {
		return undefined;
	}
	if (
		candidate.childStarted !== null &&
		typeof candidate.childStarted !== "boolean"
	) {
		return undefined;
	}
	if (typeof candidate.detail !== "string") return undefined;
	return {
		exitCode: candidate.exitCode as number | null,
		childStarted: candidate.childStarted as boolean | null,
		detail: candidate.detail,
	};
}

/** Default lockfile beside the state file. */
export function defaultLockPath(): string {
	return defaultStorePath().replace(/\.json$/, ".lock");
}

function commitSwitch(
	store: AccountStore,
	input: SwitchInput,
	trigger: SwitchTrigger,
	to: string,
	identitySynced: boolean,
	benchUntilByModel: Record<string, string> | null,
): AccountStore {
	const generation = store.generation + 1;
	const accounts = store.accounts.map((account) => {
		if (account.name !== input.observedAccount) return account;
		if (trigger.kind === "manual") return account;
		if (trigger.kind === "model") {
			if (benchUntilByModel === null) return account;
			const modelCaps = { ...account.modelCaps };
			for (const [model, until] of Object.entries(benchUntilByModel)) {
				modelCaps[model] = {
					until,
					backoffMs: Date.parse(until) - input.now.getTime(),
				};
			}
			return { ...account, modelCaps };
		}
		const isWeekly = trigger.scope === "weekly" || trigger.scope === "both";
		return {
			...account,
			quotaExhaustedUntil: trigger.resetAt,
			switchCooldownUntil: trigger.resetAt,
			...(isWeekly ? { weeklyResetAt: trigger.resetAt } : {}),
		};
	});
	const notificationTrigger: SwitchNotificationTrigger =
		trigger.kind === "model"
			? {
					kind: "model",
					models: Object.keys(benchUntilByModel ?? {}).sort(),
				}
			: trigger.kind === "manual"
				? trigger
				: { kind: trigger.kind, scope: trigger.scope };
	const context = input.notificationContext;
	const body = formatSwitchNotification({
		from: {
			name: input.observedAccount,
			email: context?.identityByName?.get(input.observedAccount)?.email ?? null,
			usage: context?.usageByName?.get(input.observedAccount),
		},
		to: {
			name: to,
			email: context?.identityByName?.get(to)?.email ?? null,
			usage: context?.usageByName?.get(to),
		},
		trigger: notificationTrigger,
		timezone: context?.founderTimezone ?? "America/Los_Angeles",
		panorama: context?.panorama ?? [],
		headroomDegraded: context?.headroomDegraded,
		cooldownFallbackName:
			context?.cooldownFallbackName !== undefined &&
			context.cooldownFallbackName === input.cooldownFallbacks?.[0]
				? context.cooldownFallbackName
				: undefined,
	});
	const switched: AccountStore = {
		...store,
		generation,
		activeAccount: to,
		identityStale: !identitySynced,
		accounts,
	};
	return enqueueSwitchNotification(switched, {
		eventId: `account-switch-g${generation}`,
		generation,
		createdAt: input.now.getTime(),
		alert: {
			kind: "account_switched",
			severity: "info",
			title: `Claude account switched: ${input.observedAccount} → ${to}`,
			body,
			signature: `account-switch-g${generation}`,
		},
	});
}

export async function switchAccount(
	input: SwitchInput,
	deps: SwitchDeps,
): Promise<SwitchResult> {
	const storePath = deps.storePath ?? defaultStorePath();
	const lockPath = deps.lockPath ?? defaultLockPath();
	const deliverNotification = deps.deliverNotification;
	const drainOneNotification = async () => {
		if (deliverNotification === undefined) return { outcome: "empty" as const };
		return drainSwitchNotification({
			withAccountsLock: async (fn) => {
				const result = await deps.withLock(lockPath, async () => fn());
				if (result.kind !== "ok") {
					throw new Error(`notification lock unavailable: ${result.kind}`);
				}
				return result.value;
			},
			readStore: async () => readStore(storePath),
			writeStore: async (store) => writeStore(store, storePath),
			send: deliverNotification,
		});
	};

	if (deliverNotification !== undefined) {
		try {
			await drainOneNotification();
		} catch {
			// Best effort before mutation; a still-full outbox fails closed below.
		}
	}

	const locked = await deps.withLock<SwitchResult>(lockPath, async (lease) => {
		const applyReports: ApplyProfileReport[] = [];
		let lastEvidence: ApplyChildEvidence | undefined;
		const validate = deps.validateLease ?? validateLeaseProof;
		const fence = (): boolean => {
			try {
				return deps.renewLock(lockPath) && validate(lease);
			} catch {
				return false;
			}
		};
		const leaseLost = (): SwitchResult =>
			withReports(
				{
					outcome: "failed",
					reason: `lost account lock lease: ${lockPath}`,
					reasonCode: "lock_lease_lost",
				},
				applyReports,
				lastEvidence,
			);
		const applyWithHeartbeat = async (
			name: string,
		): Promise<ApplyProfileInvocation> => {
			const controller = new AbortController();
			let lost = false;
			const timer = setInterval(() => {
				if (fence()) return;
				lost = true;
				controller.abort(new LockLeaseLostError(lockPath));
			}, deps.heartbeatMs ?? 1_000);
			try {
				const result = await deps.applyProfile(name, {
					lease,
					signal: controller.signal,
					...(trigger.kind === "manual"
						? {
								manualMode: trigger.mode,
							}
						: {}),
				});
				return result;
			} catch (error) {
				if (lost || error instanceof LockLeaseLostError) {
					const evidence = evidenceOf(error);
					if (error instanceof LockLeaseLostError && evidence) throw error;
					throw new LockLeaseLostError(lockPath, evidence);
				}
				throw error;
			} finally {
				clearInterval(timer);
			}
			if (lost) throw new LockLeaseLostError(lockPath);
		};
		let store = readStore(storePath);
		const trigger = normalizedTrigger(input);
		const models =
			trigger.kind === "model" ? canonicalizeModels(trigger.models) : null;
		if (trigger.kind === "model" && models === null) {
			return {
				outcome: "failed",
				reason: "model trigger must contain at least one non-empty model",
				reasonCode: "invalid_model_trigger",
			};
		}
		const manualOverrides =
			"manualOverrides" in input ? input.manualOverrides : undefined;
		const preferredNames = new Set(input.preferredOrder ?? []);
		if (
			(trigger.kind !== "manual" && manualOverrides !== undefined) ||
			(manualOverrides !== undefined &&
				[...manualOverrides.keys()].some((name) => !preferredNames.has(name)))
		) {
			return {
				outcome: "failed",
				reason:
					"manual eligibility overrides require a manual trigger and keys from preferredOrder",
				reasonCode: "invalid_manual_overrides",
			};
		}
		const cooldownFallbacks = input.cooldownFallbacks;
		if (
			cooldownFallbacks !== undefined &&
			(trigger.kind !== "quota" ||
				(trigger.scope !== "weekly" && trigger.scope !== "both") ||
				input.quotaPreverified !== true ||
				cooldownFallbacks.length !== 1 ||
				!preferredNames.has(cooldownFallbacks[0] ?? "") ||
				input.verifiedAt === undefined ||
				!Number.isFinite(Date.parse(input.verifiedAt)))
		) {
			return {
				outcome: "failed",
				reason:
					"cooldown fallbacks require one live-verified preferred target on a 7d-dominant quota trigger",
				reasonCode: "invalid_cooldown_fallbacks",
			};
		}
		const cooldownFallbackOverrides =
			cooldownFallbacks === undefined
				? undefined
				: new Map([[cooldownFallbacks[0] as string, { ignoreCooldown: true }]]);
		const outgoing = store.accounts.find(
			(account) => account.name === input.observedAccount,
		);
		const benchUntilByModel =
			trigger.kind === "model" && models !== null
				? Object.fromEntries(
						models.map((model) => {
							const ttl = computeModelCapTtlMs(
								outgoing?.modelCaps?.[model],
								input.now,
							);
							return [model, new Date(input.now.getTime() + ttl).toISOString()];
						}),
					)
				: null;

		const authority = deps.resolveMachineAccount?.(store);
		if (authority && authority.kind !== "resolved") {
			return {
				outcome: "failed",
				reason: `machine account authority is ${authority.kind}; refusing to switch`,
				reasonCode: "machine_account_conflict",
			};
		}

		// Crash recovery: the shared authority wins; legacy callers retain the
		// pre-FLY-1182 profile marker fallback.
		const realActive =
			authority?.kind === "resolved"
				? authority.name
				: await deps.readActiveProfile();
		if (realActive !== null && realActive !== store.activeAccount) {
			store = { ...store, activeAccount: realActive };
		}

		// CAS: only switch if the active account is still the one observed as capped.
		if (
			store.activeAccount !== null &&
			store.activeAccount !== input.observedAccount
		) {
			return withReports(
				{
					outcome: "noop_already_switched",
					activeAccount: store.activeAccount,
				},
				applyReports,
			);
		}
		// CAS part 2 (Codex code R1 MED-3): the GENERATION must also match. The
		// name alone is not enough — after A→B→…→A the active NAME equals the
		// stale pending's observedAccount again, but its generation has bumped;
		// acting on that stale observation would rotate away from a healthy A.
		// (Crash recovery above is unaffected: an uncommitted switch never bumped
		// the stored generation, and its name-mismatch already no-ops.)
		if (store.generation !== input.observedGeneration) {
			return withReports(
				{
					outcome: "noop_already_switched",
					activeAccount: store.activeAccount ?? input.observedAccount,
				},
				applyReports,
			);
		}
		const nextNotificationEventId = `account-switch-g${store.generation + 1}`;
		const pendingNotifications = store.pendingSwitchNotifications ?? [];
		if (
			pendingNotifications.length >= MAX_SWITCH_NOTIFICATION_OUTBOX &&
			!pendingNotifications.some(
				(intent) => intent.eventId === nextNotificationEventId,
			)
		) {
			return withReports(
				{
					outcome: "failed",
					reason: `notification outbox is full (${pendingNotifications.length}/${MAX_SWITCH_NOTIFICATION_OUTBOX}); refusing profile mutation`,
					reasonCode: "notification_outbox_full",
				},
				applyReports,
			);
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
		const consumeReport = (
			// biome-ignore lint/suspicious/noConfusingVoidType: preserve compatibility with void apply mocks.
			value: ApplyProfileReport | void | ApplyProfileReportedError | Error,
			suppressFreshened = false,
		): void => {
			const report =
				value && "identityChecks" in value
					? value
					: value && "report" in value
						? value.report
						: undefined;
			if (!report) return;
			appendReport(
				applyReports,
				suppressFreshened ? { identityChecks: report.identityChecks } : report,
			);
			if (suppressFreshened || !report.freshened) return;
			const latest = readStore(storePath);
			const updated = freshenVerifiedAccount(
				latest,
				report.freshened,
				input.observedGeneration,
				input.observedAccount,
			);
			if (JSON.stringify(updated) !== JSON.stringify(latest)) {
				if (!fence()) throw new LockLeaseLostError(lockPath);
				writeStore(updated, storePath);
			}
			working = updated;
		};
		let applied: string | null = null;
		let identitySynced = true;
		let targetStaleSeen = false;
		let targetQuotaSeen = false;
		let targetIdentityMismatchSeen = false;
		let targetIdentityUnverifiableSeen = false;
		let keychainReadbackSeen = false;
		const attemptedNames = new Set<string>();
		const maxAttempts = store.accounts.length + 1;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (!fence()) return leaseLost();
			const next = selectNextAccount(working, {
				scope:
					trigger.kind === "model"
						? "model"
						: trigger.kind === "manual"
							? null
							: trigger.scope,
				models: models ?? undefined,
				currentName: input.observedAccount,
				now: input.now,
				preferredOrder: input.preferredOrder,
				verifiedAt: input.verifiedAt,
				excludeNames: attemptedNames,
				eligibilityOverrides: manualOverrides ?? cooldownFallbackOverrides,
			});
			if (next === null) {
				if (keychainReadbackSeen) {
					return withReports(
						{
							outcome: "failed",
							reason:
								"all attempted Keychain writes failed byte read-back and were rolled back",
							reasonCode: "keychain_readback_mismatch",
						},
						applyReports,
						lastEvidence,
					);
				}
				return withReports(
					{
						outcome: "no_account",
						earliestReset: earliestReset(working, input.now.getTime()),
						reasonCode: targetIdentityMismatchSeen
							? "target_identity_mismatch"
							: targetIdentityUnverifiableSeen
								? "target_identity_unverifiable"
								: targetQuotaSeen
									? "target_quota_exhausted"
									: targetStaleSeen
										? "target_stale_exhausted"
										: "no_eligible_account",
					},
					applyReports,
					lastEvidence,
				);
			}
			attemptedNames.add(next);
			try {
				const applyResult = await applyWithHeartbeat(next);
				const applyEvidence = evidenceOf(applyResult);
				if (applyEvidence) lastEvidence = applyEvidence;
				identitySynced = applyResult?.identitySynced ?? true;
				consumeReport(applyResult);
				// The child may settle in the gap before the next heartbeat. Re-proof
				// after the entire process group has exited and before any parent write.
				if (!fence()) return leaseLost();
				applied = next;
				break;
			} catch (err) {
				const applyEvidence = evidenceOf(err);
				if (applyEvidence) lastEvidence = applyEvidence;
				if (err instanceof LockLeaseLostError || !fence()) return leaseLost();
				if (err instanceof KeychainPreimageConflictError) {
					consumeReport(err, true);
					return withReports(
						{
							outcome: "failed",
							reason: err.message,
							reasonCode: "keychain_preimage_conflict",
						},
						applyReports,
						lastEvidence,
					);
				}
				if (err instanceof Error) consumeReport(err);
				if (err instanceof LiveIdentityUnavailableError) {
					return withReports(
						{
							outcome: "failed",
							reason: err.message,
							reasonCode: "live_identity_unavailable",
						},
						applyReports,
						lastEvidence,
					);
				}
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
				if (err instanceof TargetIdentityMismatchError) {
					targetIdentityMismatchSeen = true;
					working = markIdentityMismatch(
						working,
						next,
						err.actualDigest,
						input.now.toISOString(),
					);
					if (!fence()) return leaseLost();
					writeStore(working, storePath);
					continue;
				}
				if (err instanceof TargetIdentityRolledBackError) {
					keychainReadbackSeen = true;
					continue;
				}
				if (err instanceof TargetIdentityUnverifiableError) {
					targetIdentityUnverifiableSeen = true;
					continue;
				}
				if (err instanceof IdentityRollbackFailedError) {
					return withReports(
						{
							outcome: "failed",
							reason: err.message,
							reasonCode: "identity_rollback_failed",
						},
						applyReports,
						lastEvidence,
					);
				}
				if (err instanceof FreshnessUnavailableError) {
					return withReports(
						{
							outcome: "failed",
							reason: err.message,
							reasonCode: "freshness_unavailable",
						},
						applyReports,
						lastEvidence,
					);
				}
				if (err instanceof ActiveMarkerDriftError) {
					return withReports(
						{
							outcome: "failed",
							reason: err.message,
							reasonCode: "active_marker_drift",
						},
						applyReports,
						lastEvidence,
					);
				}
				if (err instanceof ApplyContractMismatchError) {
					return withReports(
						{
							outcome: "failed",
							reason: err.message,
							reasonCode: "apply_contract_mismatch",
						},
						applyReports,
						lastEvidence,
					);
				}
				return withReports(
					{
						outcome: "failed",
						reason: err instanceof Error ? err.message : String(err),
						reasonCode: "apply_failed",
					},
					applyReports,
					lastEvidence,
					applyEvidence?.childStarted ?? null,
				);
			}
		}
		if (applied === null) {
			if (keychainReadbackSeen) {
				return withReports(
					{
						outcome: "failed",
						reason:
							"all attempted Keychain writes failed byte read-back and were rolled back",
						reasonCode: "keychain_readback_mismatch",
					},
					applyReports,
					lastEvidence,
				);
			}
			return withReports(
				{
					outcome: "no_account",
					earliestReset: earliestReset(working, input.now.getTime()),
					reasonCode: targetIdentityMismatchSeen
						? "target_identity_mismatch"
						: targetIdentityUnverifiableSeen
							? "target_identity_unverifiable"
							: targetQuotaSeen
								? "target_quota_exhausted"
								: targetStaleSeen
									? "target_stale_exhausted"
									: "no_eligible_account",
				},
				applyReports,
				lastEvidence,
			);
		}

		const updated = commitSwitch(
			working,
			input,
			trigger,
			applied,
			identitySynced,
			benchUntilByModel,
		);
		writeStore(updated, storePath);
		return withReports(
			{
				outcome: "switched",
				from: input.observedAccount,
				to: applied,
				generation: updated.generation,
				...(benchUntilByModel === null ? {} : { benchUntilByModel }),
			},
			applyReports,
		);
	});

	if (typeof locked !== "object" || locked === null || !("kind" in locked)) {
		throw new Error(
			"invalid account lock result: expected tagged LockRunResult",
		);
	}
	switch (locked.kind) {
		case "ok": {
			if (
				locked.value.outcome !== "switched" ||
				deps.deliverNotification === undefined
			) {
				return locked.value;
			}
			try {
				const delivery = await drainOneNotification();
				return {
					...locked.value,
					notification:
						delivery.outcome === "acknowledged" ? "delivered" : "pending",
				};
			} catch {
				return { ...locked.value, notification: "pending" };
			}
		}
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
