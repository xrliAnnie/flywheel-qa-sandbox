import { Buffer } from "node:buffer";
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
import { canonicalizeModels } from "./quota-trigger.js";

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
	trigger?:
		| { kind: "account" }
		| { kind: "model"; models: readonly [string, ...string[]] };
	panes: Record<string, RevivePaneAttempt>;
}

export interface AffectedPane {
	socket: string;
	paneId: string;
	panePid: number;
	/** Display metadata only; never used as pane instance authority. */
	sessionName: string;
	/** Display metadata only; may contain the Linear issue identifier. */
	windowName: string;
}

export interface ModelDetectionIntent {
	eventId: string;
	observedGeneration: number;
	observedAt: number;
	sourceAccount: string;
	models: readonly [string, ...string[]];
	affectedPanes: AffectedPane[];
}

export interface DurableAlertIntent {
	eventId: string;
	generation: number;
	createdAt: number;
	alert: {
		kind: string;
		severity: "info" | "warning" | "severe";
		title: string;
		body: string;
		signature: string;
	};
}

export interface ConfirmationIntent {
	eventId: string;
	generation: number;
	dueAt: number;
	sourceAccount: string;
	targetAccount: string;
	models: readonly [string, ...string[]];
	affectedPanes: AffectedPane[];
}

export interface UnknownPaneObservation {
	count: number;
	lastSeenAt: number;
}

/**
 * Pane-instance/model pairs already attributed to a completed model switch.
 * They remain suppressed until a complete scan proves that exact pane cleared
 * or disappeared, so a stale runner token cannot bench each newly active
 * machine account in sequence.
 */
export interface ModelPaneSuppression {
	models: readonly [string, ...string[]];
	lastSeenAt: number;
}

export type ModelPaneSuppressions = Record<string, ModelPaneSuppression>;

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
	applyExitCode?: number | null;
	childStarted?: boolean | null;
	detail?: string;
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
	version: 2;
	lastPollAt: number | null;
	lastSuccessfulUsageAt: number | null;
	errorStreak: number;
	backoffUntilMs: number;
	nextUsageDueAt: number;
	nextPaneScanDueAt: number;
	confirmDueAt: number | null;
	tier: "base" | "accelerated";
	lastCandidateSweepAt: number | null;
	lastSwitchAt: number | null;
	observedGeneration: number;
	reviveEpoch: ReviveEpoch | null;
	pendingDetection: ModelDetectionIntent | null;
	alertOutbox: DurableAlertIntent[];
	confirmation: ConfirmationIntent | null;
	unknownPanes: Record<string, UnknownPaneObservation>;
	modelPaneSuppressions: ModelPaneSuppressions;
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
	recovery?: "missing" | "corrupt" | "generation_advanced" | "migrated_v1";
};

const PROFILE_NAME = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;
const V1_STATE_KEYS = new Set([
	"version",
	"lastPollAt",
	"lastSuccessfulUsageAt",
	"errorStreak",
	"backoffUntilMs",
	"nextUsageDueAt",
	"nextPaneScanDueAt",
	"confirmDueAt",
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
const V2_STATE_KEYS = new Set([
	...V1_STATE_KEYS,
	"pendingDetection",
	"alertOutbox",
	"confirmation",
	"unknownPanes",
	"modelPaneSuppressions",
]);
const EPOCH_KEYS = new Set([
	"open",
	"sourceAccount",
	"generation",
	"openedAt",
	"expiresAt",
	"trigger",
	"panes",
]);
const TRIGGER_KEYS = new Set(["kind", "models"]);
const ATTEMPT_KEYS = new Set(["attempts", "lastAttemptAt"]);
const DETECTION_KEYS = new Set([
	"eventId",
	"observedGeneration",
	"observedAt",
	"sourceAccount",
	"models",
	"affectedPanes",
]);
const AFFECTED_PANE_KEYS = new Set([
	"socket",
	"paneId",
	"panePid",
	"sessionName",
	"windowName",
]);
const OUTBOX_KEYS = new Set(["eventId", "generation", "createdAt", "alert"]);
const ALERT_KEYS = new Set(["kind", "severity", "title", "body", "signature"]);
const CONFIRMATION_KEYS = new Set([
	"eventId",
	"generation",
	"dueAt",
	"sourceAccount",
	"targetAccount",
	"models",
	"affectedPanes",
]);
const UNKNOWN_PANE_KEYS = new Set(["count", "lastSeenAt"]);
const MODEL_SUPPRESSION_KEYS = new Set(["models", "lastSeenAt"]);
const MAX_AFFECTED_PANES = 64;
const MAX_ALERT_OUTBOX = 64;
const MAX_UNKNOWN_PANES = 64;
export const MAX_MODEL_PANE_SUPPRESSIONS = 1_024;
export const MAX_UNKNOWN_PANE_COUNT = 3;
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
	"applyExitCode",
	"childStarted",
	"detail",
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

const REVIVE_GRACE_MS = 30 * 60_000;

export function computeModelReviveExpiresAt(
	benchUntilByModel: Record<string, string>,
	openedAt: number,
): number | null {
	const benches = Object.values(benchUntilByModel);
	if (benches.length === 0) return null;
	const deadlines = benches.map((until) => Date.parse(until));
	if (deadlines.some((deadline) => !Number.isFinite(deadline))) return null;
	const expiresAt = Math.max(...deadlines) + REVIVE_GRACE_MS;
	return Number.isFinite(expiresAt) && expiresAt > openedAt ? expiresAt : null;
}

export function emptyQuotaMonitorState(
	observedGeneration = 0,
): QuotaMonitorState {
	return {
		version: 2,
		lastPollAt: null,
		lastSuccessfulUsageAt: null,
		errorStreak: 0,
		backoffUntilMs: 0,
		nextUsageDueAt: 0,
		nextPaneScanDueAt: 0,
		confirmDueAt: null,
		tier: "base",
		lastCandidateSweepAt: null,
		lastSwitchAt: null,
		observedGeneration,
		reviveEpoch: null,
		pendingDetection: null,
		alertOutbox: [],
		confirmation: null,
		unknownPanes: {},
		modelPaneSuppressions: {},
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

function parseReviveTrigger(value: unknown): ReviveEpoch["trigger"] | null {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !hasOnlyKeys(value, TRIGGER_KEYS)) return null;
	if (value.kind === "account" && value.models === undefined) {
		return { kind: "account" };
	}
	if (
		value.kind !== "model" ||
		!Array.isArray(value.models) ||
		!value.models.every((model) => typeof model === "string")
	) {
		return null;
	}
	const models = canonicalizeModels(value.models as string[]);
	if (
		models === null ||
		JSON.stringify(models) !== JSON.stringify(value.models)
	) {
		return null;
	}
	return { kind: "model", models };
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
		(value.applyExitCode !== undefined &&
			value.applyExitCode !== null &&
			(typeof value.applyExitCode !== "number" ||
				!Number.isInteger(value.applyExitCode))) ||
		(value.childStarted !== undefined &&
			value.childStarted !== null &&
			typeof value.childStarted !== "boolean") ||
		(value.detail !== undefined &&
			(typeof value.detail !== "string" ||
				Buffer.byteLength(value.detail, "utf8") > 600 ||
				/\p{Cc}/u.test(value.detail) ||
				Buffer.from(value.detail, "utf8").toString("utf8") !== value.detail)) ||
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
		...(value.applyExitCode === undefined
			? {}
			: { applyExitCode: value.applyExitCode }),
		...(value.childStarted === undefined
			? {}
			: { childStarted: value.childStarted }),
		...(value.detail === undefined ? {} : { detail: value.detail }),
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
	const trigger = parseReviveTrigger(value.trigger);
	if (
		value.open !== true ||
		typeof value.sourceAccount !== "string" ||
		!PROFILE_NAME.test(value.sourceAccount) ||
		!isGeneration(value.generation) ||
		!isNonNegativeNumber(value.openedAt) ||
		!isNonNegativeNumber(value.expiresAt) ||
		value.expiresAt <= value.openedAt ||
		trigger === null ||
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
		...(trigger === undefined ? {} : { trigger }),
		panes,
	};
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maxLength
	);
}

function parseCanonicalModels(
	value: unknown,
): readonly [string, ...string[]] | null {
	if (
		!Array.isArray(value) ||
		!value.every((model) => typeof model === "string")
	) {
		return null;
	}
	const models = canonicalizeModels(value as string[]);
	if (models === null || JSON.stringify(models) !== JSON.stringify(value)) {
		return null;
	}
	return models;
}

export function affectedPaneInstanceKey(pane: AffectedPane): string {
	return `${pane.socket}:${pane.paneId}:${pane.panePid}`;
}

export function updateUnknownPaneObservations(
	previous: Readonly<Record<string, UnknownPaneObservation>>,
	observedPaneKeys: readonly string[],
	nowMs: number,
): Record<string, UnknownPaneObservation> {
	const unique = [
		...new Set(
			observedPaneKeys.filter((key) => key.length > 0 && key.length <= 512),
		),
	];
	unique.sort((a, b) => {
		const aPrevious = previous[a]?.lastSeenAt ?? Number.NEGATIVE_INFINITY;
		const bPrevious = previous[b]?.lastSeenAt ?? Number.NEGATIVE_INFINITY;
		return bPrevious - aPrevious || (a < b ? -1 : a > b ? 1 : 0);
	});
	const next: Record<string, UnknownPaneObservation> = {};
	for (const key of unique.slice(0, MAX_UNKNOWN_PANES)) {
		next[key] = {
			count: Math.min((previous[key]?.count ?? 0) + 1, MAX_UNKNOWN_PANE_COUNT),
			lastSeenAt: nowMs,
		};
	}
	return next;
}

function parseAffectedPanes(value: unknown): AffectedPane[] | null {
	if (!Array.isArray(value) || value.length > MAX_AFFECTED_PANES) return null;
	const panes: AffectedPane[] = [];
	const identities = new Set<string>();
	for (const raw of value) {
		if (
			!isRecord(raw) ||
			!hasOnlyKeys(raw, AFFECTED_PANE_KEYS) ||
			!isBoundedString(raw.socket, 128) ||
			typeof raw.paneId !== "string" ||
			!/^%\d+$/.test(raw.paneId) ||
			!Number.isInteger(raw.panePid) ||
			!isNonNegativeNumber(raw.panePid) ||
			raw.panePid === 0 ||
			!isBoundedString(raw.sessionName, 256) ||
			!isBoundedString(raw.windowName, 256)
		) {
			return null;
		}
		const pane: AffectedPane = {
			socket: raw.socket,
			paneId: raw.paneId,
			panePid: raw.panePid,
			sessionName: raw.sessionName,
			windowName: raw.windowName,
		};
		const identity = affectedPaneInstanceKey(pane);
		if (identities.has(identity)) return null;
		identities.add(identity);
		panes.push(pane);
	}
	return panes;
}

function parseDetection(
	value: unknown,
): ModelDetectionIntent | null | undefined {
	if (value === null) return null;
	if (!isRecord(value) || !hasOnlyKeys(value, DETECTION_KEYS)) return undefined;
	const models = parseCanonicalModels(value.models);
	const affectedPanes = parseAffectedPanes(value.affectedPanes);
	if (
		!isBoundedString(value.eventId, 256) ||
		!isGeneration(value.observedGeneration) ||
		!isNonNegativeNumber(value.observedAt) ||
		typeof value.sourceAccount !== "string" ||
		!PROFILE_NAME.test(value.sourceAccount) ||
		models === null ||
		affectedPanes === null ||
		affectedPanes.length === 0
	) {
		return undefined;
	}
	return {
		eventId: value.eventId,
		observedGeneration: value.observedGeneration,
		observedAt: value.observedAt,
		sourceAccount: value.sourceAccount,
		models,
		affectedPanes,
	};
}

function parseAlertOutbox(value: unknown): DurableAlertIntent[] | null {
	if (!Array.isArray(value) || value.length > MAX_ALERT_OUTBOX) return null;
	const outbox: DurableAlertIntent[] = [];
	const eventIds = new Set<string>();
	for (const raw of value) {
		if (
			!isRecord(raw) ||
			!hasOnlyKeys(raw, OUTBOX_KEYS) ||
			!isBoundedString(raw.eventId, 256) ||
			!isGeneration(raw.generation) ||
			!isNonNegativeNumber(raw.createdAt) ||
			!isRecord(raw.alert) ||
			!hasOnlyKeys(raw.alert, ALERT_KEYS) ||
			!isBoundedString(raw.alert.kind, 64) ||
			!/^[a-z][a-z0-9_]*$/.test(raw.alert.kind) ||
			(raw.alert.severity !== "info" &&
				raw.alert.severity !== "warning" &&
				raw.alert.severity !== "severe") ||
			!isBoundedString(raw.alert.title, 512) ||
			!isBoundedString(raw.alert.body, 16_000) ||
			!isBoundedString(raw.alert.signature, 512) ||
			eventIds.has(raw.eventId)
		) {
			return null;
		}
		eventIds.add(raw.eventId);
		outbox.push({
			eventId: raw.eventId,
			generation: raw.generation,
			createdAt: raw.createdAt,
			alert: {
				kind: raw.alert.kind,
				severity: raw.alert.severity,
				title: raw.alert.title,
				body: raw.alert.body,
				signature: raw.alert.signature,
			},
		});
	}
	return outbox;
}

function parseConfirmation(
	value: unknown,
): ConfirmationIntent | null | undefined {
	if (value === null) return null;
	if (!isRecord(value) || !hasOnlyKeys(value, CONFIRMATION_KEYS)) {
		return undefined;
	}
	const models = parseCanonicalModels(value.models);
	const affectedPanes = parseAffectedPanes(value.affectedPanes);
	if (
		!isBoundedString(value.eventId, 256) ||
		!isGeneration(value.generation) ||
		!isNonNegativeNumber(value.dueAt) ||
		typeof value.sourceAccount !== "string" ||
		!PROFILE_NAME.test(value.sourceAccount) ||
		typeof value.targetAccount !== "string" ||
		!PROFILE_NAME.test(value.targetAccount) ||
		models === null ||
		affectedPanes === null ||
		affectedPanes.length === 0
	) {
		return undefined;
	}
	return {
		eventId: value.eventId,
		generation: value.generation,
		dueAt: value.dueAt,
		sourceAccount: value.sourceAccount,
		targetAccount: value.targetAccount,
		models,
		affectedPanes,
	};
}

function parseUnknownPanes(
	value: unknown,
): Record<string, UnknownPaneObservation> | null {
	if (!isRecord(value) || Object.keys(value).length > MAX_UNKNOWN_PANES) {
		return null;
	}
	const unknownPanes: Record<string, UnknownPaneObservation> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (
			!isBoundedString(key, 512) ||
			!isRecord(raw) ||
			!hasOnlyKeys(raw, UNKNOWN_PANE_KEYS) ||
			!Number.isInteger(raw.count) ||
			!isNonNegativeNumber(raw.count) ||
			raw.count === 0 ||
			raw.count > MAX_UNKNOWN_PANE_COUNT ||
			!isNonNegativeNumber(raw.lastSeenAt)
		) {
			return null;
		}
		unknownPanes[key] = { count: raw.count, lastSeenAt: raw.lastSeenAt };
	}
	return unknownPanes;
}

function parseModelPaneSuppressions(
	value: unknown,
): ModelPaneSuppressions | null {
	if (
		!isRecord(value) ||
		Object.keys(value).length > MAX_MODEL_PANE_SUPPRESSIONS
	) {
		return null;
	}
	const suppressions: ModelPaneSuppressions = {};
	for (const [key, raw] of Object.entries(value)) {
		if (
			!isBoundedString(key, 512) ||
			!isRecord(raw) ||
			!hasOnlyKeys(raw, MODEL_SUPPRESSION_KEYS)
		) {
			return null;
		}
		const models = parseCanonicalModels(raw.models);
		if (models === null || !isNonNegativeNumber(raw.lastSeenAt)) return null;
		suppressions[key] = { models, lastSeenAt: raw.lastSeenAt };
	}
	return suppressions;
}

function parseState(
	value: unknown,
): { state: QuotaMonitorState; migrated: boolean } | null {
	if (!isRecord(value)) return null;
	const isV1 = value.version === 1;
	if (!hasOnlyKeys(value, isV1 ? V1_STATE_KEYS : V2_STATE_KEYS)) return null;
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
		(value.version !== 1 && value.version !== 2) ||
		!isNullableTimestamp(value.lastPollAt) ||
		!isNullableTimestamp(value.lastSuccessfulUsageAt) ||
		!isGeneration(value.errorStreak) ||
		!isNonNegativeNumber(value.backoffUntilMs) ||
		(value.nextUsageDueAt !== undefined &&
			!isNonNegativeNumber(value.nextUsageDueAt)) ||
		(value.nextPaneScanDueAt !== undefined &&
			!isNonNegativeNumber(value.nextPaneScanDueAt)) ||
		(value.confirmDueAt !== undefined &&
			!isNullableTimestamp(value.confirmDueAt)) ||
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
	const pendingDetection = isV1 ? null : parseDetection(value.pendingDetection);
	const alertOutbox = isV1 ? [] : parseAlertOutbox(value.alertOutbox);
	const confirmation = isV1 ? null : parseConfirmation(value.confirmation);
	const unknownPanes = isV1 ? {} : parseUnknownPanes(value.unknownPanes);
	const modelPaneSuppressions = isV1
		? {}
		: value.modelPaneSuppressions === undefined
			? {}
			: parseModelPaneSuppressions(value.modelPaneSuppressions);
	if (
		pendingDetection === undefined ||
		alertOutbox === null ||
		confirmation === undefined ||
		unknownPanes === null ||
		modelPaneSuppressions === null
	) {
		return null;
	}
	return {
		migrated: isV1,
		state: {
			version: 2,
			lastPollAt: value.lastPollAt,
			lastSuccessfulUsageAt: value.lastSuccessfulUsageAt,
			errorStreak: value.errorStreak,
			backoffUntilMs: value.backoffUntilMs,
			nextUsageDueAt: value.nextUsageDueAt ?? 0,
			nextPaneScanDueAt: value.nextPaneScanDueAt ?? 0,
			confirmDueAt: value.confirmDueAt ?? null,
			tier: value.tier,
			lastCandidateSweepAt: value.lastCandidateSweepAt,
			lastSwitchAt: value.lastSwitchAt,
			observedGeneration: value.observedGeneration,
			reviveEpoch,
			pendingDetection,
			alertOutbox,
			confirmation,
			unknownPanes,
			modelPaneSuppressions,
			blockedEpisode,
			pendingSwitchFailure,
			identityMismatchEpisodes,
			identityAlertCursor,
		},
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

	let parsed: { state: QuotaMonitorState; migrated: boolean } | null = null;
	try {
		parsed = parseState(JSON.parse(raw));
	} catch {
		// Classified below as corrupt without retaining parser details.
	}
	if (
		parsed === null ||
		parsed.state.observedGeneration > opts.storeGeneration
	) {
		return {
			state: conservativeState(opts.storeGeneration, opts.nowMs),
			recovery: "corrupt",
		};
	}
	const state = parsed.state;
	if (state.observedGeneration < opts.storeGeneration) {
		return {
			state: {
				...state,
				observedGeneration: opts.storeGeneration,
				lastSwitchAt: opts.nowMs,
				reviveEpoch: null,
				pendingDetection:
					state.pendingDetection !== null &&
					state.pendingDetection.observedGeneration + 1 === opts.storeGeneration
						? state.pendingDetection
						: null,
				confirmation:
					state.confirmation?.generation === opts.storeGeneration
						? state.confirmation
						: null,
				blockedEpisode: null,
				pendingSwitchFailure: null,
				identityMismatchEpisodes: null,
				identityAlertCursor: null,
			},
			recovery: "generation_advanced",
		};
	}
	return parsed.migrated ? { state, recovery: "migrated_v1" } : { state };
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
