import { describe, expect, it } from "vitest";
import {
	latestBusinessWakeDue,
	parseBusinessWakeSchedule,
} from "../business-wake-schedule.js";

const schedule = {
	id: "evening",
	enabled: true,
	at: "20:00",
	timezone: "founder",
	revision: 1,
};
const encode = (s: unknown) => JSON.stringify({ version: 1, schedules: [s] });
describe("business wake schedule", () => {
	it("validates the bounded declarative schema without accepting commands", () => {
		expect(parseBusinessWakeSchedule(encode(schedule))).toEqual({
			version: 1,
			schedules: [schedule],
		});
		for (const s of [
			{ ...schedule, command: "execute" },
			{ ...schedule, at: "24:00" },
			{ ...schedule, timezone: "not-a-zone" },
			{ ...schedule, revision: 0 },
		])
			expect(() => parseBusinessWakeSchedule(encode(s))).toThrow();
		expect(() =>
			parseBusinessWakeSchedule(
				JSON.stringify({ version: 1, schedules: Array(9).fill(schedule) }),
			),
		).toThrow();
		expect(() => parseBusinessWakeSchedule(" ".repeat(16385))).toThrow();
		expect(() =>
			parseBusinessWakeSchedule(
				JSON.stringify({ version: 1, schedules: [schedule, schedule] }),
			),
		).toThrow();
	});
	it("chooses only the latest due local date, using one founder timezone", () => {
		expect(
			latestBusinessWakeDue(
				schedule,
				Date.parse("2026-09-15T02:59:00Z"),
				"America/Los_Angeles",
			),
		).toEqual({
			localDate: "2026-09-13",
			dueAt: "2026-09-14T03:00:00.000Z",
			timezone: "America/Los_Angeles",
		});
		expect(
			latestBusinessWakeDue(
				schedule,
				Date.parse("2026-09-15T03:00:00Z"),
				"America/Los_Angeles",
			)?.localDate,
		).toBe("2026-09-14");
		expect(
			latestBusinessWakeDue({ ...schedule, enabled: false }, Date.now(), "UTC"),
		).toBeUndefined();
	});
	it("shifts spring gaps forward and chooses the first fall occurrence", () => {
		expect(
			latestBusinessWakeDue(
				{ ...schedule, at: "02:30" },
				Date.parse("2026-03-08T11:00:00Z"),
				"America/Los_Angeles",
			)?.dueAt,
		).toBe("2026-03-08T10:30:00.000Z");
		expect(
			latestBusinessWakeDue(
				{ ...schedule, at: "01:30" },
				Date.parse("2026-11-01T10:00:00Z"),
				"America/Los_Angeles",
			)?.dueAt,
		).toBe("2026-11-01T08:30:00.000Z");
	});
});
