/**
 * FLY-2830 — "every Codex account is full" says which account comes back when.
 *
 * The snapshot is frozen in the same transaction that records the exhaustion
 * fact (codex-quota-store `recordPoolExhausted`) from exactly the observations
 * that proved it, and the founder alert is rendered from that payload only —
 * never from a later fact — so an ambiguous replay of the same event id says
 * word for word the same thing. Every persisted value is re-validated here.
 *
 * A recovery moment is claimed only when every 100% window of that account has
 * a known reset; the fleet's earliest recovery only when every account has one.
 * The retry schedule (`nextAttemptAt`) is never presented as a recovery time.
 */

import {
	isCodexIdentityLabel,
	isCodexSlotName,
} from "flywheel-claude-runner/bin/codex-account-core.mjs";
import type {
	CodexQuotaObservation,
	CodexQuotaWindow,
} from "./candidate-selector.js";

export const POOL_ALERT_MAX_ACCOUNTS = 16;
export const POOL_ALERT_MAX_WINDOWS = 4;
export const POOL_ALERT_MAX_BYTES = 8 * 1024;

export interface PoolExhaustedAlertAccount {
	profile: string;
	windows: CodexQuotaWindow[];
	reached: boolean;
	recoveryAt: number | null;
}

export interface PoolExhaustedAlertSnapshot {
	observedAt: number;
	accounts: PoolExhaustedAlertAccount[];
	earliestRecovery: { profile: string; at: number } | null;
}

function recoveryOf(windows: readonly CodexQuotaWindow[]): number | null {
	const full = windows.filter((window) => window.usedPercent >= 100);
	if (full.length === 0 || full.some((window) => window.resetsAt === null))
		return null;
	return Math.max(...full.map((window) => window.resetsAt!));
}

function earliestOf(
	accounts: readonly PoolExhaustedAlertAccount[],
): PoolExhaustedAlertSnapshot["earliestRecovery"] {
	if (
		accounts.length === 0 ||
		accounts.some((account) => account.recoveryAt === null)
	)
		return null;
	const first = [...accounts].sort(
		(a, b) =>
			a.recoveryAt! - b.recoveryAt! || a.profile.localeCompare(b.profile),
	)[0]!;
	return { profile: first.profile, at: first.recoveryAt! };
}

const validWindow = (window: unknown): window is CodexQuotaWindow =>
	typeof window === "object" &&
	window !== null &&
	!Array.isArray(window) &&
	Object.keys(window).length === 2 &&
	Number.isInteger((window as CodexQuotaWindow).usedPercent) &&
	(window as CodexQuotaWindow).usedPercent >= 0 &&
	(window as CodexQuotaWindow).usedPercent <= 100 &&
	((window as CodexQuotaWindow).resetsAt === null ||
		(Number.isSafeInteger((window as CodexQuotaWindow).resetsAt) &&
			((window as CodexQuotaWindow).resetsAt as number) >= 0));

/** Only a limited account belongs in a "every account is full" alert. */
const isFull = (account: {
	reached: boolean;
	windows: readonly CodexQuotaWindow[];
}) =>
	account.reached ||
	account.windows.some((window) => window.usedPercent >= 100);

/** Strictly ascending, hence also unique. */
const strictlySorted = (profiles: readonly string[]) =>
	profiles.every(
		(profile, index) =>
			index === 0 || profiles[index - 1]!.localeCompare(profile) < 0,
	);

/** Null (and the caller keeps the legacy text) when anything is out of bounds. */
export function buildPoolExhaustedAlertSnapshot(
	observations: readonly CodexQuotaObservation[],
	observedAt: number,
): PoolExhaustedAlertSnapshot | null {
	if (
		!Number.isSafeInteger(observedAt) ||
		observedAt < 0 ||
		observations.length === 0 ||
		observations.length > POOL_ALERT_MAX_ACCOUNTS
	)
		return null;
	const accounts: PoolExhaustedAlertAccount[] = [];
	for (const observation of [...observations].sort((a, b) =>
		a.profile.localeCompare(b.profile),
	)) {
		if (
			!isCodexSlotName(observation.profile) ||
			observation.windows.length > POOL_ALERT_MAX_WINDOWS ||
			!observation.windows.every(validWindow)
		)
			return null;
		const windows = observation.windows.map((window) => ({
			usedPercent: window.usedPercent,
			resetsAt: window.resetsAt,
		}));
		accounts.push({
			profile: observation.profile,
			windows,
			reached: observation.reached === true,
			recoveryAt: recoveryOf(windows),
		});
	}
	if (
		!strictlySorted(accounts.map((account) => account.profile)) ||
		!accounts.every(isFull)
	)
		return null;
	const snapshot = {
		observedAt,
		accounts,
		earliestRecovery: earliestOf(accounts),
	};
	return JSON.stringify(snapshot).length > POOL_ALERT_MAX_BYTES
		? null
		: snapshot;
}

/** Strict re-validation of a persisted snapshot; derived fields must agree. */
export function parsePoolExhaustedAlertSnapshot(
	value: unknown,
): PoolExhaustedAlertSnapshot | null {
	try {
		if (JSON.stringify(value).length > POOL_ALERT_MAX_BYTES) return null;
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	const raw = value as Record<string, unknown>;
	if (
		Object.keys(raw).length !== 3 ||
		!Number.isSafeInteger(raw.observedAt) ||
		(raw.observedAt as number) < 0 ||
		!Array.isArray(raw.accounts) ||
		raw.accounts.length === 0 ||
		raw.accounts.length > POOL_ALERT_MAX_ACCOUNTS
	)
		return null;
	const accounts: PoolExhaustedAlertAccount[] = [];
	for (const entry of raw.accounts as unknown[]) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry))
			return null;
		const account = entry as Record<string, unknown>;
		if (
			Object.keys(account).length !== 4 ||
			!isCodexSlotName(account.profile) ||
			!Array.isArray(account.windows) ||
			account.windows.length > POOL_ALERT_MAX_WINDOWS ||
			!account.windows.every(validWindow) ||
			typeof account.reached !== "boolean"
		)
			return null;
		const windows = account.windows as CodexQuotaWindow[];
		if (account.recoveryAt !== recoveryOf(windows)) return null;
		if (!isFull({ reached: account.reached, windows })) return null;
		accounts.push({
			profile: account.profile as string,
			windows,
			reached: account.reached,
			recoveryAt: account.recoveryAt as number | null,
		});
	}
	if (!strictlySorted(accounts.map((account) => account.profile))) return null;
	const earliest = earliestOf(accounts);
	const stored = raw.earliestRecovery as
		| { profile?: unknown; at?: unknown }
		| null
		| undefined;
	if (
		earliest === null
			? stored !== null
			: stored === null ||
				typeof stored !== "object" ||
				Object.keys(stored).length !== 2 ||
				stored.profile !== earliest.profile ||
				stored.at !== earliest.at
	)
		return null;
	return {
		observedAt: raw.observedAt as number,
		accounts,
		earliestRecovery: earliest,
	};
}

function formatMoment(ms: number, timezone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(new Date(ms))
			.map((part) => [part.type, part.value]),
	);
	return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * The legacy trigger/run line, frozen with the fact (FLY-2830 R1): rendering
 * it from live targets would change the text of a replay once runs recover.
 */
export interface PoolExhaustedAlertDetails {
	source: string;
	resetAt: string | null;
	target: string;
	affectedRuns: number;
	restartedRuns: number;
}

const MAX_RUNS = 10_000;

export function parsePoolExhaustedAlertDetails(
	value: unknown,
): PoolExhaustedAlertDetails | null {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	const raw = value as Record<string, unknown>;
	const count = (n: unknown) =>
		Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= MAX_RUNS;
	if (
		Object.keys(raw).length !== 5 ||
		!(raw.source === "unknown" || isCodexIdentityLabel(raw.source)) ||
		!(raw.target === "none" || isCodexSlotName(raw.target)) ||
		!(
			raw.resetAt === null ||
			(typeof raw.resetAt === "string" &&
				Number.isFinite(Date.parse(raw.resetAt)) &&
				new Date(Date.parse(raw.resetAt)).toISOString() === raw.resetAt)
		) ||
		!count(raw.affectedRuns) ||
		!count(raw.restartedRuns) ||
		(raw.restartedRuns as number) > (raw.affectedRuns as number)
	)
		return null;
	return {
		source: raw.source as string,
		resetAt: raw.resetAt as string | null,
		target: raw.target as string,
		affectedRuns: raw.affectedRuns as number,
		restartedRuns: raw.restartedRuns as number,
	};
}

export function formatPoolExhaustedAlert(
	snapshot: PoolExhaustedAlertSnapshot,
	timezone: string,
	details: PoolExhaustedAlertDetails | null = null,
): string {
	const zone = timezone === "America/Los_Angeles" ? "PT" : timezone;
	const rows = snapshot.accounts.map((account) => {
		const windows =
			account.windows.length === 0
				? "读不到"
				: account.windows
						.map(
							(window) =>
								`${window.usedPercent}% · ${
									window.resetsAt === null
										? "重置未知"
										: `${formatMoment(window.resetsAt, timezone)} 重置`
								}`,
						)
						.join("；");
		const recovery =
			account.recoveryAt !== null
				? formatMoment(account.recoveryAt, timezone)
				: account.windows.some((window) => window.usedPercent >= 100)
					? "无法确定（接口未给重置时间）"
					: "无法确定（被判打满但没有 100% 窗口）";
		// Discord renders no tables (founder rule): one plain line per account.
		return `- ${account.profile}：${windows} → 恢复${account.recoveryAt !== null ? " " : ""}${recovery}`;
	});
	const earliest =
		snapshot.earliestRecovery === null
			? "最早可恢复：无法确定（有账号没给重置时间）。也可以兑一张重置卡。"
			: `最早可恢复：${formatMoment(snapshot.earliestRecovery.at, timezone)}（${snapshot.earliestRecovery.profile}）。也可以兑一张重置卡。`;
	return [
		"Codex 全部账号都已打满，暂停自动切号，不做盲目替换。",
		`各号用量与重置（${zone}）：`,
		...rows,
		earliest,
		...(details === null
			? []
			: [
					`Trigger=usageLimited from=${details.source} reset=${details.resetAt ?? "unknown"} to=${details.target} affected_runs=${details.affectedRuns} restarted_runs=${details.restartedRuns}`,
				]),
	].join("\n");
}
