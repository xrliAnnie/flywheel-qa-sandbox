import { createHash } from "node:crypto";
import type { BusinessRoundView } from "./business-round.js";
import { sanitizeDiscordText } from "./formatting/discord-text.js";
import type { Meeting } from "./meeting.js";
import { meetingNotification } from "./meeting-notification.js";
import {
	type MeetingRecordOptions,
	toMeetingRecord,
} from "./meeting-record.js";
import { meetingVoiceNext } from "./meeting-voice.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "./operation-store.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: unknown): Obj => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid meeting object");
	return v as Obj;
};
const hash = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
function allowed(v: Obj, keys: string[]) {
	if (Object.keys(v).some((k) => !keys.includes(k)))
		throw new Error("unknown meeting fields");
}
export function source(value: unknown, founder: unknown): Obj {
	const v = obj(value);
	allowed(v, ["messageId", "channelId", "authorId", "body", "observedAt"]);
	if (
		typeof founder !== "string" ||
		!/^\d{17,20}$/.test(founder) ||
		v.authorId !== founder
	)
		throw new Error("meeting founder mismatch");
	if (
		![v.messageId, v.channelId].every(
			(id) => typeof id === "string" && /^\d{17,20}$/.test(id),
		) ||
		typeof v.body !== "string" ||
		!v.body.trim() ||
		Buffer.byteLength(v.body) > 16384 ||
		!Number.isSafeInteger(v.observedAt) ||
		Number(v.observedAt) < 0
	)
		throw new Error("invalid meeting source");
	return { ...v, body: sanitizeDiscordText(v.body) };
}
const sourceKey = (s: Obj) => `${s.channelId}:${s.messageId}`;
export function prepareMeeting(
	store: OperationStore,
	input: Obj,
): BusinessRoundView {
	allowed(input, [
		"schemaVersion",
		"kind",
		"source",
		"founderUserId",
		"meeting",
		"durationMinutes",
		"directory",
		"continuesFrom",
	]);
	const s = source(input.source, input.founderUserId),
		meeting = obj(input.meeting);
	allowed(meeting, [
		"meetingId",
		"revision",
		"title",
		"startsAt",
		"participants",
		"status",
	]);
	if (
		meeting.revision !== 1 ||
		meeting.status !== "scheduled" ||
		!Array.isArray(meeting.participants)
	)
		throw new Error("new meeting requires scheduled revision 1");
	const suppliedDirectory = obj(input.directory);
	if (!Array.isArray(suppliedDirectory.leads))
		throw new Error("meeting directory required");
	const directory = {
		projectsDigest: suppliedDirectory.projectsDigest,
		leads: suppliedDirectory.leads.map((value) => {
			const row = obj(value),
				ref = obj(row.ref);
			return {
				ref: { project: ref.project, leadId: ref.leadId },
				external: row.external,
				...(row.botUserId === undefined ? {} : { botUserId: row.botUserId }),
				...(row.displayName === undefined
					? {}
					: { displayName: row.displayName }),
				...(row.roundtableChannel === undefined
					? {}
					: { roundtableChannel: row.roundtableChannel }),
			};
		}),
	};
	const options = {
		directory,
		durationMinutes: input.durationMinutes,
		requestedBy: s.authorId,
		requestedAt: new Date(Number(s.observedAt)).toISOString(),
		...(input.continuesFrom === undefined
			? {}
			: { continuesFrom: input.continuesFrom }),
	};
	const record = toMeetingRecord(
		meeting as unknown as Meeting,
		options as unknown as MeetingRecordOptions,
	);
	const operationId = `meeting:${record.id}`,
		inputDigest = hash(input),
		old = store.read(operationId);
	if (old) {
		if (old.kind !== "meeting" || old.inputDigest !== inputDigest)
			throw new Error("meeting binding conflict");
		return meetingView(old);
	}
	if (
		store
			.list()
			.some(
				(op) =>
					op.kind === "meeting" &&
					obj(obj(op.material).source).messageId === s.messageId &&
					obj(obj(op.material).source).channelId === s.channelId &&
					hash(obj(obj(op.material).meeting).participants) ===
						hash(meeting.participants),
			)
	)
		throw new Error("meeting source already bound to another UUID");
	return meetingView(
		store.commit(
			{
				operationId,
				inputDigest,
				kind: "meeting",
				stage: "scheduled",
				sourceRefs: [`discord:${sourceKey(s)}`],
				material: {
					source: s,
					founderUserId: input.founderUserId,
					meeting,
					record: record as unknown as JsonValue,
					options,
					meetingRevision: 1,
					history: [],
					changes: { [sourceKey(s)]: inputDigest },
					receipts: [],
				},
			},
			0,
		),
	);
}
export function recordMeeting(
	store: OperationStore,
	current: StoredOperation,
	input: Obj,
	now: number,
): BusinessRoundView {
	if (
		input.tool !== "current_turn" ||
		typeof input.callId !== "string" ||
		!input.callId.trim()
	)
		throw new Error("meeting current turn result required");
	const material = obj(current.material),
		result = obj(input.result);
	let next: Obj,
		stage = current.stage;
	if (result.action === "reschedule" || result.action === "cancel") {
		allowed(
			result,
			result.action === "cancel"
				? ["action", "source"]
				: ["action", "source", "startsAt", "durationMinutes"],
		);
		const s = source(result.source, material.founderUserId),
			key = sourceKey(s),
			changes = obj(material.changes);
		const digest = hash(result);
		if (changes[key] !== undefined) {
			if (changes[key] !== digest)
				throw new Error("meeting change source binding conflict");
			return meetingView(current);
		}
		if (current.stage !== "scheduled")
			throw new Error(
				"meeting must be scheduled before this change; settle active voice first",
			);
		const oldMeeting = obj(material.meeting),
			meeting = {
				...oldMeeting,
				revision: Number(material.meetingRevision) + 1,
				...(result.action === "reschedule"
					? { startsAt: result.startsAt, status: "rescheduled" }
					: { status: "cancelled" }),
			};
		const options = {
			...obj(material.options),
			...(result.action === "reschedule"
				? { durationMinutes: result.durationMinutes }
				: { endedAt: new Date(now).toISOString() }),
		};
		const record = toMeetingRecord(
			meeting as unknown as Meeting,
			options as unknown as MeetingRecordOptions,
		);
		stage = record.status;
		next = {
			...material,
			meeting,
			record: record as unknown as JsonValue,
			options,
			meetingRevision: meeting.revision,
			changes: { ...changes, [key]: digest },
			history: [
				...(material.history as JsonValue[]),
				{
					meetingRevision: material.meetingRevision,
					record: material.record,
					calendar: material.calendar ?? null,
					notification: material.notification ?? null,
					source: s,
				},
			],
			calendar: {
				status: "pending",
				...(material.calendar
					? { eventId: obj(material.calendar).eventId ?? null }
					: {}),
			},
		};
		delete next.notification;
	} else if (result.action === "calendar") {
		allowed(result, [
			"action",
			"meetingRevision",
			"status",
			"eventId",
			"reason",
		]);
		if (result.meetingRevision !== material.meetingRevision)
			throw new Error("meeting calendar revision mismatch");
		const states =
			stage === "cancelled"
				? ["cancelled", "unknown", "unavailable"]
				: ["synced", "unknown", "unavailable"];
		if (!states.includes(String(result.status)))
			throw new Error("invalid calendar status");
		if (
			["synced", "cancelled"].includes(String(result.status)) &&
			(typeof result.eventId !== "string" ||
				!result.eventId.trim() ||
				result.eventId.length > 500)
		)
			throw new Error("calendar event identity required");
		const old = material.calendar ? obj(material.calendar) : undefined;
		if (old?.eventId && result.eventId && old.eventId !== result.eventId)
			throw new Error("calendar event identity changed");
		next = {
			...material,
			calendar: {
				meetingRevision: result.meetingRevision,
				status: result.status,
				...(old?.eventId === undefined ? {} : { eventId: old.eventId }),
				...(result.eventId === undefined ? {} : { eventId: result.eventId }),
				...(result.reason === undefined
					? {}
					: { reason: sanitizeDiscordText(String(result.reason)) }),
			},
		};
	} else if (
		["prepare_notification", "confirm_notification"].includes(
			String(result.action),
		)
	) {
		next = meetingNotification(store, current, result);
	} else throw new Error("unsupported meeting action");
	next.receipts = [
		...(material.receipts as JsonValue[]),
		{
			tool: input.tool,
			callId: input.callId,
			action: result.action,
			recordedAt: now,
			meetingRevision: next.meetingRevision,
			...(result.action === "calendar" ? { calendar: next.calendar } : {}),
		},
	];
	return meetingView(
		store.commit({ ...current, stage, material: next }, current.revision),
	);
}
export function meetingView(current: StoredOperation): BusinessRoundView {
	const material = obj(current.material);
	const notification =
		material.notification === undefined
			? undefined
			: obj(material.notification);
	return {
		schemaVersion: 2,
		operationId: current.operationId,
		revision: current.revision,
		stage: current.stage,
		next:
			meetingVoiceNext(current) ??
			(notification?.status === "pending"
				? {
						tool: "current_turn",
						arguments: {
							action: "send_meeting_notification",
							input: notification.input,
							instructions:
								"Prepare or resume this exact announcement; confirm_notification only after its actual sent and engagement-ready receipt. Calendar success is independent.",
						},
					}
				: {
						tool: "current_turn",
						arguments: {
							action: "reconcile_meeting",
							meetingRevision: material.meetingRevision,
							record: material.record,
							calendar: material.calendar ?? null,
							notification: material.notification ?? null,
							instructions:
								"Keep calendar and notification outcomes separate. Preserve the same calendar eventId across revisions. Trusted record projection and public voice start require their own confirmed steps.",
						},
					}),
		needsReconciliation:
			notification?.status === "legacy_unknown" ||
			(material.calendar !== undefined &&
				obj(material.calendar).status === "unknown") ||
			(Boolean(material.voiceCall) &&
				(obj(material.voiceCall).inFlight === true ||
					obj(material.voiceCall).outcome === "unknown")),
		receipts: material.receipts as Obj[],
		material,
	};
}
