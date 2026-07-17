import {
	type AccountQuotaObservation,
	type AccountStore,
	isAuthUnusable,
	isQuotaUsable,
	isSwitchCooldownActive,
	type RecordObservationResult,
	type SyncActiveAccountResult,
} from "./account-store.js";
import type { FreshnessVerdict } from "./freshness.js";
import type { DeliveryReport } from "./quota-monitor-alert.js";
import type { LoadedQuotaMonitorConfig } from "./quota-monitor-config.js";
import type {
	PendingSwitchFailure,
	QuotaMonitorState,
} from "./quota-monitor-state.js";
import type {
	AccountUsageResult,
	ValidatedUsagePayload,
} from "./quota-usage-api.js";
import type { SwitchInput, SwitchResult } from "./switch-executor.js";

const REVIVE_GRACE_MS = 30 * 60_000;
const MONITOR_DOWN_STREAK = 6;

export interface MonitorCredential {
	accessToken: string;
	expiresAt: number;
}

export interface AccountSnapshot {
	activeName: string | null;
	store: AccountStore;
	activeCredential: MonitorCredential | null;
	poolAccounts: string[];
}

export interface AccountIdentity {
	activeName: string | null;
	storeGeneration: number;
}

export type QuotaMonitorAlertKind =
	| "account_switched"
	| "account_switch_degraded"
	| "quota_no_target"
	| "quota_blocked_recovered"
	| "quota_read_blind"
	| "account_switch_failed"
	| "quota_revive_stuck"
	| "quota_monitor_down";

export interface QuotaMonitorAlert {
	kind: QuotaMonitorAlertKind;
	severity: "info" | "warning" | "severe";
	title: string;
	body: string;
	signature: string;
}

export interface ReviveScanSummary {
	revived: number;
	pending: number;
	loginExpired: number;
}

export interface ReconcileActiveResult {
	result:
		| SyncActiveAccountResult
		| "transition_journal_conflict"
		| "transition_journal_writer_alive";
	/** Authoritative only for a successful strict-store reconciliation/noop. */
	generation: number | null;
}

export interface QuotaMonitorDeps {
	now: () => number;
	config: LoadedQuotaMonitorConfig;
	state: QuotaMonitorState;
	/** Acquires the account lock internally and reconciles marker -> store. */
	reconcileActive: () => Promise<ReconcileActiveResult>;
	withAccountsLock: <T>(fn: () => Promise<T>) => Promise<T>;
	/** Called only while withAccountsLock is held. */
	readSnapshot: () => Promise<AccountSnapshot>;
	/** Called only while withAccountsLock is held. */
	readIdentity: () => Promise<AccountIdentity>;
	/** Called only while withAccountsLock is held. */
	readPoolCredential: (name: string) => Promise<MonitorCredential | null>;
	/** Bounded refresh of a non-active candidate; deliberately runs under the account lock. */
	verifyCandidate: (
		name: string,
		activeName: string | null,
	) => Promise<FreshnessVerdict>;
	fetchUsage: (accessToken: string) => Promise<AccountUsageResult>;
	recordObservation: (
		name: string,
		observation: AccountQuotaObservation,
		expectedGeneration: number,
	) => Promise<RecordObservationResult>;
	/** Cache and state are committed under the same revalidation lock. */
	writeStatuslineCache: (raw: ValidatedUsagePayload) => Promise<void>;
	persistState: (state: QuotaMonitorState) => Promise<void>;
	switchAccount: (input: SwitchInput) => Promise<SwitchResult>;
	reviveScan?: (state: QuotaMonitorState) => Promise<{
		state: QuotaMonitorState;
		summary: ReviveScanSummary;
	}>;
	alert: (alert: QuotaMonitorAlert) => Promise<DeliveryReport>;
	log: (message: string) => void;
}

export type PollOutcome =
	| "observed"
	| "stale_snapshot"
	| "blind"
	| "backoff"
	| "error"
	| "cooldown"
	| "no_target"
	| "switched"
	| "switch_failed"
	| "noop_already_switched";

export interface PollOnceResult {
	outcome: PollOutcome;
	state: QuotaMonitorState;
	nextPollMs: number;
}

type SuccessfulUsage = Extract<AccountUsageResult, { ok: unknown }>["ok"];

function toObservation(
	usage: SuccessfulUsage,
	observedAtMs: number,
): AccountQuotaObservation {
	return {
		fiveHPct: usage.fiveH.pct,
		sevenDPct: usage.sevenD.pct,
		fiveHResetAt: usage.fiveH.resetsAt,
		sevenDResetAt: usage.sevenD.resetsAt,
		observedAt: new Date(observedAtMs).toISOString(),
	};
}

async function projectObservation(
	deps: QuotaMonitorDeps,
	name: string,
	usage: SuccessfulUsage,
	expectedGeneration: number,
): Promise<RecordObservationResult> {
	const projection = await deps.recordObservation(
		name,
		toObservation(usage, deps.now()),
		expectedGeneration,
	);
	if (projection !== "updated") {
		deps.log(
			`quota observation projection account=${name} result=${projection}`,
		);
	}
	return projection;
}

function day(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 10);
}

function pollIntervalMs(
	state: QuotaMonitorState,
	config: LoadedQuotaMonitorConfig["config"],
): number {
	return (
		(state.tier === "accelerated"
			? config.acceleratedPollMinutes
			: config.basePollMinutes) * 60_000
	);
}

function result(
	outcome: PollOutcome,
	state: QuotaMonitorState,
	config: LoadedQuotaMonitorConfig["config"],
): PollOnceResult {
	return { outcome, state, nextPollMs: pollIntervalMs(state, config) };
}

function triggerScope(
	usage: SuccessfulUsage,
	trigger5hPct: number,
): "5h" | "weekly" | "both" | null {
	const five = usage.fiveH.pct >= trigger5hPct;
	const weekly = usage.sevenD.pct >= 100;
	if (five && weekly) return "both";
	if (five) return "5h";
	if (weekly) return "weekly";
	return null;
}

function operativeResetAt(
	usage: SuccessfulUsage,
	scope: "5h" | "weekly" | "both",
): string {
	return scope === "5h" ? usage.fiveH.resetsAt : usage.sevenD.resetsAt;
}

async function emitBlind(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	activeName: string | null,
	reason: string,
): Promise<void> {
	await deps.alert({
		kind: "quota_read_blind",
		severity: "warning",
		title: "Claude quota monitor cannot read active usage",
		body: `account=${activeName ?? "unknown"}; reason=${reason}; active credential was not refreshed`,
		signature: `quota-read-blind-${activeName ?? "unknown"}-${day(deps.now())}`,
	});
	await deps.persistState(state);
}

async function commitSuccessfulObservation(
	deps: QuotaMonitorDeps,
	snapshot: AccountSnapshot,
	usage: SuccessfulUsage,
	state: QuotaMonitorState,
): Promise<boolean> {
	return deps.withAccountsLock(async () => {
		const current = await deps.readIdentity();
		if (
			current.activeName !== snapshot.activeName ||
			current.storeGeneration !== snapshot.store.generation
		) {
			return false;
		}
		state.lastSuccessfulUsageAt = deps.now();
		state.errorStreak = 0;
		state.backoffUntilMs = 0;
		state.observedGeneration = current.storeGeneration;
		if (deps.config.config.writeStatuslineCache) {
			await deps.writeStatuslineCache(usage.raw);
		}
		await deps.persistState(state);
		return true;
	});
}

async function readCandidateCredential(
	deps: QuotaMonitorDeps,
	name: string,
	refresh: boolean,
): Promise<{ credential: MonitorCredential | null; reason?: string }> {
	return deps.withAccountsLock(async () => {
		const identity = await deps.readIdentity();
		if (identity.activeName === name) {
			return { credential: null, reason: "became_active" };
		}
		if (refresh) {
			const verdict = await deps.verifyCandidate(name, identity.activeName);
			if (verdict.fresh === "stale") {
				return { credential: null, reason: "freshness_stale" };
			}
		}
		const credential = await deps.readPoolCredential(name);
		return credential === null
			? { credential: null, reason: "credential_missing" }
			: { credential };
	});
}

async function sweepCandidates(
	deps: QuotaMonitorDeps,
	snapshot: AccountSnapshot,
	state: QuotaMonitorState,
): Promise<void> {
	const now = deps.now();
	for (const name of deps.config.config.order) {
		if (name === snapshot.activeName) continue;
		const entry = snapshot.store.accounts.find(
			(account) => account.name === name,
		);
		if (!entry || !snapshot.poolAccounts.includes(name)) continue;
		if (isAuthUnusable(entry) || !isQuotaUsable(entry, now)) continue;
		const { credential } = await readCandidateCredential(deps, name, false);
		if (credential === null || credential.expiresAt <= now) continue;
		const candidateUsage = await deps.fetchUsage(credential.accessToken);
		if ("ok" in candidateUsage) {
			await projectObservation(
				deps,
				name,
				candidateUsage.ok,
				snapshot.store.generation,
			);
		}
	}
	state.lastCandidateSweepAt = now;
	await deps.persistState(state);
}

type UsageError = Extract<AccountUsageResult, { error: unknown }>["error"];
type PanoramaStatus =
	| "qualified"
	| "qualified_low_headroom"
	| "quota_exhausted"
	| "freshness_stale"
	| "credential_missing"
	| "credential_unavailable"
	| "became_active"
	| "not_in_pool"
	| "not_in_store"
	| "auth_unusable"
	| "switch_cooldown"
	| `usage_${UsageError}`;
type PanoramaClass = "usable" | "exhausted" | "unverifiable" | "ineligible";

const PANORAMA_CLASS = {
	qualified: "usable",
	qualified_low_headroom: "usable",
	quota_exhausted: "exhausted",
	freshness_stale: "unverifiable",
	became_active: "unverifiable",
	usage_unauthorized: "unverifiable",
	usage_rate_limited: "unverifiable",
	usage_network: "unverifiable",
	usage_malformed: "unverifiable",
	credential_missing: "ineligible",
	credential_unavailable: "ineligible",
	not_in_pool: "ineligible",
	not_in_store: "ineligible",
	auth_unusable: "ineligible",
	switch_cooldown: "ineligible",
} satisfies Record<PanoramaStatus, PanoramaClass>;

type PanoramaEntry = {
	name: string;
	status: PanoramaStatus;
	usage?: SuccessfulUsage;
};

async function verifyAndRankCandidates(
	deps: QuotaMonitorDeps,
	snapshot: AccountSnapshot,
): Promise<{
	ranked: string[];
	panorama: PanoramaEntry[];
	usageByName: Map<string, SuccessfulUsage>;
	verifiedAt: string;
}> {
	const now = deps.now();
	const verifiedAt = new Date(now).toISOString();
	const panorama: PanoramaEntry[] = [];
	const tier0: Array<{
		name: string;
		resetMs: number;
		orderIndex: number;
	}> = [];
	const tier1: Array<{
		name: string;
		fiveHPct: number;
		resetMs: number;
		orderIndex: number;
	}> = [];
	const usageByName = new Map<string, SuccessfulUsage>();

	for (const [orderIndex, name] of deps.config.config.order.entries()) {
		if (name === snapshot.activeName) continue;
		if (!snapshot.poolAccounts.includes(name)) {
			panorama.push({ name, status: "not_in_pool" });
			continue;
		}
		const entry = snapshot.store.accounts.find(
			(account) => account.name === name,
		);
		if (!entry) {
			panorama.push({ name, status: "not_in_store" });
			continue;
		}
		if (isAuthUnusable(entry)) {
			panorama.push({ name, status: "auth_unusable" });
			continue;
		}
		if (isSwitchCooldownActive(entry, now)) {
			panorama.push({ name, status: "switch_cooldown" });
			continue;
		}
		const checked = await readCandidateCredential(deps, name, true);
		if (checked.credential === null) {
			panorama.push({
				name,
				status:
					(checked.reason as
						| "freshness_stale"
						| "credential_missing"
						| "became_active"
						| undefined) ?? "credential_unavailable",
			});
			continue;
		}
		const candidateUsage = await deps.fetchUsage(
			checked.credential.accessToken,
		);
		if (!("ok" in candidateUsage)) {
			panorama.push({ name, status: `usage_${candidateUsage.error}` });
			continue;
		}
		await projectObservation(
			deps,
			name,
			candidateUsage.ok,
			snapshot.store.generation,
		);
		usageByName.set(name, candidateUsage.ok);
		if (
			candidateUsage.ok.fiveH.pct >= 100 ||
			candidateUsage.ok.sevenD.pct >= 100
		) {
			panorama.push({
				name,
				status: "quota_exhausted",
				usage: candidateUsage.ok,
			});
			continue;
		}
		const resetMs = Date.parse(candidateUsage.ok.sevenD.resetsAt);
		if (candidateUsage.ok.fiveH.pct < deps.config.config.trigger5hPct) {
			panorama.push({ name, status: "qualified", usage: candidateUsage.ok });
			tier0.push({ name, resetMs, orderIndex });
		} else {
			panorama.push({
				name,
				status: "qualified_low_headroom",
				usage: candidateUsage.ok,
			});
			tier1.push({
				name,
				fiveHPct: candidateUsage.ok.fiveH.pct,
				resetMs,
				orderIndex,
			});
		}
	}

	tier0.sort((a, b) => a.resetMs - b.resetMs || a.orderIndex - b.orderIndex);
	tier1.sort(
		(a, b) =>
			a.fiveHPct - b.fiveHPct ||
			a.resetMs - b.resetMs ||
			a.orderIndex - b.orderIndex,
	);
	return {
		ranked: [...tier0, ...tier1].map((entry) => entry.name),
		panorama,
		usageByName,
		verifiedAt,
	};
}

function degradedOrder(
	deps: QuotaMonitorDeps,
	snapshot: AccountSnapshot,
	panorama: PanoramaEntry[],
): string[] {
	const orderIndex = new Map(
		deps.config.config.order.map((name, index) => [name, index]),
	);
	return panorama
		.filter((entry) => PANORAMA_CLASS[entry.status] === "unverifiable")
		.map((entry) =>
			snapshot.store.accounts.find((account) => account.name === entry.name),
		)
		.filter(
			(entry): entry is NonNullable<typeof entry> =>
				entry !== undefined &&
				!isAuthUnusable(entry) &&
				isQuotaUsable(entry, deps.now()),
		)
		.sort((a, b) => {
			const aReset = a.weeklyResetAt
				? Date.parse(a.weeklyResetAt)
				: Number.POSITIVE_INFINITY;
			const bReset = b.weeklyResetAt
				? Date.parse(b.weeklyResetAt)
				: Number.POSITIVE_INFINITY;
			return (
				aReset - bReset ||
				(orderIndex.get(a.name) ?? Number.POSITIVE_INFINITY) -
					(orderIndex.get(b.name) ?? Number.POSITIVE_INFINITY)
			);
		})
		.map((entry) => entry.name);
}

function panoramaBody(panorama: PanoramaEntry[]): string {
	return panorama.length === 0
		? "no configured candidates"
		: panorama.map((entry) => `${entry.name}: ${entry.status}`).join("\n");
}

function deliveryConfirmed(report: DeliveryReport): boolean {
	return report.primary === "sent" || report.primary === "queued_transient";
}

function deliveryDue(
	attempts: number,
	lastAttemptAt: string | null,
	now: number,
	realertMinutes: number,
): boolean {
	if (attempts <= 5) return true;
	if (lastAttemptAt === null) return true;
	const lastAttemptMs = Date.parse(lastAttemptAt);
	return (
		Number.isNaN(lastAttemptMs) ||
		now - lastAttemptMs >= realertMinutes * 60_000
	);
}

async function safeAlert(
	deps: QuotaMonitorDeps,
	alert: QuotaMonitorAlert,
): Promise<DeliveryReport> {
	try {
		return await deps.alert(alert);
	} catch {
		return { primary: "process_error" };
	}
}

async function attemptBlockedDelivery(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	attemptedKinds: Set<QuotaMonitorAlertKind>,
	bodyOverride?: string,
): Promise<void> {
	const episode = state.blockedEpisode;
	if (episode === null || episode.activeDelivery === null) return;
	const delivery = episode.activeDelivery;
	const kind: QuotaMonitorAlertKind =
		delivery.kind === "blocked" ? "quota_no_target" : "quota_blocked_recovered";
	if (
		attemptedKinds.has(kind) ||
		!deliveryDue(
			delivery.attempts,
			delivery.lastAttemptAt,
			deps.now(),
			deps.config.config.episodeRealertMinutes,
		)
	) {
		return;
	}
	attemptedKinds.add(kind);
	delivery.lastAttemptAt = new Date(deps.now()).toISOString();
	await deps.persistState(state);
	const report = await safeAlert(
		deps,
		delivery.kind === "blocked"
			? {
					kind,
					severity: "severe",
					title: "No verified Claude account has quota",
					body:
						bodyOverride ??
						`scope=${episode.scope}; blocked_since=${episode.startedAt}`,
					signature: `quota-no-target-${episode.scope}-${episode.startedAt}-r${delivery.round}-a${delivery.attempts}`,
				}
			: {
					kind,
					severity: "info",
					title: "Claude quota blockage recovered",
					body:
						bodyOverride ??
						`scope=${episode.scope}; blocked_since=${episode.startedAt}`,
					signature: `quota-blocked-recovered-${episode.startedAt}-r${delivery.round}-a${delivery.attempts}`,
				},
	);
	if (deliveryConfirmed(report)) {
		if (delivery.kind === "recovered") {
			state.blockedEpisode = null;
		} else {
			episode.lastConfirmedAlertAt = new Date(deps.now()).toISOString();
			episode.alertCount += 1;
			episode.activeDelivery = null;
		}
	} else {
		delivery.attempts += 1;
	}
	await deps.persistState(state);
}

async function openBlockedEpisode(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	scope: "5h" | "weekly" | "both",
	attemptedKinds: Set<QuotaMonitorAlertKind>,
	body: string,
): Promise<void> {
	const now = deps.now();
	const nowIso = new Date(now).toISOString();
	let episode = state.blockedEpisode;
	if (episode === null || episode.scope !== scope) {
		episode = {
			scope,
			startedAt: nowIso,
			lastConfirmedAlertAt: null,
			alertCount: 0,
			blockedRound: 1,
			recoveryRound: 0,
			activeDelivery: {
				kind: "blocked",
				round: 1,
				attempts: 0,
				lastAttemptAt: null,
			},
		};
		state.blockedEpisode = episode;
	} else if (episode.activeDelivery?.kind === "recovered") {
		episode.blockedRound += 1;
		episode.activeDelivery = {
			kind: "blocked",
			round: episode.blockedRound,
			attempts: 0,
			lastAttemptAt: null,
		};
	} else if (episode.activeDelivery !== null) {
		return;
	} else {
		if (episode.alertCount >= 10) return;
		const confirmedAt =
			episode.lastConfirmedAlertAt === null
				? Number.NEGATIVE_INFINITY
				: Date.parse(episode.lastConfirmedAlertAt);
		if (
			!Number.isNaN(confirmedAt) &&
			now - confirmedAt < deps.config.config.episodeRealertMinutes * 60_000
		) {
			return;
		}
		episode.blockedRound += 1;
		episode.activeDelivery = {
			kind: "blocked",
			round: episode.blockedRound,
			attempts: 0,
			lastAttemptAt: null,
		};
	}
	await deps.persistState(state);
	await attemptBlockedDelivery(deps, state, attemptedKinds, body);
}

async function openBlockedRecovery(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	attemptedKinds: Set<QuotaMonitorAlertKind>,
	body: string,
): Promise<void> {
	const episode = state.blockedEpisode;
	if (episode === null || episode.activeDelivery?.kind === "recovered") return;
	episode.recoveryRound += 1;
	episode.activeDelivery = {
		kind: "recovered",
		round: episode.recoveryRound,
		attempts: 0,
		lastAttemptAt: null,
	};
	await deps.persistState(state);
	await attemptBlockedDelivery(deps, state, attemptedKinds, body);
}

async function attemptSwitchFailureDelivery(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	attemptedKinds: Set<QuotaMonitorAlertKind>,
): Promise<void> {
	const episode = state.pendingSwitchFailure;
	const kind: QuotaMonitorAlertKind = "account_switch_failed";
	if (
		episode === null ||
		episode.activeDelivery === null ||
		attemptedKinds.has(kind) ||
		!deliveryDue(
			episode.activeDelivery.attempts,
			episode.activeDelivery.lastAttemptAt,
			deps.now(),
			deps.config.config.episodeRealertMinutes,
		)
	) {
		return;
	}
	const delivery = episode.activeDelivery;
	attemptedKinds.add(kind);
	delivery.lastAttemptAt = new Date(deps.now()).toISOString();
	await deps.persistState(state);
	const report = await safeAlert(deps, {
		kind,
		severity: "severe",
		title: "Claude account switch failed",
		body: `reason=${episode.reasonCode}; degraded=${episode.degraded}`,
		signature: `account-switch-failed-${episode.reasonCode}-${episode.degraded}-${episode.startedAt}-r${delivery.round}-a${delivery.attempts}`,
	});
	if (deliveryConfirmed(report)) {
		episode.lastConfirmedAlertAt = new Date(deps.now()).toISOString();
		episode.alertCount += 1;
		episode.activeDelivery = null;
	} else {
		delivery.attempts += 1;
	}
	await deps.persistState(state);
}

async function openSwitchFailureEpisode(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	reasonCode: string,
	degraded: boolean,
	attemptedKinds: Set<QuotaMonitorAlertKind>,
): Promise<void> {
	const now = deps.now();
	const current = state.pendingSwitchFailure;
	let episode: PendingSwitchFailure;
	if (
		current === null ||
		current.reasonCode !== reasonCode ||
		current.degraded !== degraded
	) {
		episode = {
			reasonCode,
			degraded,
			startedAt: new Date(now).toISOString(),
			lastConfirmedAlertAt: null,
			alertCount: 0,
			activeDelivery: {
				round: 0,
				attempts: 0,
				lastAttemptAt: null,
			},
		};
		state.pendingSwitchFailure = episode;
	} else if (current.activeDelivery !== null) {
		return;
	} else {
		episode = current;
		if (episode.alertCount >= 10) return;
		const confirmedAt =
			episode.lastConfirmedAlertAt === null
				? Number.NEGATIVE_INFINITY
				: Date.parse(episode.lastConfirmedAlertAt);
		if (
			!Number.isNaN(confirmedAt) &&
			now - confirmedAt < deps.config.config.episodeRealertMinutes * 60_000
		) {
			return;
		}
		episode.activeDelivery = {
			round: episode.alertCount,
			attempts: 0,
			lastAttemptAt: null,
		};
	}
	await deps.persistState(state);
	await attemptSwitchFailureDelivery(deps, state, attemptedKinds);
}

async function refreshNewActive(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	expectedName: string,
): Promise<void> {
	const snapshot = await deps.withAccountsLock(() => deps.readSnapshot());
	if (
		snapshot.activeName !== expectedName ||
		snapshot.activeCredential === null ||
		snapshot.activeCredential.expiresAt <= deps.now()
	) {
		return;
	}
	const observed = await deps.fetchUsage(snapshot.activeCredential.accessToken);
	if (!("ok" in observed)) return;
	state.tier =
		observed.ok.fiveH.pct > deps.config.config.acceleratePct
			? "accelerated"
			: "base";
	const committed = await commitSuccessfulObservation(
		deps,
		snapshot,
		observed.ok,
		state,
	);
	if (committed && snapshot.activeName !== null) {
		await projectObservation(
			deps,
			snapshot.activeName,
			observed.ok,
			snapshot.store.generation,
		);
	}
}

async function runOpenReviveEpoch(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
): Promise<{ state: QuotaMonitorState; summary: ReviveScanSummary }> {
	if (state.reviveEpoch === null) {
		return { state, summary: { revived: 0, pending: 0, loginExpired: 0 } };
	}
	if (state.reviveEpoch.expiresAt <= deps.now()) {
		state.reviveEpoch = null;
		await deps.persistState(state);
		return { state, summary: { revived: 0, pending: 0, loginExpired: 0 } };
	}
	if (!deps.reviveScan) {
		return { state, summary: { revived: 0, pending: 0, loginExpired: 0 } };
	}
	const scanned = await deps.reviveScan(state);
	await deps.persistState(scanned.state);
	return scanned;
}

export async function pollOnce(
	inputDeps: QuotaMonitorDeps,
): Promise<PollOnceResult> {
	const delivery: Array<DeliveryReport & { kind: QuotaMonitorAlertKind }> = [];
	const deps: QuotaMonitorDeps = {
		...inputDeps,
		alert: async (alert) => {
			const report = await inputDeps.alert(alert);
			delivery.push({ kind: alert.kind, ...report });
			return report;
		},
	};
	const now = deps.now();
	let state = structuredClone(deps.state);
	state.lastPollAt = now;
	const attemptedKinds = new Set<QuotaMonitorAlertKind>();
	let panorama: string[] = [];
	const finish = (outcome: PollOutcome): PollOnceResult => {
		if (outcome !== "observed") {
			deps.log(
				JSON.stringify({
					event: "quota_poll",
					outcome,
					panorama,
					delivery,
				}),
			);
		}
		return result(outcome, state, deps.config.config);
	};
	const reconciled = await deps.reconcileActive();
	if (
		reconciled.result === "transition_journal_conflict" ||
		reconciled.result === "transition_journal_writer_alive"
	) {
		await openSwitchFailureEpisode(
			deps,
			state,
			reconciled.result,
			false,
			attemptedKinds,
		);
		return finish("error");
	}
	if (
		reconciled.generation !== null &&
		reconciled.generation > state.observedGeneration
	) {
		state.observedGeneration = reconciled.generation;
		state.lastSwitchAt = now;
		state.reviveEpoch = null;
		state.blockedEpisode = null;
		state.pendingSwitchFailure = null;
		await deps.persistState(state);
	}

	// Delivery retries are independent of observation health and must run before
	// backoff/blind/error early returns, but only after active reconciliation has
	// invalidated episodes owned by a previous account generation.
	await attemptBlockedDelivery(deps, state, attemptedKinds);
	await attemptSwitchFailureDelivery(deps, state, attemptedKinds);

	// Local tmux recovery remains live even while usage polling is backed off.
	({ state } = await runOpenReviveEpoch(deps, state));

	if (deps.config.error) {
		await deps.alert({
			kind: "quota_monitor_down",
			severity: "warning",
			title: "Claude quota monitor configuration is unavailable",
			body: `config=${deps.config.error}; monitoring continues in monitor-only mode`,
			signature: `quota-monitor-config-${deps.config.error}-${day(now)}`,
		});
	}

	if (state.backoffUntilMs > now) {
		await deps.persistState(state);
		return finish("backoff");
	}

	const snapshot = await deps.withAccountsLock(() => deps.readSnapshot());
	if (
		snapshot.activeName === null ||
		snapshot.activeCredential === null ||
		snapshot.activeCredential.expiresAt <= now
	) {
		await emitBlind(
			deps,
			state,
			snapshot.activeName,
			"credential_missing_or_expired",
		);
		return finish("blind");
	}

	const currentUsage = await deps.fetchUsage(
		snapshot.activeCredential.accessToken,
	);
	if (!("ok" in currentUsage)) {
		if (currentUsage.error === "rate_limited") {
			state.backoffUntilMs =
				now +
				(currentUsage.retryAfterMs ??
					deps.config.config.basePollMinutes * 60_000);
			await deps.persistState(state);
			return finish("backoff");
		}
		if (currentUsage.error === "unauthorized") {
			await emitBlind(
				deps,
				state,
				snapshot.activeName,
				"usage_api_unauthorized",
			);
			return finish("blind");
		}
		state.errorStreak += 1;
		await deps.persistState(state);
		if (state.errorStreak >= MONITOR_DOWN_STREAK) {
			await deps.alert({
				kind: "quota_monitor_down",
				severity: "severe",
				title: "Claude quota monitor usage source is failing",
				body: `account=${snapshot.activeName}; consecutive_errors=${state.errorStreak}; class=${currentUsage.error}`,
				signature: `quota-monitor-down-${day(now)}`,
			});
		}
		return finish("error");
	}

	state.tier =
		currentUsage.ok.fiveH.pct > deps.config.config.acceleratePct
			? "accelerated"
			: "base";
	const committed = await commitSuccessfulObservation(
		deps,
		snapshot,
		currentUsage.ok,
		state,
	);
	if (!committed) {
		deps.log("quota observation discarded: account identity changed");
		return finish("stale_snapshot");
	}
	await projectObservation(
		deps,
		snapshot.activeName,
		currentUsage.ok,
		snapshot.store.generation,
	);

	deps.log(
		`quota account=${snapshot.activeName} five_h=${currentUsage.ok.fiveH.pct} seven_d=${currentUsage.ok.sevenD.pct} tier=${state.tier}`,
	);

	const scope = triggerScope(currentUsage.ok, deps.config.config.trigger5hPct);
	const sweepDue =
		state.tier === "accelerated" &&
		(state.lastCandidateSweepAt === null ||
			now - state.lastCandidateSweepAt >=
				deps.config.config.candidateSweepMinutes * 60_000);
	if (scope === null && sweepDue) {
		await sweepCandidates(deps, snapshot, state);
	}
	if (scope === null) {
		if (state.pendingSwitchFailure !== null) {
			state.pendingSwitchFailure = null;
			await deps.persistState(state);
		}
		await openBlockedRecovery(
			deps,
			state,
			attemptedKinds,
			`account=${snapshot.activeName}; quota windows are below trigger thresholds`,
		);
		return finish("observed");
	}

	if (
		state.lastSwitchAt !== null &&
		now - state.lastSwitchAt <
			deps.config.config.minSwitchIntervalMinutes * 60_000
	) {
		return finish("cooldown");
	}

	if (deps.config.monitorOnly) {
		await openBlockedEpisode(
			deps,
			state,
			scope,
			attemptedKinds,
			`scope=${scope}; monitor-only: configured account order is empty or invalid`,
		);
		return finish("no_target");
	}

	const candidates = await verifyAndRankCandidates(deps, snapshot);
	panorama = candidates.panorama.map(({ name, status }) => `${name}:${status}`);
	let preferredOrder = candidates.ranked;
	let degraded = false;
	if (
		preferredOrder.length === 0 &&
		deps.config.config.degradedSwitch &&
		process.env.FLYWHEEL_QUOTA_DEGRADED_SWITCH !== "0"
	) {
		preferredOrder = degradedOrder(deps, snapshot, candidates.panorama);
		degraded = preferredOrder.length > 0;
	}
	if (preferredOrder.length === 0) {
		await openBlockedEpisode(
			deps,
			state,
			scope,
			attemptedKinds,
			`scope=${scope}\n${panoramaBody(candidates.panorama)}`,
		);
		return finish("no_target");
	}

	const resetAt = operativeResetAt(currentUsage.ok, scope);
	const switched = await deps.switchAccount({
		scope,
		observedAccount: snapshot.activeName,
		observedGeneration: snapshot.store.generation,
		resetAt,
		now: new Date(now),
		preferredOrder,
		verifiedAt: candidates.verifiedAt,
		quotaPreverified: !degraded,
	});

	if (switched.outcome === "noop_already_switched") {
		return finish("noop_already_switched");
	}
	if (switched.outcome === "noop_reconciled") {
		state.observedGeneration = switched.generation;
		state.lastSwitchAt = now;
		state.reviveEpoch = null;
		state.blockedEpisode = null;
		state.pendingSwitchFailure = null;
		await deps.persistState(state);
		return finish("noop_already_switched");
	}
	if (degraded && switched.outcome === "no_account") {
		await openBlockedEpisode(
			deps,
			state,
			scope,
			attemptedKinds,
			`scope=${scope}; degraded=true; reason=${switched.reasonCode}\n${panoramaBody(candidates.panorama)}`,
		);
		return finish("no_target");
	}
	if (switched.outcome === "no_account" || switched.outcome === "failed") {
		const reasonCode = switched.reasonCode;
		await openSwitchFailureEpisode(
			deps,
			state,
			reasonCode,
			degraded,
			attemptedKinds,
		);
		return finish("switch_failed");
	}

	state.lastSwitchAt = now;
	state.observedGeneration = switched.generation;
	state.pendingSwitchFailure = null;
	state.reviveEpoch = {
		open: true,
		sourceAccount: switched.from,
		generation: switched.generation,
		openedAt: now,
		expiresAt: Date.parse(resetAt) + REVIVE_GRACE_MS,
		panes: {},
	};
	await deps.persistState(state);
	const revived = await runOpenReviveEpoch(deps, state);
	state = revived.state;

	const targetUsage = candidates.usageByName.get(switched.to);
	await deps.alert({
		kind: degraded ? "account_switch_degraded" : "account_switched",
		severity: degraded ? "severe" : "info",
		title: degraded
			? "Claude account switched in degraded verification mode"
			: "Claude account switched before quota exhaustion",
		body: `${switched.from}->${switched.to}; scope=${scope}; degraded=${degraded}; from5h=${currentUsage.ok.fiveH.pct}; from7d=${currentUsage.ok.sevenD.pct}; to5h=${targetUsage?.fiveH.pct ?? "unknown"}; to7d=${targetUsage?.sevenD.pct ?? "unknown"}; revived=${revived.summary.revived}; pending=${revived.summary.pending}; login_expired=${revived.summary.loginExpired}`,
		signature: `account-switched-${switched.from}-${switched.to}-${switched.generation}`,
	});
	await openBlockedRecovery(
		deps,
		state,
		attemptedKinds,
		`${switched.from}->${switched.to}; scope=${scope}; account switch succeeded`,
	);

	await refreshNewActive(deps, state, switched.to);
	return finish("switched");
}
