import { sanitizeDiscordText } from "./formatting/discord-text.js";
import type { Meeting } from "./meeting.js";
import {
	type MeetingRecordOptions,
	toMeetingRecord,
} from "./meeting-record.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "./operation-store.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: unknown): Obj => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid meeting notification object");
	return v as Obj;
};
const id = (v: unknown) => typeof v === "string" && /^\d{17,20}$/.test(v);
export function meetingNotification(
	store: OperationStore,
	current: StoredOperation,
	result: Obj,
): Obj {
	const material = obj(current.material);
	if (result.meetingRevision !== material.meetingRevision)
		throw new Error("meeting notification revision mismatch");
	if (result.action === "prepare_notification") {
		if (
			Object.keys(result).some(
				(k) => !["action", "meetingRevision", "directory"].includes(k),
			)
		)
			throw new Error("invalid notification fields");
		if (
			material.notification &&
			obj(material.notification).status === "legacy_unknown" &&
			obj(material.notification).meetingRevision === material.meetingRevision
		)
			throw new Error(
				"legacy meeting notification remains unknown; cannot resend",
			);
		const directory = obj(result.directory),
			options = { ...obj(material.options), directory };
		const record = toMeetingRecord(
			material.meeting as unknown as Meeting,
			options as unknown as MeetingRecordOptions,
		);
		const old =
			material.notification === undefined
				? undefined
				: obj(material.notification);
		const leads = directory.leads as Obj[],
			lead = leads.find((row) => obj(row.ref).leadId === record.leadId);
		if (!lead || !id(lead.botUserId) || !id(lead.roundtableChannel)) {
			if (old?.input !== undefined)
				throw new Error("frozen meeting notification participant unavailable");
			return {
				...material,
				notification: {
					status: "unavailable",
					reason: "roundtable_participant_unavailable",
					meetingRevision: material.meetingRevision,
				},
			};
		}
		const eventId = `meeting:${record.id}:${material.meetingRevision}:notice`;
		const input = {
			schemaVersion: 2,
			kind: "announcement",
			operationId: eventId,
			sourceRefs: [current.operationId],
			target: "roundtable",
			eventId,
			text: `<@${lead.botUserId}> ${record.status === "cancelled" ? "会议已取消" : "会议安排更新"}\n主题：${sanitizeDiscordText(record.topic)}\n时间：${record.scheduledAt}\n时长：${record.durationMinutes} 分钟\nmeetingId: ${record.id}; revision: ${material.meetingRevision}\n请在本话题回复并点名 Raya。`,
		};
		if (old?.input !== undefined) {
			if (
				JSON.stringify(old.input) !== JSON.stringify(input) ||
				old.channelId !== lead.roundtableChannel
			)
				throw new Error("meeting notification binding changed");
			return material;
		}
		return {
			...material,
			notification: {
				status: "pending",
				meetingRevision: material.meetingRevision,
				channelId: lead.roundtableChannel,
				projectsDigest: directory.projectsDigest,
				input,
			},
		};
	}
	if (
		result.action !== "confirm_notification" ||
		Object.keys(result).some(
			(k) =>
				!["action", "meetingRevision", "notificationOperationId"].includes(k),
		)
	)
		throw new Error("invalid notification confirmation");
	const notification = obj(material.notification),
		expected = obj(notification.input);
	if (result.notificationOperationId !== expected.operationId)
		throw new Error("meeting notification identity mismatch");
	const announcement = store.read(String(result.notificationOperationId));
	if (
		!announcement ||
		announcement.kind !== "announcement" ||
		announcement.stage !== "complete" ||
		!announcement.sourceRefs.includes(current.operationId)
	)
		throw new Error("meeting notification not confirmed");
	const am = obj(announcement.material),
		payload = obj(obj(am.prepared).payload);
	if (
		payload.eventId !== expected.eventId ||
		payload.target !== "roundtable" ||
		payload.text !== expected.text ||
		am.channelId !== notification.channelId
	)
		throw new Error("meeting notification payload mismatch");
	const sent = (am.receipts as Obj[]).some((receipt) => {
		const result = obj(receipt.result);
		return (
			receipt.tool === "lead_actions.discord_send" &&
			result.status === "sent" &&
			result.engagement === "ready" &&
			result.messageId === am.messageId &&
			result.threadId === am.messageId &&
			result.eventId === expected.eventId
		);
	});
	if (!sent) throw new Error("meeting notification not confirmed ready");
	return {
		...material,
		notification: { ...notification, status: "sent", messageId: am.messageId },
	};
}
