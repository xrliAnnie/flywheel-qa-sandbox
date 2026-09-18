import { describe, expect, it, vi } from "vitest";
import { syncMeetingCalendar } from "./meeting-calendar.js";

describe("meeting calendar projection", () => {
	it("updates the same external event and keeps its receipt separate", async () => {
		const upsert = vi.fn(async () => ({
			eventId: "calendar-1",
			syncedAt: "2026-09-08T20:00:00.000Z",
		}));
		const result = await syncMeetingCalendar(
			{
				meetingId: "f5e14717-049b-4d43-b58d-78f18cc1aebb",
				revision: 2,
				title: "Portfolio review",
				startsAt: "2026-09-10T18:00:00.000Z",
				participants: [{ project: "flywheel", leadId: "flywheel-eng-lead" }],
				status: "rescheduled",
				calendarEventId: "calendar-1",
				outboundMessageId: "discord-1",
				mailboxDeliveryId: "mailbox-1",
			},
			{ upsert, cancel: vi.fn() },
		);
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({ eventId: "calendar-1" }),
		);
		expect(result).toEqual({
			eventId: "calendar-1",
			syncedAt: "2026-09-08T20:00:00.000Z",
		});
		expect(result).not.toHaveProperty("outboundMessageId");
		expect(result).not.toHaveProperty("mailboxDeliveryId");
	});
});
