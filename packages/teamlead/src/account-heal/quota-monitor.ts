import {
	type AccountStore,
	isAuthUnusable,
	isQuotaUsable,
} from "./account-store.js";
import type { FreshnessVerdict } from "./freshness.js";
import type { LoadedQuotaMonitorConfig } from "./quota-monitor-config.js";
import type { QuotaMonitorState } from "./quota-monitor-state.js";
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
	| "quota_no_target"
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

export interface QuotaMonitorDeps {
	now: () => number;
	config: LoadedQuotaMonitorConfig;
	state: QuotaMonitorState;
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
	/** Cache and state are committed under the same revalidation lock. */
	writeStatuslineCache: (raw: ValidatedUsagePayload) => Promise<void>;
	persistState: (state: QuotaMonitorState) => Promise<void>;
	switchAccount: (input: SwitchInput) => Promise<SwitchResult>;
	reviveScan?: (state: QuotaMonitorState) => Promise<{
		state: QuotaMonitorState;
		summary: ReviveScanSummary;
	}>;
	alert: (alert: QuotaMonitorAlert) => Promise<void>;
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
		await deps.fetchUsage(credential.accessToken);
	}
	state.lastCandidateSweepAt = now;
	await deps.persistState(state);
}

type PanoramaEntry = { name: string; status: string; usage?: SuccessfulUsage };

async function verifyAndRankCandidates(
	deps: QuotaMonitorDeps,
	snapshot: AccountSnapshot,
): Promise<{
	ranked: string[];
	panorama: PanoramaEntry[];
	usageByName: Map<string, SuccessfulUsage>;
}> {
	const now = deps.now();
	const panorama: PanoramaEntry[] = [];
	const qualified: Array<{
		name: string;
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
		if (!isQuotaUsable(entry, now)) {
			panorama.push({ name, status: "cooldown" });
			continue;
		}

		const checked = await readCandidateCredential(deps, name, true);
		if (checked.credential === null) {
			panorama.push({
				name,
				status: checked.reason ?? "credential_unavailable",
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
		panorama.push({ name, status: "qualified", usage: candidateUsage.ok });
		qualified.push({
			name,
			resetMs: Date.parse(candidateUsage.ok.sevenD.resetsAt),
			orderIndex,
		});
	}

	qualified.sort(
		(a, b) => a.resetMs - b.resetMs || a.orderIndex - b.orderIndex,
	);
	return {
		ranked: qualified.map((entry) => entry.name),
		panorama,
		usageByName,
	};
}

function panoramaBody(panorama: PanoramaEntry[]): string {
	return panorama.length === 0
		? "no configured candidates"
		: panorama.map((entry) => `${entry.name}: ${entry.status}`).join("\n");
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
	await commitSuccessfulObservation(deps, snapshot, observed.ok, state);
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
	deps: QuotaMonitorDeps,
): Promise<PollOnceResult> {
	const now = deps.now();
	let state = structuredClone(deps.state);
	state.lastPollAt = now;

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
		return result("backoff", state, deps.config.config);
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
		return result("blind", state, deps.config.config);
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
			return result("backoff", state, deps.config.config);
		}
		if (currentUsage.error === "unauthorized") {
			await emitBlind(
				deps,
				state,
				snapshot.activeName,
				"usage_api_unauthorized",
			);
			return result("blind", state, deps.config.config);
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
		return result("error", state, deps.config.config);
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
		return result("stale_snapshot", state, deps.config.config);
	}

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
	if (scope === null) return result("observed", state, deps.config.config);

	if (
		state.lastSwitchAt !== null &&
		now - state.lastSwitchAt <
			deps.config.config.minSwitchIntervalMinutes * 60_000
	) {
		return result("cooldown", state, deps.config.config);
	}

	if (deps.config.monitorOnly) {
		await deps.alert({
			kind: "quota_no_target",
			severity: "severe",
			title: "Claude quota threshold reached in monitor-only mode",
			body: `scope=${scope}; monitor-only: configured account order is empty or invalid`,
			signature: `quota-no-target-${scope}-${day(now)}`,
		});
		return result("no_target", state, deps.config.config);
	}

	const candidates = await verifyAndRankCandidates(deps, snapshot);
	if (candidates.ranked.length === 0) {
		await deps.alert({
			kind: "quota_no_target",
			severity: "severe",
			title: "No verified Claude account has quota",
			body: `scope=${scope}\n${panoramaBody(candidates.panorama)}`,
			signature: `quota-no-target-${scope}-${day(now)}`,
		});
		return result("no_target", state, deps.config.config);
	}

	const resetAt = operativeResetAt(currentUsage.ok, scope);
	const switched = await deps.switchAccount({
		scope,
		observedAccount: snapshot.activeName,
		observedGeneration: snapshot.store.generation,
		resetAt,
		now: new Date(now),
		preferredOrder: candidates.ranked,
	});

	if (switched.outcome === "noop_already_switched") {
		return result("noop_already_switched", state, deps.config.config);
	}
	if (switched.outcome === "no_account" || switched.outcome === "failed") {
		const reasonCode = switched.reasonCode;
		await deps.alert({
			kind: "account_switch_failed",
			severity: "severe",
			title: "Claude account switch failed",
			body: `account=${snapshot.activeName}; scope=${scope}; reason=${reasonCode}`,
			signature: `account-switch-failed-${reasonCode}-${day(now)}`,
		});
		return result("switch_failed", state, deps.config.config);
	}

	state.lastSwitchAt = now;
	state.observedGeneration = switched.generation;
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
		kind: "account_switched",
		severity: "info",
		title: "Claude account switched before quota exhaustion",
		body: `${switched.from}->${switched.to}; scope=${scope}; from5h=${currentUsage.ok.fiveH.pct}; from7d=${currentUsage.ok.sevenD.pct}; to5h=${targetUsage?.fiveH.pct ?? "unknown"}; to7d=${targetUsage?.sevenD.pct ?? "unknown"}; revived=${revived.summary.revived}; pending=${revived.summary.pending}; login_expired=${revived.summary.loginExpired}`,
		signature: `account-switched-${switched.from}-${switched.to}-${switched.generation}`,
	});

	await refreshNewActive(deps, state, switched.to);
	return result("switched", state, deps.config.config);
}
