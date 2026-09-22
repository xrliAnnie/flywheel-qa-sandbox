import { describe, expect, it } from "vitest";
import * as adapter from "./meeting-record.js";

const meeting = {
	meetingId: "12345678-1234-4234-8234-123456789abc",
	revision: 2,
	title: "交付风险",
	startsAt: "2026-09-16T04:00:00Z",
	participants: [{ project: "flywheel", leadId: "eng" }],
	status: "rescheduled" as const,
	calendarEventId: "calendar-1",
};
const options = {
	directory: {
		projectsDigest: "a".repeat(64),
		leads: [{ ref: { project: "flywheel", leadId: "eng" }, external: false }],
	},
	durationMinutes: 30,
	requestedBy: "777777777777777777",
	requestedAt: "2026-09-16T03:00:00Z",
};
describe("standard MeetingRecord compatibility", () => {
	it("preserves the UUID and exact schedule while mapping rescheduled to scheduled", () => {
		expect(adapter.toMeetingRecord(meeting, options)).toEqual({
			schemaVersion: 2,
			id: meeting.meetingId,
			leadId: "eng",
			topic: "交付风险",
			scheduledAt: meeting.startsAt,
			durationMinutes: 30,
			requestedBy: options.requestedBy,
			requestedAt: options.requestedAt,
			status: "scheduled",
		});
	});
	it("rejects multiple participants and globally ambiguous or external Lead identities", () => {
		expect(() =>
			adapter.toMeetingRecord(
				{
					...meeting,
					participants: [
						...meeting.participants,
						{ project: "other", leadId: "other" },
					],
				},
				options,
			),
		).toThrow(/single/);
		expect(() =>
			adapter.toMeetingRecord(meeting, {
				...options,
				directory: {
					...options.directory,
					leads: [
						...options.directory.leads,
						{ ref: { project: "other", leadId: "eng" }, external: false },
					],
				},
			}),
		).toThrow(/ambiguous/);
		expect(() =>
			adapter.toMeetingRecord(meeting, {
				...options,
				directory: {
					...options.directory,
					leads: [
						{ ref: { project: "flywheel", leadId: "eng" }, external: true },
					],
				},
			}),
		).toThrow(/external/);
	});
	it("retains cancellation timing and rejects invalid duration and continuation identity", () => {
		expect(() =>
			adapter.toMeetingRecord({ ...meeting, status: "cancelled" }, options),
		).toThrow(/endedAt/);
		expect(
			adapter.toMeetingRecord(
				{ ...meeting, status: "cancelled" },
				{ ...options, endedAt: "2026-09-16T03:30:00Z" },
			),
		).toMatchObject({ status: "cancelled", endedAt: "2026-09-16T03:30:00Z" });
		expect(() =>
			adapter.toMeetingRecord(meeting, { ...options, durationMinutes: 0 }),
		).toThrow(/duration/);
		expect(() =>
			adapter.toMeetingRecord(meeting, {
				...options,
				continuesFrom: meeting.meetingId,
			}),
		).toThrow(/continuation/);
	});
});
