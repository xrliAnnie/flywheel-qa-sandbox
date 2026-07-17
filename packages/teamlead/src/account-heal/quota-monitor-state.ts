import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RevivePaneAttempt {
	attempts: number;
	lastAttemptAt: number;
}

export interface ReviveEpoch {
	open: true;
	sourceAccount: string;
	generation: number;
	openedAt: number;
	expiresAt: number;
	panes: Record<string, RevivePaneAttempt>;
}

export interface EpisodeDelivery {
	kind: "blocked" | "recovered";
	round: number;
	attempts: number;
	lastAttemptAt: string | null;
}

export interface BlockedEpisode {
	scope: "5h" | "weekly" | "both";
	startedAt: string;
	lastConfirmedAlertAt: string | null;
	alertCount: number;
	blockedRound: number;
	recoveryRound: number;
	activeDelivery: EpisodeDelivery | null;
}

export interface SwitchFailureDelivery {
	round: number;
	attempts: number;
	lastAttemptAt: string | null;
}

export interface PendingSwitchFailure {
	reasonCode: string;
	degraded: boolean;
	startedAt: string;
	lastConfirmedAlertAt: string | null;
	alertCount: number;
	activeDelivery: SwitchFailureDelivery | null;
}

export type IdentityMismatchCheckpoint =
	| "candidate"
	| "active"
	| "pre_write"
	| "capture_back"
	| "capture";

export interface IdentityMismatchEpisode {
	checkpoint: IdentityMismatchCheckpoint;
	expectedKey: string;
	actualDigest: string;
	startedAt: string;
	lastConfirmedAlertAt: string | null;
	alertCount: number;
	round: number;
	activeDelivery: SwitchFailureDelivery | null;
}

export interface QuotaMonitorState {
	version: 1;
	lastPollAt: number | null;
	lastSuccessfulUsageAt: number | null;
	errorStreak: number;
	backoffUntilMs: number;
	tier: "base" | "accelerated";
	lastCandidateSweepAt: number | null;
	lastSwitchAt: number | null;
	observedGeneration: number;
	reviveEpoch: ReviveEpoch | null;
	blockedEpisode: BlockedEpisode | null;
	pendingSwitchFailure: PendingSwitchFailure | null;
	identityMismatchEpisodes: Record<string, IdentityMismatchEpisode> | null;
	identityAlertCursor: string | null;
}

export interface LoadQuotaMonitorStateOptions {
	nowMs: number;
	storeGeneration: number;
}

export type LoadedQuotaMonitorState = {
	state: QuotaMonitorState;
	recovery?: "missing" | "corrupt" | "generation_advanced";
};

const PROFILE_NAME = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;
const STATE_KEYS = new Set([
	"version",
	"lastPollAt",
	"lastSuccessfulUsageAt",
	"errorStreak",
	"backoffUntilMs",
	"tier",
	"lastCandidateSweepAt",
	"lastSwitchAt",
	"observedGeneration",
	"reviveEpoch",
	"blockedEpisode",
	"pendingSwitchFailure",
	"identityMismatchEpisodes",
	"identityAlertCursor",
]);
const EPOCH_KEYS = new Set([
	"open",
	"sourceAccount",
	"generation",
	"openedAt",
	"expiresAt",
	"panes",
]);
const ATTEMPT_KEYS = new Set(["attempts", "lastAttemptAt"]);
const BLOCKED_EPISODE_KEYS = new Set([
	"scope",
	"startedAt",
	"lastConfirmedAlertAt",
	"alertCount",
	"blockedRound",
	"recoveryRound",
	"activeDelivery",
]);
const EPISODE_DELIVERY_KEYS = new Set([
	"kind",
	"round",
	"attempts",
	"lastAttemptAt",
]);
const SWITCH_FAILURE_KEYS = new Set([
	"reasonCode",
	"degraded",
	"startedAt",
	"lastConfirmedAlertAt",
	"alertCount",
	"activeDelivery",
]);
const SWITCH_FAILURE_DELIVERY_KEYS = new Set([
	"round",
	"attempts",
	"lastAttemptAt",
]);
const IDENTITY_MISMATCH_EPISODE_KEYS = new Set([
	"checkpoint",
	"expectedKey",
	"actualDigest",
	"startedAt",
	"lastConfirmedAlertAt",
	"alertCount",
	"round",
	"activeDelivery",
]);
const IDENTITY_CHECKPOINTS = new Set<IdentityMismatchCheckpoint>([
	"candidate",
	"active",
	"pre_write",
	"capture_back",
	"capture",
]);
const DIGEST = /^[a-f0-9]{64}$/;

export function defaultQuotaMonitorStatePath(): string {
	return (
		process.env.FLYWHEEL_QUOTA_STATE_PATH ??
		join(homedir(), ".flywheel", "quota-monitor-state.json")
	);
}

export function emptyQuotaMonitorState(
	observedGeneration = 0,
): QuotaMonitorState {
	return {
		version: 1,
		lastPollAt: null,
		lastSuccessfulUsageAt: null,
		errorStreak: 0,
		backoffUntilMs: 0,
		tier: "base",
		lastCandidateSweepAt: null,
		lastSwitchAt: null,
		observedGeneration,
		reviveEpoch: null,
		blockedEpisode: null,
		pendingSwitchFailure: null,
		identityMismatchEpisodes: null,
		identityAlertCursor: null,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: Set<string>,
): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
	return value === null || isNonNegativeNumber(value);
}

function isGeneration(value: unknown): value is number {
	return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isIsoInstant(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNullableIsoInstant(value: unknown): value is string | null {
	return value === null || isIsoInstant(value);
}

function parseEpisodeDelivery(
	value: unknown,
): EpisodeDelivery | null | undefined {
	if (value === null) return null;
	if (!isRecord(value) || !hasOnlyKeys(value, EPISODE_DELIVERY_KEYS)) {
		return undefined;
	}
	if (
		(value.kind !== "blocked" && value.kind !== "recovered") ||
		!isGeneration(value.round) ||
		!isGeneration(value.attempts) ||
		!isNullableIsoInstant(value.lastAttemptAt)
	) {
		return undefined;
	}
	return {
		kind: value.kind,
		round: value.round,
		attempts: value.attempts,
		lastAttemptAt: value.lastAttemptAt,
	};
}

function parseBlockedEpisode(
	value: unknown,
): BlockedEpisode | null | undefined {
	if (value === undefined || value === null) return null;
	if (!isRecord(value) || !hasOnlyKeys(value, BLOCKED_EPISODE_KEYS)) {
		return undefined;
	}
	const activeDelivery = parseEpisodeDelivery(value.activeDelivery);
	if (
		(value.scope !== "5h" &&
			value.scope !== "weekly" &&
			value.scope !== "both") ||
		!isIsoInstant(value.startedAt) ||
		!isNullableIsoInstant(value.lastConfirmedAlertAt) ||
		!isGeneration(value.alertCount) ||
		value.alertCount > 10 ||
		!isGeneration(value.blockedRound) ||
		!isGeneration(value.recoveryRound) ||
		activeDelivery === undefined ||
		(activeDelivery !== null &&
			activeDelivery.round !==
				(activeDelivery.kind === "blocked"
					? value.blockedRound
					: value.recoveryRound))
	) {
		return undefined;
	}
	return {
		scope: value.scope,
		startedAt: value.startedAt,
		lastConfirmedAlertAt: value.lastConfirmedAlertAt,
		alertCount: value.alertCount,
		blockedRound: value.blockedRound,
		recoveryRound: value.recoveryRound,
		activeDelivery,
	};
}

function parseSwitchFailureDelivery(
	value: unknown,
): SwitchFailureDelivery | null | undefined {
	if (value === null) return null;
	if (!isRecord(value) || !hasOnlyKeys(value, SWITCH_FAILURE_DELIVERY_KEYS)) {
		return undefined;
	}
	if (
		!isGeneration(value.round) ||
		!isGeneration(value.attempts) ||
		!isNullableIsoInstant(value.lastAttemptAt)
	) {
		return undefined;
	}
	return {
		round: value.round,
		attempts: value.attempts,
		lastAttemptAt: value.lastAttemptAt,
	};
}

function parsePendingSwitchFailure(
	value: unknown,
): PendingSwitchFailure | null | undefined {
	if (value === undefined || value === null) return null;
	if (!isRecord(value) || !hasOnlyKeys(value, SWITCH_FAILURE_KEYS)) {
		return undefined;
	}
	const activeDelivery = parseSwitchFailureDelivery(value.activeDelivery);
	if (
		typeof value.reasonCode !== "string" ||
		value.reasonCode.length === 0 ||
		typeof value.degraded !== "boolean" ||
		!isIsoInstant(value.startedAt) ||
		!isNullableIsoInstant(value.lastConfirmedAlertAt) ||
		!isGeneration(value.alertCount) ||
		value.alertCount > 10 ||
		activeDelivery === undefined ||
		(activeDelivery !== null && activeDelivery.round !== value.alertCount)
	) {
		return undefined;
	}
	return {
		reasonCode: value.reasonCode,
		degraded: value.degraded,
		startedAt: value.startedAt,
		lastConfirmedAlertAt: value.lastConfirmedAlertAt,
		alertCount: value.alertCount,
		activeDelivery,
	};
}

function parseIdentityMismatchEpisodes(
	value: unknown,
): Record<string, IdentityMismatchEpisode> | null | undefined {
	if (value === undefined || value === null) return null;
	if (!isRecord(value) || Object.keys(value).length > 32) return undefined;
	const episodes: Record<string, IdentityMismatchEpisode> = {};
	for (const [label, raw] of Object.entries(value)) {
		if (
			!PROFILE_NAME.test(label) ||
			!isRecord(raw) ||
			!hasOnlyKeys(raw, IDENTITY_MISMATCH_EPISODE_KEYS)
		) {
			return undefined;
		}
		const activeDelivery = parseSwitchFailureDelivery(raw.activeDelivery);
		if (
			typeof raw.checkpoint !== "string" ||
			!IDENTITY_CHECKPOINTS.has(raw.checkpoint as IdentityMismatchCheckpoint) ||
			typeof raw.expectedKey !== "string" ||
			!DIGEST.test(raw.expectedKey) ||
			typeof raw.actualDigest !== "string" ||
			!DIGEST.test(raw.actualDigest) ||
			!isIsoInstant(raw.startedAt) ||
			!isNullableIsoInstant(raw.lastConfirmedAlertAt) ||
			!isGeneration(raw.alertCount) ||
			raw.alertCount > 10 ||
			!isGeneration(raw.round) ||
			raw.round < 1 ||
			activeDelivery === undefined ||
			(activeDelivery !== null && activeDelivery.round !== raw.round)
		) {
			return undefined;
		}
		episodes[label] = {
			checkpoint: raw.checkpoint as IdentityMismatchCheckpoint,
			expectedKey: raw.expectedKey,
			actualDigest: raw.actualDigest,
			startedAt: raw.startedAt,
			lastConfirmedAlertAt: raw.lastConfirmedAlertAt,
			alertCount: raw.alertCount,
			round: raw.round,
			activeDelivery,
		};
	}
	return Object.keys(episodes).length === 0 ? null : episodes;
}

function parseReviveEpoch(value: unknown): ReviveEpoch | null | undefined {
	if (value === null) return null;
	if (!isRecord(value) || !hasOnlyKeys(value, EPOCH_KEYS)) return undefined;
	if (
		value.open !== true ||
		typeof value.sourceAccount !== "string" ||
		!PROFILE_NAME.test(value.sourceAccount) ||
		!isGeneration(value.generation) ||
		!isNonNegativeNumber(value.openedAt) ||
		!isNonNegativeNumber(value.expiresAt) ||
		value.expiresAt <= value.openedAt ||
		!isRecord(value.panes)
	) {
		return undefined;
	}
	const panes: Record<string, RevivePaneAttempt> = {};
	for (const [key, attempt] of Object.entries(value.panes)) {
		if (
			key.length === 0 ||
			!isRecord(attempt) ||
			!hasOnlyKeys(attempt, ATTEMPT_KEYS) ||
			!Number.isInteger(attempt.attempts) ||
			!isNonNegativeNumber(attempt.attempts) ||
			attempt.attempts > 3 ||
			!isNonNegativeNumber(attempt.lastAttemptAt)
		) {
			return undefined;
		}
		panes[key] = {
			attempts: attempt.attempts,
			lastAttemptAt: attempt.lastAttemptAt,
		};
	}
	return {
		open: true,
		sourceAccount: value.sourceAccount,
		generation: value.generation,
		openedAt: value.openedAt,
		expiresAt: value.expiresAt,
		panes,
	};
}

function parseState(value: unknown): QuotaMonitorState | null {
	if (!isRecord(value) || !hasOnlyKeys(value, STATE_KEYS)) return null;
	const reviveEpoch = parseReviveEpoch(value.reviveEpoch);
	const blockedEpisode = parseBlockedEpisode(value.blockedEpisode);
	const pendingSwitchFailure = parsePendingSwitchFailure(
		value.pendingSwitchFailure,
	);
	const identityMismatchEpisodes = parseIdentityMismatchEpisodes(
		value.identityMismatchEpisodes,
	);
	const identityAlertCursor =
		value.identityAlertCursor === undefined ||
		value.identityAlertCursor === null
			? null
			: typeof value.identityAlertCursor === "string" &&
					PROFILE_NAME.test(value.identityAlertCursor)
				? value.identityAlertCursor
				: undefined;
	if (
		value.version !== 1 ||
		!isNullableTimestamp(value.lastPollAt) ||
		!isNullableTimestamp(value.lastSuccessfulUsageAt) ||
		!isGeneration(value.errorStreak) ||
		!isNonNegativeNumber(value.backoffUntilMs) ||
		(value.tier !== "base" && value.tier !== "accelerated") ||
		!isNullableTimestamp(value.lastCandidateSweepAt) ||
		!isNullableTimestamp(value.lastSwitchAt) ||
		!isGeneration(value.observedGeneration) ||
		reviveEpoch === undefined ||
		blockedEpisode === undefined ||
		pendingSwitchFailure === undefined ||
		identityMismatchEpisodes === undefined ||
		identityAlertCursor === undefined
	) {
		return null;
	}
	return {
		version: 1,
		lastPollAt: value.lastPollAt,
		lastSuccessfulUsageAt: value.lastSuccessfulUsageAt,
		errorStreak: value.errorStreak,
		backoffUntilMs: value.backoffUntilMs,
		tier: value.tier,
		lastCandidateSweepAt: value.lastCandidateSweepAt,
		lastSwitchAt: value.lastSwitchAt,
		observedGeneration: value.observedGeneration,
		reviveEpoch,
		blockedEpisode,
		pendingSwitchFailure,
		identityMismatchEpisodes,
		identityAlertCursor,
	};
}

function conservativeState(
	storeGeneration: number,
	nowMs: number,
): QuotaMonitorState {
	return {
		...emptyQuotaMonitorState(storeGeneration),
		lastSwitchAt: nowMs,
	};
}

export function loadQuotaMonitorState(
	path: string = defaultQuotaMonitorStatePath(),
	opts: LoadQuotaMonitorStateOptions,
): LoadedQuotaMonitorState {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return {
				state: conservativeState(opts.storeGeneration, opts.nowMs),
				recovery: "corrupt",
			};
		}
		if (opts.storeGeneration > 0) {
			return {
				state: conservativeState(opts.storeGeneration, opts.nowMs),
				recovery: "generation_advanced",
			};
		}
		return { state: emptyQuotaMonitorState(0), recovery: "missing" };
	}

	let state: QuotaMonitorState | null = null;
	try {
		state = parseState(JSON.parse(raw));
	} catch {
		// Classified below as corrupt without retaining parser details.
	}
	if (state === null || state.observedGeneration > opts.storeGeneration) {
		return {
			state: conservativeState(opts.storeGeneration, opts.nowMs),
			recovery: "corrupt",
		};
	}
	if (state.observedGeneration < opts.storeGeneration) {
		return {
			state: {
				...state,
				observedGeneration: opts.storeGeneration,
				lastSwitchAt: opts.nowMs,
				reviveEpoch: null,
				blockedEpisode: null,
				pendingSwitchFailure: null,
				identityMismatchEpisodes: null,
				identityAlertCursor: null,
			},
			recovery: "generation_advanced",
		};
	}
	return { state };
}

export function writeQuotaMonitorState(
	state: QuotaMonitorState,
	path: string = defaultQuotaMonitorStatePath(),
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}
