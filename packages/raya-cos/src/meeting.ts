import type { LeadResolution } from "./meeting-context.js";
import type { CoSPorts, LeadRef, LeadTransportUnavailable } from "./ports.js";

export type Meeting = {
	meetingId: string;
	revision: number;
	title: string;
	startsAt: string;
	participants: readonly LeadRef[];
	status?: "scheduled" | "rescheduled" | "cancelled";
	calendarEventId?: string;
	outboundMessageId?: string;
	mailboxDeliveryId?: string;
	notification?: LeadTransportUnavailable;
};

export type MeetingCommand =
	| { kind: "cancel" }
	| { kind: "stop" }
	| { kind: "hint" }
	| {
			kind: "reschedule";
			when: { hour: number; minute: number; tomorrow: boolean };
			durationMinutes?: number;
	  }
	| {
			kind: "schedule";
			when: "now" | { hour: number; minute: number; tomorrow: boolean };
			to: LeadRef;
			topic: string;
			durationMinutes?: number;
			continues?: true;
	  };

const SCHEDULE_PATTERN =
	/^安排会议\s+(现在|(?:(明天)\s+)?(\d{1,2}):(\d{2}))\s+和\s+(.+?)\s+聊\s+(.+?)(?:\s+时长\s+(\d+))?(?:\s+(继续上一场))?$/u;
const RESCHEDULE_PATTERN =
	/^改期会议\s+(?:(明天)\s+)?(\d{1,2}):(\d{2})(?:\s+时长\s+(\d+))?$/u;

function validClock(hour: number, minute: number): boolean {
	return (
		Number.isInteger(hour) &&
		hour >= 0 &&
		hour <= 23 &&
		Number.isInteger(minute) &&
		minute >= 0 &&
		minute <= 59
	);
}

function validDuration(duration: number | undefined): boolean {
	return (
		duration === undefined || (Number.isSafeInteger(duration) && duration > 0)
	);
}

export function parseMeetingCommand(
	content: string,
	directory: {
		resolve(
			name: string,
		):
			| LeadResolution
			| { status: "found"; ref: LeadRef }
			| { status: "not_found" };
	},
): MeetingCommand | null {
	const normalized = content.normalize("NFKC").trim();
	if (normalized === "取消会议") return { kind: "cancel" };
	if (normalized === "结束会议") return { kind: "stop" };
	const reschedule = RESCHEDULE_PATTERN.exec(normalized);
	if (reschedule) {
		const hour = Number(reschedule[2]);
		const minute = Number(reschedule[3]);
		const durationMinutes =
			reschedule[4] === undefined ? undefined : Number(reschedule[4]);
		if (!validClock(hour, minute) || !validDuration(durationMinutes))
			return { kind: "hint" };
		return {
			kind: "reschedule",
			when: { hour, minute, tomorrow: reschedule[1] === "明天" },
			...(durationMinutes === undefined ? {} : { durationMinutes }),
		};
	}
	const schedule = SCHEDULE_PATTERN.exec(normalized);
	if (!schedule) return normalized.includes("会议") ? { kind: "hint" } : null;
	const resolution = directory.resolve(schedule[5] ?? "");
	const topic = schedule[6]?.trim() ?? "";
	const durationMinutes =
		schedule[7] === undefined ? undefined : Number(schedule[7]);
	if (
		resolution.status !== "found" ||
		topic.length < 1 ||
		topic.length > 200 ||
		!validDuration(durationMinutes)
	) {
		return { kind: "hint" };
	}
	let when: Extract<MeetingCommand, { kind: "schedule" }>["when"] = "now";
	if (schedule[1] !== "现在") {
		const hour = Number(schedule[3]);
		const minute = Number(schedule[4]);
		if (!validClock(hour, minute)) return { kind: "hint" };
		when = { hour, minute, tomorrow: schedule[2] === "明天" };
	}
	return {
		kind: "schedule",
		when,
		to: resolution.ref,
		topic,
		...(durationMinutes === undefined ? {} : { durationMinutes }),
		...(schedule[8] === "继续上一场" ? { continues: true as const } : {}),
	};
}

export async function scheduleMeeting(
	meeting: Meeting,
	ports: CoSPorts,
): Promise<Meeting> {
	const recipient = meeting.participants[0];
	if (!recipient) {
		throw new Error("a meeting requires at least one participant");
	}
	const receipt = await ports.request({
		key: { requestId: meeting.meetingId, revision: meeting.revision },
		to: recipient,
		kind: "meeting",
		correlation: meeting.meetingId,
		body: `${meeting.title}\n${meeting.startsAt}`,
		expiresAt: Date.parse(meeting.startsAt),
	});
	if (receipt.status === "unavailable") {
		return { ...meeting, status: "scheduled", notification: receipt };
	}
	return {
		...meeting,
		status: "scheduled",
		mailboxDeliveryId: receipt.deliveryId,
		notification: undefined,
	};
}

export async function rescheduleMeeting(
	meeting: Meeting,
	startsAt: string,
	ports: CoSPorts,
): Promise<Meeting> {
	if (!Number.isFinite(Date.parse(startsAt))) {
		throw new Error("meeting startsAt must be ISO-8601");
	}
	const recipient = meeting.participants[0];
	if (!recipient)
		throw new Error("a meeting requires at least one participant");
	const revision = meeting.revision + 1;
	const receipt = await ports.request({
		key: { requestId: meeting.meetingId, revision },
		to: recipient,
		kind: "meeting",
		correlation: meeting.meetingId,
		body: `${meeting.title}\n${startsAt}`,
		expiresAt: Date.parse(startsAt),
	});
	if (receipt.status === "unavailable") {
		return {
			...meeting,
			revision,
			startsAt,
			status: "rescheduled",
			notification: receipt,
		};
	}
	return {
		...meeting,
		revision,
		startsAt,
		status: "rescheduled",
		mailboxDeliveryId: receipt.deliveryId,
		notification: undefined,
	};
}

export function cancelMeeting(meeting: Meeting): Meeting {
	return { ...meeting, revision: meeting.revision + 1, status: "cancelled" };
}
