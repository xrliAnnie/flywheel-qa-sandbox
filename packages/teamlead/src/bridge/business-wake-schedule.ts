import { founderLocalIso, founderOffsetMinutes } from "flywheel-config";

export interface BusinessWakeSchedule {
	id: string;
	enabled: boolean;
	at: string;
	timezone: string;
	revision: number;
}
export interface BusinessWakeScheduleFile {
	version: 1;
	schedules: BusinessWakeSchedule[];
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw new Error("business_wake_schema_invalid");
	return value as Record<string, unknown>;
}
export function parseBusinessWakeSchedule(
	raw: string,
): BusinessWakeScheduleFile {
	if (Buffer.byteLength(raw, "utf8") > 16384)
		throw new Error("business_wake_file_too_large");
	const data = record(JSON.parse(raw), ["version", "schedules"]);
	if (
		data.version !== 1 ||
		!Array.isArray(data.schedules) ||
		data.schedules.length > 8
	)
		throw new Error("business_wake_schema_invalid");
	const ids = new Set<string>();
	const schedules = data.schedules.map((value) => {
		const s = record(value, ["id", "enabled", "at", "timezone", "revision"]);
		if (
			typeof s.id !== "string" ||
			!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s.id) ||
			ids.has(s.id) ||
			typeof s.enabled !== "boolean" ||
			typeof s.at !== "string" ||
			!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at) ||
			typeof s.timezone !== "string" ||
			!s.timezone ||
			!Number.isSafeInteger(s.revision) ||
			(s.revision as number) < 1
		)
			throw new Error("business_wake_schema_invalid");
		if (s.timezone !== "founder")
			new Intl.DateTimeFormat("en", { timeZone: s.timezone });
		ids.add(s.id);
		return {
			id: s.id,
			enabled: s.enabled,
			at: s.at,
			timezone: s.timezone,
			revision: s.revision as number,
		};
	});
	return { version: 1, schedules };
}

/** DST policy: first repeated instant; nonexistent wall time shifts forward by the gap. */
export function latestBusinessWakeDue(
	schedule: BusinessWakeSchedule,
	now: number,
	founderTimezone: string,
): { localDate: string; dueAt: string; timezone: string } | undefined {
	if (!schedule.enabled) return undefined;
	if (!Number.isFinite(now)) throw new Error("business_wake_now_invalid");
	const timezone =
		schedule.timezone === "founder" ? founderTimezone : schedule.timezone;
	const today = founderLocalIso(new Date(now), timezone).slice(0, 10);
	for (let days = 0; days < 3; days++) {
		const localDate = new Date(
			Date.parse(`${today}T00:00:00Z`) - days * 86400000,
		)
			.toISOString()
			.slice(0, 10);
		const target = `${localDate}T${schedule.at}:00`;
		const nominal = Date.parse(`${target}Z`);
		const offsets = new Set(
			[-1, 0, 1].map((day) =>
				founderOffsetMinutes(new Date(nominal + day * 86400000), timezone),
			),
		);
		const candidates = [...offsets]
			.map((offset) => nominal - offset * 60000)
			.filter((instant) => {
				const local = founderLocalIso(new Date(instant), timezone).slice(0, 19);
				return local.slice(0, 10) === localDate && local >= target;
			})
			.sort((a, b) => a - b);
		const due = candidates[0];
		if (due !== undefined && due <= now)
			return { localDate, dueAt: new Date(due).toISOString(), timezone };
	}
	return undefined;
}
