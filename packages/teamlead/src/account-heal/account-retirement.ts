/** Missing retirement is unlimited; malformed external input is never selectable. */
export function retirementMs(value: unknown): number {
	if (value === undefined) return Number.POSITIVE_INFINITY;
	if (typeof value !== "string") return Number.NaN;
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
			value,
		);
	if (match === null) return Number.NaN;
	const [, year, month, day, hour, minute, second, offset] = match;
	const y = Number(year);
	const m = Number(month);
	const d = Number(day);
	if (offset === undefined) return Number.NaN;
	const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		m < 1 ||
		m > 12 ||
		d < 1 ||
		d > (days[m - 1] ?? 0) ||
		Number(hour) > 23 ||
		Number(minute) > 59 ||
		Number(second) > 59 ||
		(offset !== "Z" &&
			(Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))
	)
		return Number.NaN;
	return Date.parse(value);
}

export function retirementLabel(value: unknown): string {
	const ms = retirementMs(value);
	if (!Number.isFinite(ms)) return "";
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		month: "numeric",
		day: "numeric",
	}).formatToParts(ms);
	return `(${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value} 到期)`;
}
