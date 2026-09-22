import { containsSecretLikeText } from "./formatting/discord-text.js";
import type { Meeting } from "./meeting.js";
import type { LeadRef } from "./ports.js";
export interface StandardMeetingRecord {
	schemaVersion: 2;
	id: string;
	leadId: string;
	topic: string;
	scheduledAt: string;
	durationMinutes: number;
	requestedBy: string;
	requestedAt: string;
	status:
		| "scheduled"
		| "starting"
		| "live"
		| "interrupted"
		| "ended"
		| "cancelled"
		| "missed";
	continuesFrom?: string;
	voice?: Record<string, unknown>;
	endedAt?: string;
	endReason?: string;
}
export interface MeetingRecordOptions {
	directory: {
		projectsDigest: string;
		leads: readonly { ref: LeadRef; external: boolean }[];
	};
	durationMinutes: number;
	requestedBy: string;
	requestedAt: string;
	endedAt?: string;
	continuesFrom?: string;
}
const uuid = (value: unknown) =>
	typeof value === "string" &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
const iso = (value: unknown) =>
	typeof value === "string" &&
	value.includes("T") &&
	Number.isFinite(Date.parse(value));
/** Business-only mapping; driver paths and session credentials never enter the record. */
export function toMeetingRecord(
	meeting: Meeting,
	options: MeetingRecordOptions,
): StandardMeetingRecord {
	if (
		!uuid(meeting.meetingId) ||
		!Number.isSafeInteger(meeting.revision) ||
		meeting.revision < 1 ||
		!iso(meeting.startsAt)
	)
		throw new Error("invalid meeting identity or schedule");
	if (
		typeof meeting.title !== "string" ||
		!meeting.title.trim() ||
		meeting.title.length > 200 ||
		containsSecretLikeText(meeting.title)
	)
		throw new Error("invalid meeting topic");
	if (meeting.participants.length !== 1)
		throw new Error("voice meetings require a single target Lead");
	if (
		!Number.isSafeInteger(options.durationMinutes) ||
		options.durationMinutes <= 0
	)
		throw new Error("invalid meeting duration");
	if (!/^\d{17,20}$/.test(options.requestedBy) || !iso(options.requestedAt))
		throw new Error("invalid meeting requester");
	if (!/^[a-f0-9]{64}$/.test(options.directory.projectsDigest))
		throw new Error("invalid meeting directory digest");
	const target = meeting.participants[0];
	if (!target?.project || !target.leadId)
		throw new Error("meeting target required");
	const candidates = options.directory.leads.filter(
		(lead) => lead.ref.leadId === target.leadId,
	);
	if (candidates.length !== 1)
		throw new Error("meeting Lead globally missing or ambiguous");
	const lead = candidates[0];
	if (!lead || lead.ref.project !== target.project)
		throw new Error("meeting project binding mismatch");
	if (lead.external !== false)
		throw new Error("external meeting Lead is not supported");
	if (
		options.continuesFrom !== undefined &&
		(!uuid(options.continuesFrom) ||
			options.continuesFrom === meeting.meetingId)
	)
		throw new Error("invalid meeting continuation");
	if (
		!["scheduled", "rescheduled", "cancelled"].includes(String(meeting.status))
	)
		throw new Error("invalid business meeting status");
	if (meeting.status === "cancelled" && !iso(options.endedAt))
		throw new Error("cancelled meeting requires endedAt");
	if (meeting.status !== "cancelled" && options.endedAt !== undefined)
		throw new Error("nonterminal meeting cannot have endedAt");
	return {
		schemaVersion: 2,
		id: meeting.meetingId,
		leadId: target.leadId,
		topic: meeting.title,
		scheduledAt: meeting.startsAt,
		durationMinutes: options.durationMinutes,
		requestedBy: options.requestedBy,
		requestedAt: options.requestedAt,
		status: meeting.status === "cancelled" ? "cancelled" : "scheduled",
		...(options.continuesFrom === undefined
			? {}
			: { continuesFrom: options.continuesFrom }),
		...(options.endedAt === undefined ? {} : { endedAt: options.endedAt }),
	};
}
