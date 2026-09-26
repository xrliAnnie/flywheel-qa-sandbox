/**
 * FLY-2897 — read the receipt mailboxes at least once a day, and again early
 * on the morning after a charge day the last round could not have seen.
 *
 * Rides the Bridge's existing GatePoller tick like the FLY-2869 Codex reading
 * scheduler (no new timer). The due instant is cached in memory and the store
 * is re-read only when that instant arrives, so a 3 s tick does no file I/O.
 * A failed round is retried no sooner than `minRetryMs`, so a broken mailbox
 * or account list never turns into a read-every-tick loop.
 */

import type { ClaudeChargeStore } from "./charge-receipt-store.js";

export const CLAUDE_CHARGE_REFRESH_INTERVAL_MS = 24 * 3_600_000;
export const CLAUDE_CHARGE_MIN_RETRY_MS = 30 * 60_000;
/**
 * The switch and on-demand refreshes also write the store; re-derive the due
 * instant this often so a write that made it earlier is seen in minutes.
 */
export const CLAUDE_CHARGE_RECHECK_MS = 5 * 60_000;
const FUTURE_SKEW_MS = 60_000;
const CODE = /^[a-z0-9_:.-]{1,60}$/;

const PACIFIC = "America/Los_Angeles";

function pacificParts(ms: number): Record<string, number> {
	return Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: PACIFIC,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(new Date(ms))
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, Number(part.value)]),
	);
}

function pacificDay(ms: number): string {
	const parts = pacificParts(ms);
	return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Pacific wall-clock minus UTC at `ms`, in milliseconds (−7 h or −8 h). */
function pacificOffsetMs(ms: number): number {
	const p = pacificParts(ms);
	return (
		Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) -
		Math.floor(ms / 60_000) * 60_000
	);
}

/** 00:05 America/Los_Angeles on the day after `day`, in PST or PDT. */
function morningAfter(day: string): number {
	const [year, month, date] = day.split("-").map(Number) as [
		number,
		number,
		number,
	];
	const wall = Date.UTC(year, month - 1, date + 1, 0, 5);
	// Two passes settle the offset even next to a DST switch.
	const first = wall - pacificOffsetMs(wall);
	return wall - pacificOffsetMs(first);
}

export function nextClaudeChargeDueAt(
	store: ClaudeChargeStore | null,
	nowMs: number,
): number {
	if (store === null) return nowMs;
	const instants = [
		store.generatedAt,
		...store.accounts.flatMap((reading) =>
			reading.lastGood === null
				? [reading.readAt]
				: [reading.readAt, reading.lastGood.readAt],
		),
	].map((iso) => Date.parse(iso));
	if (
		instants.some((ms) => !Number.isFinite(ms) || ms > nowMs + FUTURE_SKEW_MS)
	)
		return nowMs;
	let due = Date.parse(store.generatedAt) + CLAUDE_CHARGE_REFRESH_INTERVAL_MS;
	for (const reading of store.accounts) {
		if (reading.facts === null) continue;
		const { periodEnd } = reading.facts;
		if (pacificDay(Date.parse(reading.readAt)) > periodEnd) continue;
		due = Math.min(due, morningAfter(periodEnd));
	}
	return due;
}

export interface ClaudeChargeSchedulerOptions {
	now?: () => number;
	/** The shared single-flight receipt round. */
	refresh(): Promise<unknown>;
	readStore(): ClaudeChargeStore | null;
	minRetryMs?: number;
	warn?(line: string): void;
}

export function createClaudeChargeScheduler(
	options: ClaudeChargeSchedulerOptions,
): { tick(): void } {
	const now = options.now ?? Date.now;
	const minRetryMs = options.minRetryMs ?? CLAUDE_CHARGE_MIN_RETRY_MS;
	const warn = options.warn ?? ((line: string) => console.warn(line));
	let nextDueAt: number | null = null;
	let computedAt = Number.NEGATIVE_INFINITY;
	let lastStartedAt = Number.NEGATIVE_INFINITY;
	let inFlight = false;

	const dueAt = (nowMs: number): number => {
		try {
			return nextClaudeChargeDueAt(options.readStore(), nowMs);
		} catch {
			warn("[claude-charge] store unreadable");
			return nowMs;
		}
	};

	const start = (nowMs: number) => {
		inFlight = true;
		lastStartedAt = nowMs;
		let round: Promise<unknown>;
		try {
			round = Promise.resolve(options.refresh());
		} catch (error) {
			round = Promise.reject(error);
		}
		void round
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : "";
				warn(
					`[claude-charge] scheduled refresh failed: ${CODE.test(message) ? message : "error"}`,
				);
			})
			.finally(() => {
				inFlight = false;
				nextDueAt = dueAt(now());
				computedAt = now();
			});
	};

	return {
		tick() {
			try {
				const nowMs = now();
				if (inFlight) return;
				// Backing off after a round: nothing can start, so read nothing.
				if (nowMs - lastStartedAt < minRetryMs) return;
				// Re-derive when unknown, stale, or due: another trigger (switch,
				// on-demand) may have rewritten the store in the meantime.
				if (
					nextDueAt === null ||
					nowMs >= nextDueAt ||
					nowMs - computedAt >= CLAUDE_CHARGE_RECHECK_MS
				) {
					nextDueAt = dueAt(nowMs);
					computedAt = nowMs;
				}
				if (nowMs < nextDueAt) return;
				start(nowMs);
			} catch {
				warn("[claude-charge] scheduler tick failed");
			}
		},
	};
}
