import { expect, it } from "vitest";
import {
	customerReleaseClockFailure,
	customerReleaseSchedule,
} from "../customer-release/scheduler.js";

const config = {
	timezone: "America/Los_Angeles",
	weekday: 2,
	notice_local: "08:00",
	deadline_local: "14:00",
	claim_deadline_local: "15:00",
	minimum_veto_minutes: 120,
};
const at = (value: string) => Date.parse(value);

it("resolves the configured local week and fixed afternoon boundaries without host timezone", () => {
	expect(customerReleaseSchedule(config, at("2026-09-14T23:00:00Z"))).toEqual({
		kind: "scheduled",
		slotDate: "2026-09-15",
		weekStart: "2026-09-14",
		noticeAt: at("2026-09-15T15:00:00Z"),
		deadlineAt: at("2026-09-15T21:00:00Z"),
		claimNotAfter: at("2026-09-15T22:00:00Z"),
		phase: "before_notice",
	});
	expect(
		customerReleaseSchedule(config, at("2026-09-15T15:00:00Z")),
	).toMatchObject({ phase: "notice_window" });
	expect(
		customerReleaseSchedule(config, at("2026-09-15T21:00:00Z")),
	).toMatchObject({ phase: "missed_notice" });
});
it("uses the local date when UTC is already in the next week", () => {
	expect(
		customerReleaseSchedule(config, at("2026-09-21T01:00:00Z")),
	).toMatchObject({
		slotDate: "2026-09-15",
		weekStart: "2026-09-14",
		phase: "missed_notice",
	});
});
it.each([
	["2026-03-08T12:00:00Z", "02:30"],
	["2026-11-01T12:00:00Z", "01:30"],
])("rejects absent or repeated local wall times on %s", (now, notice_local) => {
	expect(
		customerReleaseSchedule({ ...config, weekday: 7, notice_local }, at(now)),
	).toEqual({
		kind: "invalid",
		reason: "schedule_invalid",
	});
});
it("supports fractional timezone offsets and year boundaries", () => {
	expect(
		customerReleaseSchedule(
			{ ...config, timezone: "Asia/Kathmandu", weekday: 4 },
			at("2026-01-01T00:00:00Z"),
		),
	).toMatchObject({
		kind: "scheduled",
		slotDate: "2026-01-01",
		weekStart: "2025-12-29",
		noticeAt: at("2026-01-01T02:15:00Z"),
		deadlineAt: at("2026-01-01T08:15:00Z"),
	});
});
it("rejects a short window without shifting the afternoon deadline", () => {
	expect(
		customerReleaseSchedule(
			{
				...config,
				notice_local: "11:00",
				deadline_local: "12:00",
				minimum_veto_minutes: 120,
			},
			at("2026-03-08T09:00:00Z"),
		),
	).toEqual({ kind: "invalid", reason: "schedule_invalid" });
});
it.each([
	{ timezone: "No/Such_Zone" },
	{ weekday: 0 },
	{ notice_local: "8:00" },
	{ notice_local: "13:00" },
	{ claim_deadline_local: "14:00" },
	{ deadline_local: "11:00" },
	{ minimum_veto_minutes: 0 },
])("rejects malformed schedule settings %j", (patch) => {
	expect(
		customerReleaseSchedule(
			{ ...config, ...patch },
			at("2026-09-14T00:00:00Z"),
		),
	).toEqual({
		kind: "invalid",
		reason: "schedule_invalid",
	});
});
it("rejects invalid clock values and identifies rollback/gap boundaries", () => {
	expect(customerReleaseSchedule(config, Number.NaN)).toEqual({
		kind: "invalid",
		reason: "schedule_invalid",
	});
	expect(customerReleaseClockFailure(null, 10_000)).toBe(null);
	expect(customerReleaseClockFailure(10_000, 5_000)).toBe(null);
	expect(customerReleaseClockFailure(10_000, 4_999)).toBe("clock_rollback");
	expect(customerReleaseClockFailure(10_000, 100_000)).toBe(null);
	expect(customerReleaseClockFailure(10_000, 100_001)).toBe("tick_gap");
	expect(customerReleaseClockFailure(10_000, Number.NaN)).toBe("clock_invalid");
});

it("never falls back to the machine timezone when the configured timezone is missing", () => {
	expect(
		customerReleaseSchedule(
			{ ...config, timezone: undefined as unknown as string },
			at("2026-09-14T23:00:00Z"),
		),
	).toEqual({
		kind: "invalid",
		reason: "schedule_invalid",
	});
});
