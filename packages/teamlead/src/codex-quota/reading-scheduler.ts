/**
 * FLY-2869 — keep the Codex quota readings from silently going stale.
 *
 * FLY-2688 deliberately read Codex accounts only when someone opened the
 * account page; on 2026-09-24 nobody did for five hours and every Codex
 * reading froze at 15:48 PDT. This scheduler rides the Bridge's existing poll
 * (no new timer): it starts a Codex round when one is due and, once it has
 * tried at least once, reports the reading pipeline's health to the durable
 * episode state machine that owns the "readings stopped" alert.
 */

import { codexReadingFreshness } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import type { CodexQuotaWindow } from "./candidate-selector.js";
import type { CodexAccountQuotaStore } from "./codex-account-quota-store.js";

export const CODEX_READING_REFRESH_INTERVAL_MS = 15 * 60_000;
/** Read again this long after a known exhausted reset instant. */
export const CODEX_READING_RESET_GRACE_MS = 60_000;
const FUTURE_SKEW_MS = 60_000;
const FAILURE_CODE = /^[a-z0-9_:.-]{1,80}$/i;

/** Next due instant: the regular interval, or just after an exhausted window resets. */
export function nextCodexReadingRefreshAt(
	store: CodexAccountQuotaStore | null,
	nowMs: number,
): number {
	let due = nowMs + CODEX_READING_REFRESH_INTERVAL_MS;
	for (const account of store?.accounts ?? []) {
		for (const window of [account.fiveH, account.weekly]) {
			if (window?.usedPercent !== 100 || window.resetAt === null) continue;
			const resetMs = Date.parse(window.resetAt);
			const candidate = resetMs + CODEX_READING_RESET_GRACE_MS;
			if (Number.isFinite(resetMs) && candidate > nowMs && candidate < due)
				due = candidate;
		}
	}
	return due;
}

/** Newest observation that is parseable and not from the future. */
export function latestCodexObservationAt(
	store: CodexAccountQuotaStore | null,
	nowMs: number,
): string | null {
	let latest: number | null = null;
	for (const account of store?.accounts ?? []) {
		if (account.observedAt === null) continue;
		const observedMs = Date.parse(account.observedAt);
		if (!Number.isFinite(observedMs) || observedMs > nowMs + FUTURE_SKEW_MS)
			continue;
		if (latest === null || observedMs > latest) latest = observedMs;
	}
	return latest === null ? null : new Date(latest).toISOString();
}

/**
 * The manual-switch N1 shows an account's weekly window only from a fresh
 * reading of that same login; anything else renders n/a.
 */
export function codexNotificationWindows(
	store: CodexAccountQuotaStore | null,
	profile: string,
	accountKey: string,
	nowMs: number,
): CodexQuotaWindow[] {
	const reading = store?.accounts.find(
		(account) => account.name === profile && account.identityKey === accountKey,
	);
	if (!reading?.weekly || codexReadingFreshness(reading, nowMs) !== "fresh")
		return [];
	const resetMs =
		reading.weekly.resetAt === null ? null : Date.parse(reading.weekly.resetAt);
	return [
		{
			usedPercent: reading.weekly.usedPercent,
			resetsAt: resetMs !== null && Number.isFinite(resetMs) ? resetMs : null,
		},
	];
}

export interface CodexReadingPipelineReport {
	nowIso: string;
	latestObservedAt: string | null;
	failureCode: string | null;
}

export interface CodexReadingSchedulerOptions {
	now?: () => number;
	/** The shared single-flight Codex round. */
	refresh(): Promise<unknown>;
	readStore(): CodexAccountQuotaStore | null;
	/** Durable episode state machine (CodexQuotaStore.observeCodexReadingPipeline). */
	observePipeline(report: CodexReadingPipelineReport): void;
	warn?(message: string, detail: string): void;
}

export function createCodexReadingScheduler(
	options: CodexReadingSchedulerOptions,
): { tick(): void } {
	const now = options.now ?? Date.now;
	const warn =
		options.warn ?? ((message, detail) => console.warn(message, detail));
	let nextDueAt = Number.NEGATIVE_INFINITY;
	let inFlight = false;
	let attempted = false;
	let lastFailure: string | null = null;

	const detail = (error: unknown) =>
		error instanceof Error ? error.message : String(error);
	const latest = (nowMs: number): string | null => {
		try {
			return latestCodexObservationAt(options.readStore(), nowMs);
		} catch (error) {
			warn("[Bridge] Codex reading store unreadable", detail(error));
			return null;
		}
	};
	const report = (nowMs: number) => {
		try {
			options.observePipeline({
				nowIso: new Date(nowMs).toISOString(),
				latestObservedAt: latest(nowMs),
				failureCode: lastFailure,
			});
		} catch (error) {
			warn("[Bridge] Codex reading pipeline report failed", detail(error));
		}
	};
	const start = (nowMs: number) => {
		inFlight = true;
		const before = latest(nowMs);
		let failure: string | null = null;
		let round: Promise<unknown>;
		try {
			round = Promise.resolve(options.refresh());
		} catch (error) {
			round = Promise.reject(error);
		}
		void round
			.then(
				() => {
					const after = latest(now());
					failure =
						after !== null &&
						(before === null || Date.parse(after) > Date.parse(before))
							? null
							: "no_observation_advanced";
				},
				(error: unknown) => {
					const message = error instanceof Error ? error.message : "";
					failure = FAILURE_CODE.test(message) ? message : "refresh_failed";
				},
			)
			.finally(() => {
				inFlight = false;
				attempted = true;
				lastFailure = failure;
				try {
					nextDueAt = nextCodexReadingRefreshAt(options.readStore(), now());
				} catch (error) {
					nextDueAt = now() + CODEX_READING_REFRESH_INTERVAL_MS;
					warn("[Bridge] Codex reading store unreadable", detail(error));
				}
				report(now());
			})
			.catch((error: unknown) => {
				warn("[Bridge] Codex reading scheduler failed", detail(error));
			});
	};

	return {
		tick() {
			try {
				const nowMs = now();
				if (!inFlight && nowMs >= nextDueAt) start(nowMs);
				if (attempted) report(nowMs);
			} catch (error) {
				warn("[Bridge] Codex reading scheduler failed", detail(error));
			}
		},
	};
}
