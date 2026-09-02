import { resolveFounderTimezone } from "flywheel-config";
import {
	type CandidatePanoramaEntry,
	verifyAndRankCandidates as selectLiveCandidates,
} from "./account-candidate-selector.js";
import type {
	ProfileIdentity,
	ProfileIdentityResult,
} from "./account-identity.js";
import {
	type AccountEntry,
	type AccountQuotaObservation,
	type AccountStore,
	type RecordObservationResult,
	type SyncActiveAccountResult,
	summarizeModelBenchPool,
} from "./account-store.js";
import type { FreshnessVerdict } from "./freshness.js";
import type { MachineAccountResolution } from "./machine-account.js";
import {
	createModelDetectionIntent,
	finalizeModelSwitchIncident,
	type ModelPaneDetection,
} from "./quota-incident.js";
import type { DeliveryReport } from "./quota-monitor-alert.js";
import type { LoadedQuotaMonitorConfig } from "./quota-monitor-config.js";
import type {
	IdentityMismatchCheckpoint,
	IdentityMismatchEpisode,
	PendingSwitchFailure,
	QuotaMonitorState,
} from "./quota-monitor-state.js";
import type { QuotaPaneSnapshot } from "./quota-revive-scan.js";
import type {
	AccountUsageResult,
	ValidatedUsagePayload,
} from "./quota-usage-api.js";
import type { SwitchInput, SwitchResult } from "./switch-executor.js";

const REVIVE_GRACE_MS = 30 * 60_000;
const MONITOR_DOWN_STREAK = 6;
const MODEL_PANE_SUPPRESSION_MAX_UNSEEN_MS = 24 * 60 * 60_000;

export interface MonitorCredential {
	accessToken: string;
	expiresAt: number;
	/** SHA-256 of the source credential JSON when available. */
	rawDigest?: string;
}

export interface AccountSnapshot {
	activeName: string | null;
	/** Present in production; omitted only by legacy/unit harnesses. */
	authority?: MachineAccountResolution;
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
	| "quota_monitor_down"
	| "machine_account_conflict"
	| "model_cap_switched"
	| "model_cap_unknown"
	| "model_cap_persistent_unknown"
	| "model_bench_malformed"
	| "quota_choice"
	| "quota_switch_confirmation"
	| "account_identity_mismatch"
	| "quota_guard_bypassed";

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
	/** Founder-local rendering seam; production defaults to flywheel-config. */
	founderTimezone?: () => string;
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
	/** Live profile lookup; always called after the account lock is released. */
	fetchIdentity: (accessToken: string) => Promise<ProfileIdentityResult>;
	/** Resolve a probed OAuth identity through the pool's immutable anchors. */
	resolveIdentityName: (identity: ProfileIdentity) => Promise<string | null>;
	/** Read the trusted immutable identity anchor for notification rendering. */
	readPoolIdentity?: (name: string) => Promise<ProfileIdentity | null>;
	recordObservation: (
		name: string,
		observation: AccountQuotaObservation,
		expectedGeneration: number,
	) => Promise<RecordObservationResult>;
	/** Cache and state are committed under the same revalidation lock. */
	writeStatuslineCache: (raw: ValidatedUsagePayload) => Promise<void>;
	persistState: (state: QuotaMonitorState) => Promise<void>;
	switchAccount: (input: SwitchInput) => Promise<SwitchResult>;
	scanPanes?: () => Promise<QuotaPaneSnapshot>;
	reviveSnapshot?: (
		state: QuotaMonitorState,
		snapshot: QuotaPaneSnapshot,
		actionsAllowed: boolean,
	) => Promise<{
		state: QuotaMonitorState;
		summary: ReviveScanSummary;
	}>;
	confirmSnapshot?: (
		state: QuotaMonitorState,
		snapshot: QuotaPaneSnapshot,
	) => Promise<QuotaMonitorState>;
	alert: (alert: QuotaMonitorAlert) => Promise<DeliveryReport>;
	log: (message: string) => void;
}

export type PollOutcome =
	| "observed"
	| "local_scan"
	| "stale_snapshot"
	| "blind"
	| "backoff"
	| "error"
	| "cooldown"
	| "no_target"
	| "switched"
	| "switch_failed"
	| "identity_conflict"
	| "noop_already_switched"
	| "identity_mismatch_active";

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
): string | null {
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
	snapshot: AccountSnapshot,
	name: string,
	refresh: boolean,
): Promise<{ credential: MonitorCredential | null; reason?: string }> {
	return deps.withAccountsLock(async () => {
		const witness = await deps.readSnapshot();
		if (
			snapshot.activeName === null ||
			witness.activeName === null ||
			witness.activeName !== snapshot.activeName ||
			witness.store.generation !== snapshot.store.generation ||
			(witness.activeCredential?.rawDigest !== undefined &&
			snapshot.activeCredential?.rawDigest !== undefined
				? witness.activeCredential.rawDigest !==
					snapshot.activeCredential.rawDigest
				: witness.activeCredential?.accessToken !==
					snapshot.activeCredential?.accessToken)
		) {
			return { credential: null, reason: "active_witness_changed" };
		}
		if (witness.activeName === name) {
			return { credential: null, reason: "became_active" };
		}
		if (refresh) {
			const verdict = await deps.verifyCandidate(name, witness.activeName);
			if (verdict.fresh === "stale") {
				// Keep the refusal reason: a bare "freshness_stale" told an operator
				// nothing about whether the token family was dead or the probe failed.
				return {
					credential: null,
					reason: `freshness_stale: ${verdict.reason}`,
				};
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
	attemptedIdentityLabels: Set<string>,
): Promise<void> {
	const now = deps.now();
	state.lastCandidateSweepAt = now;
	await deps.persistState(state);
	if (snapshot.activeCredential === null || snapshot.activeName === null)
		return;
	const liveIdentity = await deps.fetchIdentity(
		snapshot.activeCredential.accessToken,
	);
	if ("error" in liveIdentity) return;
	const liveName = await deps.resolveIdentityName(liveIdentity);
	if (liveName !== snapshot.activeName) return;
	const witness = await deps.withAccountsLock(() => deps.readSnapshot());
	if (
		witness.activeName !== snapshot.activeName ||
		witness.store.generation !== snapshot.store.generation ||
		witness.activeCredential?.accessToken !==
			snapshot.activeCredential.accessToken
	) {
		return;
	}

	const names = [
		...new Set([...deps.config.config.order, ...snapshot.poolAccounts]),
	];
	for (const name of names) {
		if (name === snapshot.activeName) continue;
		const entry = snapshot.store.accounts.find(
			(account) => account.name === name,
		);
		if (!entry || !snapshot.poolAccounts.includes(name)) continue;
		const checked = await readCandidateCredential(deps, snapshot, name, true);
		if (checked.reason === "active_witness_changed") return;
		const { credential } = checked;
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
	await attemptIdentityDeliveries(deps, state, attemptedIdentityLabels);
	await deps.persistState(state);
}

type PanoramaEntry = CandidatePanoramaEntry;

export function formatModelBenchRetryNote(
	accounts: readonly AccountEntry[],
	models: readonly string[],
	nowMs: number,
): string {
	const summary = summarizeModelBenchPool(accounts, models, nowMs);
	if (summary.nextRetryAt !== null) {
		const unknownSuffix = summary.hasUnknown
			? "; some malformed model bench state has unknown timing"
			: "";
		return `next retry / revalidation after ${summary.nextRetryAt}${unknownSuffix}; this is not a quota recovery guarantee`;
	}
	const reason = summary.hasUnknown
		? "malformed model bench state requires manual inspection"
		: "no finite model bench deadline is available";
	return `next retry / revalidation unknown; ${reason}; this is not a quota recovery guarantee`;
}

export async function verifyAndRankCandidates(
	deps: QuotaMonitorDeps,
	snapshot: AccountSnapshot,
	models: readonly string[] = [],
): ReturnType<typeof selectLiveCandidates> {
	return selectLiveCandidates(
		{
			now: deps.now,
			withAccountsLock: deps.withAccountsLock,
			readSnapshot: deps.readSnapshot,
			verifyCandidate: deps.verifyCandidate,
			readPoolCredential: deps.readPoolCredential,
			fetchUsage: deps.fetchUsage,
			recordObservation: async (name, observation, generation) => {
				const projection = await deps.recordObservation(
					name,
					observation,
					generation,
				);
				if (projection !== "updated") {
					deps.log(
						`quota observation projection account=${name} result=${projection}`,
					);
				}
				return projection;
			},
		},
		snapshot,
		{
			models,
			cooldownPolicy: "exclude",
			headroomPolicy: {
				kind: "prefer_below_trigger",
				trigger5hPct: deps.config.config.trigger5hPct,
			},
		},
	);
}

function panoramaBody(panorama: PanoramaEntry[]): string {
	return panorama.length === 0
		? "no configured candidates"
		: panorama.map((entry) => `${entry.name}: ${entry.status}`).join("\n");
}

function candidateDecisionInputs(
	snapshot: AccountSnapshot,
	panorama: readonly PanoramaEntry[],
): Array<{ name: string; resetsAt: string | null; fiveHPct: number | null }> {
	const accountsByName = new Map(
		snapshot.store.accounts.map((entry) => [entry.name, entry]),
	);
	return panorama.map((entry) => ({
		name: entry.name,
		resetsAt:
			entry.usage?.sevenD.resetsAt ??
			accountsByName.get(entry.name)?.weeklyResetAt ??
			null,
		fiveHPct: entry.usage?.fiveH.pct ?? null,
	}));
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

const IDENTITY_DIGEST = /^[a-f0-9]{64}$/;
const IDENTITY_LABEL = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;

type IdentityMismatchFact = {
	label: string;
	checkpoint: IdentityMismatchCheckpoint;
	expectedKey: string;
	actualDigest: string;
};

function validIdentityFact(fact: IdentityMismatchFact): boolean {
	return (
		IDENTITY_LABEL.test(fact.label) &&
		IDENTITY_DIGEST.test(fact.expectedKey) &&
		IDENTITY_DIGEST.test(fact.actualDigest)
	);
}

async function clearIdentityEpisode(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	label: string,
	checkpoint?: IdentityMismatchCheckpoint,
): Promise<void> {
	const episodes = state.identityMismatchEpisodes;
	if (episodes === null) return;
	const episode = episodes[label];
	if (episode === undefined) return;
	if (checkpoint !== undefined && episode.checkpoint !== checkpoint) return;
	delete episodes[label];
	if (Object.keys(episodes).length === 0) {
		state.identityMismatchEpisodes = null;
		state.identityAlertCursor = null;
	} else if (
		state.identityAlertCursor !== null &&
		episodes[state.identityAlertCursor] === undefined
	) {
		state.identityAlertCursor = null;
	}
	await deps.persistState(state);
}

async function openIdentityEpisode(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	fact: IdentityMismatchFact,
): Promise<void> {
	if (!validIdentityFact(fact)) return;
	const now = deps.now();
	const nowIso = new Date(now).toISOString();
	const episodes = state.identityMismatchEpisodes ?? {};
	const current = episodes[fact.label];
	const sameFingerprint =
		current !== undefined &&
		current.checkpoint === fact.checkpoint &&
		current.expectedKey === fact.expectedKey &&
		current.actualDigest === fact.actualDigest;
	let episode: IdentityMismatchEpisode;
	if (!sameFingerprint) {
		if (current === undefined && Object.keys(episodes).length >= 32) {
			return;
		}
		episode = {
			checkpoint: fact.checkpoint,
			expectedKey: fact.expectedKey,
			actualDigest: fact.actualDigest,
			startedAt: nowIso,
			lastConfirmedAlertAt: null,
			alertCount: 0,
			round: 1,
			activeDelivery: { round: 1, attempts: 0, lastAttemptAt: null },
		};
		episodes[fact.label] = episode;
		state.identityMismatchEpisodes = episodes;
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
		episode.round += 1;
		episode.activeDelivery = {
			round: episode.round,
			attempts: 0,
			lastAttemptAt: null,
		};
	}
	await deps.persistState(state);
}

async function attemptIdentityDeliveries(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	attemptedLabels: Set<string>,
): Promise<void> {
	const episodes = state.identityMismatchEpisodes;
	if (episodes === null || attemptedLabels.size >= 2) return;
	const labels = Object.keys(episodes).sort();
	if (labels.length === 0) return;
	const cursorIndex =
		state.identityAlertCursor === null
			? -1
			: labels.indexOf(state.identityAlertCursor);
	const ordered = labels.map(
		(_, index) => labels[(cursorIndex + 1 + index) % labels.length]!,
	);
	for (const label of ordered) {
		if (attemptedLabels.size >= 2) break;
		if (attemptedLabels.has(label)) continue;
		const episode = episodes[label];
		if (
			episode === undefined ||
			episode.activeDelivery === null ||
			!deliveryDue(
				episode.activeDelivery.attempts,
				episode.activeDelivery.lastAttemptAt,
				deps.now(),
				deps.config.config.episodeRealertMinutes,
			)
		) {
			continue;
		}
		const delivery = episode.activeDelivery;
		attemptedLabels.add(label);
		state.identityAlertCursor = label;
		delivery.lastAttemptAt = new Date(deps.now()).toISOString();
		await deps.persistState(state);
		const report = await safeAlert(deps, {
			kind: "account_identity_mismatch",
			severity: "severe",
			title: "Claude account identity does not match its label",
			body: `label=${label}; checkpoint=${episode.checkpoint}; expectedKey=${episode.expectedKey}; actualDigest=${episode.actualDigest}`,
			signature: `account-identity-mismatch-${label}-${episode.startedAt}-r${delivery.round}-a${delivery.attempts}`,
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
}

async function consumeApplyIdentityReports(
	deps: QuotaMonitorDeps,
	state: QuotaMonitorState,
	reports: SwitchResult["applyReports"],
): Promise<void> {
	for (const report of reports ?? []) {
		for (const check of report.identityChecks) {
			if (check.verdict === "match") {
				await clearIdentityEpisode(deps, state, check.label, check.checkpoint);
			} else if (
				check.verdict === "mismatch" &&
				check.expectedKey !== undefined &&
				check.actualDigest !== undefined
			) {
				await openIdentityEpisode(deps, state, {
					label: check.label,
					checkpoint: check.checkpoint,
					expectedKey: check.expectedKey,
					actualDigest: check.actualDigest,
				});
			}
		}
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

const EMPTY_REVIVE_SUMMARY: ReviveScanSummary = {
	revived: 0,
	pending: 0,
	loginExpired: 0,
};

function cappedModelDetections(
	snapshot: QuotaPaneSnapshot | null,
	state: QuotaMonitorState,
): ModelPaneDetection[] {
	if (snapshot === null) return [];
	return snapshot.observations.flatMap((observation) =>
		observation.managed &&
		observation.modelVerdict.state === "capped" &&
		!(
			state.modelPaneSuppressions[
				`${snapshot.socket}:${observation.pane.paneId}:${observation.pane.panePid}`
			]?.models.includes(observation.modelVerdict.model) ?? false
		)
			? [{ pane: observation.pane, model: observation.modelVerdict.model }]
			: [],
	);
}

function reconcileModelPaneSuppressions(
	state: QuotaMonitorState,
	snapshot: QuotaPaneSnapshot | null,
): void {
	if (snapshot === null) return;
	const observations = new Map(
		snapshot.observations.map((observation) => [
			`${snapshot.socket}:${observation.pane.paneId}:${observation.pane.panePid}`,
			observation,
		]),
	);
	const present = new Set(observations.keys());
	for (const pane of snapshot.omittedPanes) {
		present.add(`${snapshot.socket}:${pane.paneId}:${pane.panePid}`);
	}
	for (const key of Object.keys(state.modelPaneSuppressions)) {
		const suppression = state.modelPaneSuppressions[key];
		if (suppression === undefined) continue;
		const observation = observations.get(key);
		if (
			observation !== undefined &&
			observation.capture !== null &&
			observation.managed &&
			observation.modelVerdict.state === "clear"
		) {
			delete state.modelPaneSuppressions[key];
			continue;
		}
		if (present.has(key)) {
			state.modelPaneSuppressions[key] = {
				...suppression,
				lastSeenAt: Math.max(suppression.lastSeenAt, snapshot.capturedAt),
			};
			continue;
		}
		if (
			snapshot.complete ||
			snapshot.capturedAt - suppression.lastSeenAt >
				MODEL_PANE_SUPPRESSION_MAX_UNSEEN_MS
		) {
			delete state.modelPaneSuppressions[key];
		}
	}
}

function modelSnapshotIsUncertain(snapshot: QuotaPaneSnapshot): boolean {
	return (
		!snapshot.complete ||
		snapshot.observations.some(
			(observation) => observation.modelVerdict.state === "unknown",
		)
	);
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
	const attemptedKinds = new Set<QuotaMonitorAlertKind>();
	const attemptedIdentityLabels = new Set<string>();
	let panorama: string[] = [];
	const paneScanDue = state.nextPaneScanDueAt <= now;
	const confirmationDue =
		state.confirmation !== null && state.confirmation.dueAt <= now;
	let paneSnapshot: QuotaPaneSnapshot | null = null;
	if ((paneScanDue || confirmationDue) && deps.scanPanes) {
		paneSnapshot = await deps.scanPanes();
	}
	if (paneScanDue) {
		state.nextPaneScanDueAt = now + deps.config.config.paneScanSeconds * 1_000;
	}
	reconcileModelPaneSuppressions(state, paneSnapshot);
	const detectedModels = cappedModelDetections(paneSnapshot, state);
	let localProcessed = false;
	const processLocalSnapshot = async (
		actionsAllowed = true,
	): Promise<ReviveScanSummary> => {
		if (localProcessed || paneSnapshot === null) return EMPTY_REVIVE_SUMMARY;
		let summary = EMPTY_REVIVE_SUMMARY;
		if (deps.reviveSnapshot) {
			const revived = await deps.reviveSnapshot(
				state,
				paneSnapshot,
				actionsAllowed,
			);
			state = revived.state;
			summary = revived.summary;
		}
		if (
			confirmationDue &&
			state.confirmation !== null &&
			state.confirmation.dueAt <= now &&
			deps.confirmSnapshot
		) {
			state = await deps.confirmSnapshot(state, paneSnapshot);
		}
		localProcessed = true;
		return summary;
	};
	const finish = async (
		outcome: PollOutcome,
		actionsAllowed = true,
	): Promise<PollOnceResult> => {
		await processLocalSnapshot(actionsAllowed);
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
		state.identityMismatchEpisodes = null;
		state.identityAlertCursor = null;
		await deps.persistState(state);
	}
	await attemptBlockedDelivery(deps, state, attemptedKinds);
	await attemptSwitchFailureDelivery(deps, state, attemptedKinds);
	await attemptIdentityDeliveries(deps, state, attemptedIdentityLabels);

	if (
		state.nextUsageDueAt > now &&
		detectedModels.length === 0 &&
		paneSnapshot !== null &&
		!modelSnapshotIsUncertain(paneSnapshot) &&
		state.pendingDetection !== null
	) {
		const identity = await deps.withAccountsLock(() => deps.readIdentity());
		if (
			state.pendingDetection.observedGeneration === identity.storeGeneration &&
			state.pendingDetection.sourceAccount === identity.activeName
		) {
			state.pendingDetection = null;
		}
	}
	if (state.nextUsageDueAt > now && detectedModels.length === 0) {
		await processLocalSnapshot();
		await deps.persistState(state);
		return result(
			state.backoffUntilMs > now && !paneScanDue && !confirmationDue
				? "backoff"
				: "local_scan",
			state,
			deps.config.config,
		);
	}

	state.lastPollAt = now;
	state.nextUsageDueAt = now + pollIntervalMs(state, deps.config.config);
	if (deps.config.error) {
		await deps.alert({
			kind: "quota_monitor_down",
			severity: "warning",
			title: "Claude quota monitor configuration is unavailable",
			body: `config=${deps.config.error}; monitoring continues in monitor-only mode`,
			signature: `quota-monitor-config-${deps.config.error}-${day(now)}`,
		});
	}

	const snapshot = await deps.withAccountsLock(() => deps.readSnapshot());
	if (snapshot.authority && snapshot.authority.kind !== "resolved") {
		await deps.alert({
			kind: "machine_account_conflict",
			severity: "severe",
			title: "Claude machine account witnesses disagree",
			body: `authority=${snapshot.authority.kind}; refusing usage attribution or account switch`,
			signature: `machine-account-${snapshot.authority.kind}-${day(now)}`,
		});
		await deps.persistState(state);
		return finish("identity_conflict", false);
	}

	let modelDetection =
		detectedModels.length > 0 && snapshot.activeName !== null
			? createModelDetectionIntent({
					socket: paneSnapshot?.socket ?? "",
					observedGeneration: snapshot.store.generation,
					observedAt: paneSnapshot?.capturedAt ?? now,
					sourceAccount: snapshot.activeName,
					detections: detectedModels,
				})
			: null;
	if (modelDetection !== null) {
		state.pendingDetection = modelDetection;
		state.observedGeneration = snapshot.store.generation;
		await deps.persistState(state);
	} else if (
		paneSnapshot !== null &&
		!modelSnapshotIsUncertain(paneSnapshot) &&
		state.pendingDetection !== null &&
		state.pendingDetection.observedGeneration === snapshot.store.generation &&
		state.pendingDetection.sourceAccount === snapshot.activeName
	) {
		state.pendingDetection = null;
		await deps.persistState(state);
	}

	if (state.backoffUntilMs > now) {
		state.nextUsageDueAt = state.backoffUntilMs;
		await deps.persistState(state);
		return finish("backoff");
	}
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
			state.nextUsageDueAt = state.backoffUntilMs;
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
	state.nextUsageDueAt = now + pollIntervalMs(state, deps.config.config);
	const committed = await commitSuccessfulObservation(
		deps,
		snapshot,
		currentUsage.ok,
		state,
	);
	if (!committed) {
		deps.log("quota observation discarded: account identity changed");
		return finish("stale_snapshot", false);
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
	// A triggering window is by definition open, so it must carry a reset instant.
	// Null here is an API contract violation — fail closed before any early exit
	// (cooldown / monitor-only / no_target) can route around this check, and before
	// any candidate or switch I/O. Both downstream consumers (SwitchInput.resetAt
	// and reviveEpoch.expiresAt) read the narrowed value below, so neither can ever
	// see a fabricated timestamp.
	let accountTrigger: {
		scope: "5h" | "weekly" | "both";
		resetAt: string;
	} | null = null;
	if (scope !== null) {
		const resetAt = operativeResetAt(currentUsage.ok, scope);
		if (resetAt === null) {
			deps.log(
				JSON.stringify({
					event: "usage_reset_missing",
					account: snapshot.activeName,
					scope,
				}),
			);
			await deps.alert({
				kind: "quota_monitor_down",
				severity: "severe",
				title: "Claude quota trigger window reported no reset instant",
				body: `account=${snapshot.activeName}; scope=${scope}; triggering window has no resets_at; refused before candidate or switch I/O`,
				// Own namespace: the consecutive-usage-failure path already holds
				// `quota-monitor-down-<day>`, and lead-alert.sh dedupes on
				// project|lead|kind|signature — a shared signature would swallow one.
				signature: `quota-usage-reset-missing-${snapshot.activeName}-${scope}-${day(now)}`,
			});
			return finish("error");
		}
		accountTrigger = { scope, resetAt };
	}
	if (scope !== null && state.pendingDetection !== null) {
		state.pendingDetection = null;
		modelDetection = null;
		await deps.persistState(state);
	}
	const sweepDue =
		state.lastCandidateSweepAt === null ||
		now - state.lastCandidateSweepAt >=
			deps.config.config.candidateSweepMinutes * 60_000;
	if (
		!deps.config.monitorOnly &&
		scope === null &&
		modelDetection === null &&
		sweepDue
	) {
		await sweepCandidates(deps, snapshot, state, attemptedIdentityLabels);
	}
	if (scope === null && modelDetection === null) {
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
		if (modelDetection === null) {
			if (scope === null) throw new Error("missing quota trigger scope");
			await openBlockedEpisode(
				deps,
				state,
				scope,
				attemptedKinds,
				`scope=${scope}; monitor-only: configured account order is empty or invalid`,
			);
		} else {
			await deps.alert({
				kind: "quota_no_target",
				severity: "severe",
				title: "Claude model-cap trigger reached in monitor-only mode",
				body: `models=${modelDetection.models.join(",")}; monitor-only: configured account order is empty or invalid`,
				signature: `quota-no-target-model-${modelDetection.models.join("+")}-${day(now)}`,
			});
		}
		return finish("no_target");
	}
	const triggerModels = modelDetection?.models ?? [];
	const candidates = await verifyAndRankCandidates(
		deps,
		snapshot,
		triggerModels,
	);
	deps.log(
		JSON.stringify({
			event: "quota_switch_decision",
			trigger:
				modelDetection === null
					? { kind: "quota", scope }
					: { kind: "model", models: modelDetection.models },
			selected: candidates.ranked[0] ?? null,
			candidates: candidateDecisionInputs(snapshot, candidates.panorama),
		}),
	);
	await attemptIdentityDeliveries(deps, state, attemptedIdentityLabels);
	panorama = candidates.panorama.map(({ name, status }) => `${name}:${status}`);
	if (modelDetection !== null && candidates.malformedModelBenches.length > 0) {
		const malformed = [...candidates.malformedModelBenches].sort();
		await deps.alert({
			kind: "model_bench_malformed",
			severity: "warning",
			title: "Claude model bench state is malformed",
			body: `accounts=${malformed.join(",")}; models=${modelDetection.models.join(",")}; excluded fail-closed before credential or usage I/O`,
			signature: `model-bench-malformed-${malformed.join("+")}-${modelDetection.models.join("+")}-${day(now)}`,
		});
	}
	const preferredOrder = candidates.ranked;
	if (preferredOrder.length === 0) {
		const candidateAccounts = snapshot.store.accounts.filter(
			(account) =>
				account.name !== snapshot.activeName &&
				snapshot.poolAccounts.includes(account.name),
		);
		if (modelDetection === null) {
			if (scope === null) throw new Error("missing quota trigger scope");
			await openBlockedEpisode(
				deps,
				state,
				scope,
				attemptedKinds,
				`scope=${scope}\n${panoramaBody(candidates.panorama)}`,
			);
		} else {
			await deps.alert({
				kind: "quota_no_target",
				severity: "severe",
				title: "No verified Claude account has quota",
				body: `models=${modelDetection.models.join(",")}\n${panoramaBody(candidates.panorama)}\n${formatModelBenchRetryNote(candidateAccounts, modelDetection.models, now)}`,
				signature: `quota-no-target-model-${modelDetection.models.join("+")}-${day(now)}`,
			});
		}
		return finish("no_target");
	}

	// Notification copy is committed by the switch executor. Fetch every
	// non-secret rendering fact before entering its account lock so the atomic
	// commit never performs network or Keychain identity I/O.
	const usageByName = new Map(candidates.usageByName);
	usageByName.set(snapshot.activeName, currentUsage.ok);
	const identityByName = new Map<string, { email?: string }>();
	const identityNames = [...new Set([snapshot.activeName, ...preferredOrder])];
	await Promise.all(
		identityNames.map(async (name) => {
			const storedEmail = snapshot.store.accounts.find(
				(account) => account.name === name,
			)?.identity?.email;
			let email = storedEmail;
			if (deps.readPoolIdentity !== undefined) {
				try {
					email = (await deps.readPoolIdentity(name))?.email ?? email;
				} catch (error) {
					deps.log(
						`switch notification identity lookup failed account=${name} error=${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			identityByName.set(name, email === undefined ? {} : { email });
		}),
	);
	const notificationContext = {
		founderTimezone: deps.founderTimezone?.() ?? resolveFounderTimezone(),
		usageByName,
		identityByName,
		panorama: candidates.panorama,
		headroomDegraded: candidates.headroomDegraded,
	};

	let switchInput: SwitchInput;
	if (modelDetection === null) {
		// Narrowed by the fail-closed guard above rather than cast: an account-level
		// trigger without a reset instant already returned `error`.
		if (accountTrigger === null) throw new Error("missing quota trigger scope");
		switchInput = {
			trigger: {
				kind: "quota",
				scope: accountTrigger.scope,
				resetAt: accountTrigger.resetAt,
			},
			observedAccount: snapshot.activeName,
			observedGeneration: snapshot.store.generation,
			now: new Date(now),
			preferredOrder,
			verifiedAt: candidates.verifiedAt,
			quotaPreverified: true,
			notificationContext,
		};
	} else {
		switchInput = {
			trigger: { kind: "model", models: modelDetection.models },
			observedAccount: snapshot.activeName,
			observedGeneration: snapshot.store.generation,
			now: new Date(now),
			preferredOrder,
			verifiedAt: candidates.verifiedAt,
			quotaPreverified: true,
			notificationContext,
		};
	}
	const switched = await deps.switchAccount(switchInput);
	await consumeApplyIdentityReports(deps, state, switched.applyReports);
	await attemptIdentityDeliveries(deps, state, attemptedIdentityLabels);

	if (switched.outcome === "noop_already_switched") {
		return finish("noop_already_switched");
	}
	if (switched.outcome === "noop_reconciled") {
		state.observedGeneration = switched.generation;
		state.lastSwitchAt = now;
		state.reviveEpoch = null;
		state.blockedEpisode = null;
		state.pendingSwitchFailure = null;
		state.identityMismatchEpisodes = null;
		state.identityAlertCursor = null;
		await deps.persistState(state);
		return finish("noop_already_switched");
	}
	if (switched.outcome === "no_account" || switched.outcome === "failed") {
		const reasonCode = switched.reasonCode;
		if (modelDetection === null) {
			await openSwitchFailureEpisode(
				deps,
				state,
				reasonCode,
				false,
				attemptedKinds,
			);
		} else {
			await deps.alert({
				kind: "account_switch_failed",
				severity: "severe",
				title: "Claude model-cap account switch failed",
				body: `account=${snapshot.activeName}; trigger=models:${modelDetection.models.join(",")}; reason=${reasonCode}`,
				signature: `account-switch-failed-${reasonCode}-${day(now)}`,
			});
		}
		return finish("switch_failed");
	}
	if (modelDetection !== null) {
		state = finalizeModelSwitchIncident(state, {
			detectionEventId: modelDetection.eventId,
			switched,
			finalizedAt: now,
			confirmDelayMs: deps.config.config.confirmDelayMinutes * 60_000,
		});
		await deps.persistState(state);
		await processLocalSnapshot();
		await refreshNewActive(deps, state, switched.to);
		return finish("switched");
	}

	// Only the account-level path reaches here — the model-cap path returned above
	// — so the same guarded trigger backs the revive deadline. No cast, no NaN.
	if (accountTrigger === null) throw new Error("missing quota trigger scope");
	state.lastSwitchAt = now;
	state.observedGeneration = switched.generation;
	state.confirmation = null;
	state.confirmDueAt = null;
	state.pendingSwitchFailure = null;
	state.reviveEpoch = {
		open: true,
		sourceAccount: switched.from,
		generation: switched.generation,
		openedAt: now,
		expiresAt: Date.parse(accountTrigger.resetAt) + REVIVE_GRACE_MS,
		panes: {},
	};
	await deps.persistState(state);
	await processLocalSnapshot();
	await openBlockedRecovery(
		deps,
		state,
		attemptedKinds,
		`${switched.from}->${switched.to}; scope=${scope}; account switch succeeded`,
	);

	await refreshNewActive(deps, state, switched.to);
	return finish("switched");
}
