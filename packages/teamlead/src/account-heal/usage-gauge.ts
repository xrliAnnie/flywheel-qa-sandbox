/**
 * FLY-696 M1/C2 — parse the Claude CLI status-bar usage gauge.
 *
 * Real committed pane (`usage-limit-real.txt`) renders, in its bottom live
 * region, a line of the exact form:
 *
 *   5h ██████████ 100% reset today 21:30  |  7d ████████░░ 82% reset Mon 09:00
 *
 * This is the CLI's own ground truth for the 5h-vs-weekly (7d) distinction and
 * the reset moments — nothing in the repo parses it today. `parseUsageGauge`
 * turns it into structured percentages + ABSOLUTE reset timestamps + which cap
 * (if any) is currently hit (`scope`).
 *
 * Timezone: the reset labels ("today 21:30", "Mon 09:00") are wall-clock in the
 * account's configured timezone (rendered elsewhere in the pane as
 * "reset at 9:00 PM (America/Chicago)"). The caller passes that IANA timezone;
 * conversion to an absolute instant is DST- and day-rollover-aware so
 * `quotaExhaustedUntil` never drifts across host timezones.
 *
 * Pure function — no IO, no clock read (both `now` and `timezone` are injected),
 * so it is fully deterministic and unit-testable.
 */

export type UsageScope = "5h" | "weekly" | "both" | null;

export interface UsageGauge {
	/** 5h (rolling-5-hour) usage percentage from the gauge. */
	fivehPct: number;
	/** 7d (rolling-week) usage percentage from the gauge. */
	weeklyPct: number;
	/** Absolute ISO reset time for the 5h window, or null if unresolved. */
	fivehResetAt: string | null;
	/** Absolute ISO reset time for the weekly window, or null if unresolved. */
	weeklyResetAt: string | null;
	/**
	 * Which limit is currently hit (>=100%). `both` when both are capped
	 * (selection treats weekly as dominant). `null` when the gauge parsed but
	 * neither is capped (ambiguous — the caller should fall to needs_human).
	 */
	scope: UsageScope;
	/** `high` when the gauge line and both reset moments resolved cleanly. */
	confidence: "high" | "low";
}

// The gauge line. Non-greedy `(.+?)` before `|` keeps the first reset label from
// swallowing the divider. Bars are U+2588 (full) / U+2591 (light-shade).
const GAUGE_RE =
	/5h\s+[█░]+\s+(\d+)%\s+reset\s+(.+?)\s*\|\s*7d\s+[█░]+\s+(\d+)%\s+reset\s+(.+?)\s*$/;

const WEEKDAY_INDEX: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
};

interface TzParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	weekday: string;
}

/** Break a UTC instant down into calendar/clock fields as seen in `timeZone`. */
function getTzParts(date: Date, timeZone: string): TzParts {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		weekday: "short",
	}).formatToParts(date);
	const get = (t: string): string =>
		parts.find((p) => p.type === t)?.value ?? "";
	return {
		year: Number(get("year")),
		month: Number(get("month")),
		day: Number(get("day")),
		// hour12:false can emit "24" at midnight in some engines.
		hour: Number(get("hour")) % 24,
		minute: Number(get("minute")),
		second: Number(get("second")),
		weekday: get("weekday"),
	};
}

/**
 * The UTC instant whose wall-clock in `timeZone` is (y, mo, d, hh, mm).
 * Single offset-correction pass (adequate outside the ~1h DST-fold ambiguity).
 */
function zonedWallClockToUtc(
	y: number,
	mo: number,
	d: number,
	hh: number,
	mm: number,
	timeZone: string,
): Date {
	const guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
	const seen = getTzParts(new Date(guess), timeZone);
	const seenAsUtc = Date.UTC(
		seen.year,
		seen.month - 1,
		seen.day,
		seen.hour,
		seen.minute,
		seen.second,
	);
	const offset = seenAsUtc - guess; // ms the zone is ahead of UTC at `guess`
	return new Date(guess - offset);
}

/** Calendar date `n` days after the tz-date of `now` (DST-safe via noon anchor). */
function tzDatePlusDays(
	now: Date,
	timeZone: string,
	n: number,
): { year: number; month: number; day: number } {
	const t = getTzParts(now, timeZone);
	const anchor = Date.UTC(t.year, t.month - 1, t.day, 12, 0, 0);
	const shifted = getTzParts(new Date(anchor + n * 86_400_000), timeZone);
	return { year: shifted.year, month: shifted.month, day: shifted.day };
}

/**
 * Resolve a gauge reset label ("today 21:30", "Mon 09:00", "tomorrow 09:00") to
 * an absolute ISO instant in `timeZone`, relative to `now`. Returns null if the
 * label is not in the expected `<day-token> HH:MM` shape.
 */
export function resolveResetAt(
	label: string,
	now: Date,
	timeZone: string,
): string | null {
	const m = label.trim().match(/^(\S+)\s+(\d{1,2}):(\d{2})$/);
	if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
		return null;
	}
	const dayTok = m[1].toLowerCase();
	const hh = Number(m[2]);
	const mm = Number(m[3]);
	if (hh > 23 || mm > 59) return null;

	if (dayTok === "today") {
		const t = getTzParts(now, timeZone);
		return zonedWallClockToUtc(
			t.year,
			t.month,
			t.day,
			hh,
			mm,
			timeZone,
		).toISOString();
	}
	if (dayTok === "tomorrow") {
		const t = tzDatePlusDays(now, timeZone, 1);
		return zonedWallClockToUtc(
			t.year,
			t.month,
			t.day,
			hh,
			mm,
			timeZone,
		).toISOString();
	}
	const targetIdx = WEEKDAY_INDEX[dayTok.slice(0, 3)];
	if (targetIdx === undefined) return null;
	const todayIdx =
		WEEKDAY_INDEX[getTzParts(now, timeZone).weekday.toLowerCase()];
	if (todayIdx === undefined) return null;
	const daysAhead = (targetIdx - todayIdx + 7) % 7;
	let cand = tzDatePlusDays(now, timeZone, daysAhead);
	let inst = zonedWallClockToUtc(
		cand.year,
		cand.month,
		cand.day,
		hh,
		mm,
		timeZone,
	);
	// Same-weekday but the time already passed today → it's next week.
	if (inst.getTime() <= now.getTime()) {
		cand = tzDatePlusDays(now, timeZone, daysAhead + 7);
		inst = zonedWallClockToUtc(
			cand.year,
			cand.month,
			cand.day,
			hh,
			mm,
			timeZone,
		);
	}
	return inst.toISOString();
}

/**
 * Parse the usage gauge out of a captured Claude pane. Returns null when no
 * gauge line is present (the caller treats that as ambiguous → needs_human).
 */
export function parseUsageGauge(
	pane: string,
	now: Date,
	timeZone: string,
): UsageGauge | null {
	let match: RegExpMatchArray | null = null;
	for (const line of pane.split("\n")) {
		const m = line.match(GAUGE_RE);
		if (m) {
			match = m;
			break;
		}
	}
	if (
		!match ||
		match[1] === undefined ||
		match[2] === undefined ||
		match[3] === undefined ||
		match[4] === undefined
	) {
		return null;
	}

	const fivehPct = Number(match[1]);
	const weeklyPct = Number(match[3]);
	const fivehResetAt = resolveResetAt(match[2], now, timeZone);
	const weeklyResetAt = resolveResetAt(match[4], now, timeZone);

	const scope: UsageScope =
		fivehPct >= 100 && weeklyPct >= 100
			? "both"
			: fivehPct >= 100
				? "5h"
				: weeklyPct >= 100
					? "weekly"
					: null;

	const confidence: "high" | "low" =
		fivehResetAt !== null && weeklyResetAt !== null ? "high" : "low";

	return {
		fivehPct,
		weeklyPct,
		fivehResetAt,
		weeklyResetAt,
		scope,
		confidence,
	};
}
