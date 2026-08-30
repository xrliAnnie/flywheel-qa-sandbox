const FAILURE_RAW_MAX = 4_000;
const MAX_RESET_HORIZON_MS = 8 * 24 * 60 * 60_000;

const API_RATE_LIMIT_RE = /"api_error_status"\s*:\s*429(?:\D|$)/;
const QUOTA_RESULT_RE =
	/You've hit your (session|weekly) limit\s*·\s*resets\s+(?:(?<month>[A-Za-z]{3})\s+(?<day>\d{1,2})\s+at\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?(?<meridiem>am|pm)\s+\((?<timezone>[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)+)\)(?:\s*·\s*progress saved)?/i;

const MONTH_INDEX: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

function zonedParts(epochMs: number, timeZone: string): ZonedParts | null {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).formatToParts(new Date(epochMs));
		const value = (type: Intl.DateTimeFormatPartTypes) =>
			parts.find((part) => part.type === type)?.value ?? "";
		return {
			year: Number(value("year")),
			month: Number(value("month")),
			day: Number(value("day")),
			hour: Number(value("hour")) % 24,
			minute: Number(value("minute")),
		};
	} catch {
		return null;
	}
}

function zonedWallClockToEpoch(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string,
): number | null {
	const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
	let candidate = wantedAsUtc;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const seen = zonedParts(candidate, timeZone);
		if (!seen) return null;
		const seenAsUtc = Date.UTC(
			seen.year,
			seen.month - 1,
			seen.day,
			seen.hour,
			seen.minute,
			0,
		);
		candidate += wantedAsUtc - seenAsUtc;
	}
	const verified = zonedParts(candidate, timeZone);
	if (
		!verified ||
		verified.year !== year ||
		verified.month !== month ||
		verified.day !== day ||
		verified.hour !== hour ||
		verified.minute !== minute
	) {
		return null;
	}
	return candidate;
}

function nextCalendarDay(parts: ZonedParts): ZonedParts {
	const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
	return {
		year: next.getUTCFullYear(),
		month: next.getUTCMonth() + 1,
		day: next.getUTCDate(),
		hour: parts.hour,
		minute: parts.minute,
	};
}

/**
 * Parse the bounded, un-composed stdout tail from a failed headless Claude
 * review. A genuine subscription cap requires BOTH the 429 envelope field and
 * the observed session/weekly result marker. Ambiguous evidence returns null.
 */
export function parseReviewQuotaResetAt(
	raw: string | undefined,
	nowMs: number,
): number | null {
	if (!raw || !Number.isFinite(nowMs)) return null;
	const evidence = raw.slice(-FAILURE_RAW_MAX);
	if (!API_RATE_LIMIT_RE.test(evidence)) return null;
	const match = QUOTA_RESULT_RE.exec(evidence);
	if (!match?.groups) return null;
	const {
		day: dayText,
		hour: hourText,
		meridiem,
		month: monthText,
		timezone,
	} = match.groups;
	if (!hourText || !meridiem || !timezone) return null;

	const hour12 = Number(hourText);
	const minute = Number(match.groups.minute ?? "0");
	if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
	const hour = (hour12 % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
	const timeZone = timezone;
	const now = zonedParts(nowMs, timeZone);
	if (!now) return null;

	const year = now.year;
	let month = now.month;
	let day = now.day;
	if (monthText) {
		const parsedMonth = MONTH_INDEX[monthText.toLowerCase()];
		if (!parsedMonth || !dayText) return null;
		month = parsedMonth;
		day = Number(dayText);
	}

	let resetAt = zonedWallClockToEpoch(year, month, day, hour, minute, timeZone);
	if (resetAt === null) return null;
	if (resetAt <= nowMs) {
		if (monthText) {
			resetAt = zonedWallClockToEpoch(
				year + 1,
				month,
				day,
				hour,
				minute,
				timeZone,
			);
		} else {
			const tomorrow = nextCalendarDay({ ...now, hour, minute });
			resetAt = zonedWallClockToEpoch(
				tomorrow.year,
				tomorrow.month,
				tomorrow.day,
				hour,
				minute,
				timeZone,
			);
		}
	}
	if (
		resetAt === null ||
		resetAt <= nowMs ||
		resetAt - nowMs > MAX_RESET_HORIZON_MS
	) {
		return null;
	}
	return resetAt;
}
