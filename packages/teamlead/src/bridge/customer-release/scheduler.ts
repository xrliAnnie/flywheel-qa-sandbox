import type { CustomerReleaseSettings } from "flywheel-config";

type ScheduleSettings = Pick<
	CustomerReleaseSettings,
	| "timezone"
	| "weekday"
	| "notice_local"
	| "deadline_local"
	| "claim_deadline_local"
	| "minimum_veto_minutes"
>;
type Schedule =
	| { kind: "invalid"; reason: "schedule_invalid" }
	| {
			kind: "scheduled";
			slotDate: string;
			weekStart: string;
			noticeAt: number;
			deadlineAt: number;
			claimNotAfter: number;
			phase: "before_notice" | "notice_window" | "missed_notice";
	  };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
function validClock(now: number): boolean {
	return Number.isSafeInteger(now) && now >= 0 && now <= 253_402_214_400_000;
}
export function customerReleaseClockFailure(
	previous: number | null,
	now: number,
): "clock_invalid" | "clock_rollback" | "tick_gap" | null {
	if (!validClock(now) || (previous !== null && !validClock(previous)))
		return "clock_invalid";
	if (previous === null) return null;
	if (previous - now > 5000) return "clock_rollback";
	if (now - previous > 90_000) return "tick_gap";
	return null;
}
function minutes(value: string): number {
	if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
		return NaN;
	return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function localParts(format: Intl.DateTimeFormat, now: number): number[] {
	const parts = Object.fromEntries(
		format.formatToParts(now).map((part) => [part.type, part.value]),
	);
	return ["year", "month", "day", "hour", "minute"].map((key) =>
		Number(parts[key]),
	);
}
function wallStamp(parts: number[]): number {
	const [year, month, day, hour, minute] = parts;
	const date = new Date(0);
	date.setUTCFullYear(year!, month! - 1, day!);
	date.setUTCHours(hour!, minute!, 0, 0);
	return date.getTime();
}
/** Pure calendar planning. Callers still enforce mode, activation and persisted cycle uniqueness. */
export function customerReleaseSchedule(
	settings: ScheduleSettings,
	now: number,
): Schedule {
	const invalid: Schedule = { kind: "invalid", reason: "schedule_invalid" };
	try {
		if (
			typeof settings.timezone !== "string" ||
			!settings.timezone ||
			!validClock(now) ||
			!Number.isInteger(settings.weekday) ||
			settings.weekday < 1 ||
			settings.weekday > 7
		)
			return invalid;
		const notice = minutes(settings.notice_local);
		const deadline = minutes(settings.deadline_local);
		const claim = minutes(settings.claim_deadline_local);
		if (
			![notice, deadline, claim].every(Number.isFinite) ||
			notice >= 720 ||
			deadline < 720 ||
			deadline >= 1080 ||
			claim <= deadline ||
			claim >= 1080 ||
			!Number.isInteger(settings.minimum_veto_minutes) ||
			settings.minimum_veto_minutes < 120 ||
			settings.minimum_veto_minutes > 480 ||
			deadline - notice < settings.minimum_veto_minutes
		)
			return invalid;
		const format = new Intl.DateTimeFormat("en-CA", {
			timeZone: settings.timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		const today = localParts(format, now);
		const day = wallStamp([...today.slice(0, 3), 0, 0]);
		const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
		const slot = monday + (settings.weekday - 1) * DAY;
		// Collect both offsets around a transition, then require exactly one inverse
		// for each requested wall time. Gaps and folds never normalize silently.
		const offsets = new Set<number>();
		for (let hour = -36; hour <= 36; hour++) {
			const sample = slot + hour * HOUR;
			offsets.add(wallStamp(localParts(format, sample)) - sample);
		}
		const resolve = (minute: number): number | null => {
			const target = slot + minute * 60_000;
			const matches = [...offsets]
				.map((offset) => target - offset)
				.filter(
					(candidate) => wallStamp(localParts(format, candidate)) === target,
				);
			return matches.length === 1 ? matches[0]! : null;
		};
		const noticeAt = resolve(notice),
			deadlineAt = resolve(deadline),
			claimNotAfter = resolve(claim);
		if (
			noticeAt === null ||
			deadlineAt === null ||
			claimNotAfter === null ||
			deadlineAt - noticeAt < settings.minimum_veto_minutes * 60_000 ||
			claimNotAfter <= deadlineAt
		)
			return invalid;
		return {
			kind: "scheduled",
			slotDate: new Date(slot).toISOString().slice(0, 10),
			weekStart: new Date(monday).toISOString().slice(0, 10),
			noticeAt,
			deadlineAt,
			claimNotAfter,
			phase:
				now < noticeAt
					? "before_notice"
					: now < deadlineAt
						? "notice_window"
						: "missed_notice",
		};
	} catch {
		return invalid;
	}
}
