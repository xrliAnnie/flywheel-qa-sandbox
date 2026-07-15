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
		reviveEpoch === undefined
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
