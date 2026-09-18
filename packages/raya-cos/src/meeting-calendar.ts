import type { Meeting } from "./meeting.js";

export type MeetingCalendarReceipt = {
	eventId: string;
	syncedAt: string;
};

export interface MeetingCalendar {
	upsert(input: {
		meetingId: string;
		revision: number;
		eventId?: string;
		title: string;
		startsAt: string;
	}): Promise<MeetingCalendarReceipt>;
	cancel(input: { meetingId: string; eventId: string }): Promise<void>;
}

export function syncMeetingCalendar(
	meeting: Meeting,
	calendar: MeetingCalendar,
): Promise<MeetingCalendarReceipt> {
	return calendar.upsert({
		meetingId: meeting.meetingId,
		revision: meeting.revision,
		eventId: meeting.calendarEventId,
		title: meeting.title,
		startsAt: meeting.startsAt,
	});
}

export async function cancelMeetingCalendar(
	meeting: Meeting,
	calendar: MeetingCalendar,
): Promise<void> {
	if (!meeting.calendarEventId) return;
	await calendar.cancel({
		meetingId: meeting.meetingId,
		eventId: meeting.calendarEventId,
	});
}
