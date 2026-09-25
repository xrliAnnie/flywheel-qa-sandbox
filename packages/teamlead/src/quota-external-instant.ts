/**
 * FLY-2864 — one normalization rule for instants read from provider APIs.
 *
 * Accepts only ISO 8601 date-times with an explicit zone (`Z` or `±HH:MM`,
 * optional fraction) whose calendar fields are real, and returns the canonical
 * UTC `toISOString()` form stored by our own files. Anything else is null so
 * callers can treat it as malformed instead of guessing a zone.
 */

const EXTERNAL_INSTANT =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

export function normalizeExternalInstant(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const match = EXTERNAL_INSTANT.exec(value);
	if (match === null) return null;
	const [, year, month, day, hour, minute, second, fraction, zone] = match;
	const y = Number(year);
	const m = Number(month);
	const d = Number(day);
	const hh = Number(hour);
	const mi = Number(minute);
	const ss = Number(second);
	const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		y < 1970 ||
		m < 1 ||
		m > 12 ||
		d < 1 ||
		d > (days[m - 1] ?? 0) ||
		hh > 23 ||
		mi > 59 ||
		ss > 59
	) {
		return null;
	}
	let offsetMinutes = 0;
	if (zone !== "Z") {
		const offsetHours = Number(zone!.slice(1, 3));
		const offsetMins = Number(zone!.slice(4));
		if (offsetHours > 23 || offsetMins > 59) return null;
		offsetMinutes =
			(zone!.startsWith("-") ? -1 : 1) * (offsetHours * 60 + offsetMins);
	}
	const millis = Number((fraction ?? "0").padEnd(3, "0").slice(0, 3));
	const epoch =
		Date.UTC(y, m - 1, d, hh, mi, ss, millis) - offsetMinutes * 60_000;
	return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}
