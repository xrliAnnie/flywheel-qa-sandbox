import {
	VOICE_HANDOFF_INTENT_KINDS,
	type VoiceHandoffIntentKind,
} from "flywheel-voice-core";
import { assertUtcIsoTimestamp } from "./mailbox-queue.js";

export const CHAT_DELIVERY_ENVELOPE_PREFIX = "[discord-chat-delivery v1] ";
const LEGACY_CHAT_ENVELOPE_PREFIX = "[discord-chat-receipt v1] ";
const DISCORD_SNOWFLAKE = /^\d+$/;
const DISCORD_ATTACHMENT_SNOWFLAKE = /^\d{17,20}$/;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ChatDeliveryMessageKind = "dm" | "guild" | "roundtable";

export interface ChatDeliveryAttachment {
	attachmentId?: string;
	name: string;
	type: string;
	sizeKb: number;
	unavailableReason?: "invalid_metadata" | "producer_identity_missing";
}

/** FLY-2863: server-derived agenda facts (additive; older envelopes omit it).
 * `brief` is a mode-layer request to the Lead, never founder speech; `turn`
 * binds a founder handoff to the agenda item it started on. */
export type VoiceHandoffAgendaMetadata =
	| {
			kind: "brief";
			purpose: "open" | "item" | "urgent" | "resume" | "checkin";
			itemKey: string | null;
	  }
	| {
			kind: "turn";
			itemKey: string;
			turnId: string;
			itemState: "active" | "closed";
			/** Proves a `voice agenda` answer came from this delivery's reader. */
			answerKey?: string;
	  };

export interface VoiceHandoffMetadata {
	version: 1;
	handoffId: string;
	intentKind: VoiceHandoffIntentKind;
	requestDigest: string;
	targetLeadId: string;
	transcriptId: string;
	utteranceId: string;
	sessionGeneration: number;
	agenda?: VoiceHandoffAgendaMetadata;
}

const AGENDA_KEY = /^[A-Za-z0-9_.:@+-]{1,256}$/u;
const AGENDA_ANSWER_KEY = /^[A-Za-z0-9_-]{16,64}$/u;

function normalizeVoiceAgenda(value: unknown): VoiceHandoffAgendaMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("voiceHandoff.agenda must be an object");
	const input = value as Record<string, unknown>;
	const key = (candidate: unknown, field: string): string => {
		if (typeof candidate !== "string" || !AGENDA_KEY.test(candidate))
			throw new Error(`${field} is invalid`);
		return candidate;
	};
	if (input.kind === "brief") {
		if (
			!["open", "item", "urgent", "resume", "checkin"].includes(
				String(input.purpose),
			)
		)
			throw new Error("voiceHandoff.agenda.purpose is invalid");
		return {
			kind: "brief",
			purpose: input.purpose as Extract<
				VoiceHandoffAgendaMetadata,
				{ kind: "brief" }
			>["purpose"],
			itemKey:
				input.itemKey === null
					? null
					: key(input.itemKey, "voiceHandoff.agenda.itemKey"),
		};
	}
	if (input.kind === "turn") {
		if (input.itemState !== "active" && input.itemState !== "closed")
			throw new Error("voiceHandoff.agenda.itemState is invalid");
		if (
			input.answerKey !== undefined &&
			(typeof input.answerKey !== "string" ||
				!AGENDA_ANSWER_KEY.test(input.answerKey))
		)
			throw new Error("voiceHandoff.agenda.answerKey is invalid");
		return {
			kind: "turn",
			itemKey: key(input.itemKey, "voiceHandoff.agenda.itemKey"),
			turnId: key(input.turnId, "voiceHandoff.agenda.turnId"),
			itemState: input.itemState,
			...(input.answerKey === undefined
				? {}
				: { answerKey: input.answerKey as string }),
		};
	}
	throw new Error("voiceHandoff.agenda.kind is invalid");
}

export interface ChatDeliveryEnvelopeV1 {
	v: 1;
	deliveryId: string;
	leadId: string;
	chatId: string;
	originChannelId: string;
	messageId: string;
	authorId: string;
	authorName: string;
	ts: string;
	priority: 0 | 1;
	msgKind: ChatDeliveryMessageKind;
	attachments: ChatDeliveryAttachment[];
	text: string;
	origin?: "discord" | "voice";
	voiceSessionId?: string;
	voiceHandoff?: VoiceHandoffMetadata;
	heldSince?: string;
	heldReason?: "discord_wiring_broken";
	replyChannelId?: string;
	replyTo?: { messageId: string; channelId: string; authorId?: string };
	replyRoute?: {
		kind: "roundtable_thread_from_message";
		parentChannelId: string;
		sourceMessageId: string;
		threadId: string;
		threadName?: string;
	};
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${field} is required`);
	}
	return value.trim();
}

function snowflake(value: unknown, field: string): string {
	const parsed = requiredText(value, field);
	if (!DISCORD_SNOWFLAKE.test(parsed)) {
		throw new Error(`${field} must be a Discord snowflake`);
	}
	return parsed;
}

export interface ChatDeliveryIdentityContext {
	origin?: "discord" | "voice";
	voiceSessionId?: string;
	voiceHandoff?: VoiceHandoffMetadata | Record<string, unknown>;
}

function normalizeVoiceHandoff(value: unknown): VoiceHandoffMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("voiceHandoff must be an object");
	const input = value as Record<string, unknown>;
	if (input.version !== 1) throw new Error("voiceHandoff.version must be 1");
	const handoffId = requiredText(input.handoffId, "voiceHandoff.handoffId");
	if (!UUID.test(handoffId))
		throw new Error("voiceHandoff.handoffId must be a UUID");
	if (
		typeof input.intentKind !== "string" ||
		!VOICE_HANDOFF_INTENT_KINDS.includes(
			input.intentKind as VoiceHandoffIntentKind,
		)
	)
		throw new Error("voiceHandoff.intentKind is invalid");
	const requestDigest = requiredText(
		input.requestDigest,
		"voiceHandoff.requestDigest",
	);
	if (!SHA256.test(requestDigest))
		throw new Error("voiceHandoff.requestDigest must be sha256");
	if (
		!Number.isSafeInteger(input.sessionGeneration) ||
		(input.sessionGeneration as number) < 1
	)
		throw new Error("voiceHandoff.sessionGeneration is invalid");
	return {
		version: 1,
		handoffId,
		intentKind: input.intentKind as VoiceHandoffIntentKind,
		requestDigest,
		targetLeadId: requiredText(input.targetLeadId, "voiceHandoff.targetLeadId"),
		transcriptId: requiredText(input.transcriptId, "voiceHandoff.transcriptId"),
		utteranceId: requiredText(input.utteranceId, "voiceHandoff.utteranceId"),
		sessionGeneration: input.sessionGeneration as number,
		...(input.agenda === undefined
			? {}
			: { agenda: normalizeVoiceAgenda(input.agenda) }),
	};
}

export function chatDeliveryId(
	leadId: string,
	messageId: string,
	identity: ChatDeliveryIdentityContext = {},
): string {
	const normalizedLeadId = requiredText(leadId, "leadId");
	if (messageId.startsWith("voice-handoff:")) {
		if (identity.origin !== "voice" || !identity.voiceSessionId)
			throw new Error("synthetic messageId requires voice session binding");
		const handoff = normalizeVoiceHandoff(identity.voiceHandoff);
		if (handoff.targetLeadId !== normalizedLeadId)
			throw new Error("voice handoff target does not match leadId");
		if (messageId !== `voice-handoff:${handoff.handoffId}`)
			throw new Error("voice handoff messageId does not match handoffId");
		return `chat:${normalizedLeadId}:${messageId}`;
	}
	return `chat:${normalizedLeadId}:${snowflake(messageId, "messageId")}`;
}

export function normalizeChatDeliveryEnvelope(
	value: Record<string, unknown>,
): ChatDeliveryEnvelopeV1 {
	if (value.v !== 1) throw new Error("chat delivery v1 envelope is required");
	const leadId = requiredText(value.leadId, "leadId");
	if (
		value.origin !== undefined &&
		value.origin !== "discord" &&
		value.origin !== "voice"
	)
		throw new Error("origin must be discord or voice");
	if ((value.origin === "voice") !== (value.voiceSessionId !== undefined))
		throw new Error("origin and voiceSessionId must be provided together");
	const voiceSessionId =
		value.voiceSessionId === undefined
			? undefined
			: requiredText(value.voiceSessionId, "voiceSessionId");
	if (value.voiceHandoff !== undefined && !voiceSessionId)
		throw new Error("voiceHandoff requires a voice session binding");
	const voiceHandoff =
		value.voiceHandoff === undefined
			? undefined
			: normalizeVoiceHandoff(value.voiceHandoff);
	const messageId = voiceHandoff
		? requiredText(value.messageId, "messageId")
		: snowflake(value.messageId, "messageId");
	const deliveryId = requiredText(
		value.deliveryId ?? value.receiptId,
		"deliveryId",
	);
	if (
		deliveryId !==
		chatDeliveryId(leadId, messageId, {
			origin: value.origin as "discord" | "voice" | undefined,
			voiceSessionId,
			voiceHandoff,
		})
	) {
		throw new Error(
			"chat delivery v1 envelope deliveryId does not match route",
		);
	}
	const ts = requiredText(value.ts, "ts");
	assertUtcIsoTimestamp(ts, "ts");
	if (typeof value.text !== "string") throw new Error("text must be a string");
	if (value.priority !== 0 && value.priority !== 1) {
		throw new Error("priority must be 0 or 1");
	}
	if (
		value.msgKind !== "dm" &&
		value.msgKind !== "guild" &&
		value.msgKind !== "roundtable"
	) {
		throw new Error("msgKind must be dm, guild, or roundtable");
	}
	if (!Array.isArray(value.attachments)) {
		throw new Error("attachments must be an array");
	}
	const normalizedAttachments: ChatDeliveryAttachment[] = value.attachments.map(
		(attachment) => {
			const candidate =
				attachment &&
				typeof attachment === "object" &&
				!Array.isArray(attachment)
					? (attachment as Record<string, unknown>)
					: {};
			const nameValid =
				typeof candidate.name === "string" && candidate.name.trim().length > 0;
			const typeValid =
				typeof candidate.type === "string" && candidate.type.trim().length > 0;
			const sizeValid =
				typeof candidate.sizeKb === "number" &&
				Number.isFinite(candidate.sizeKb) &&
				candidate.sizeKb >= 0;
			const attachmentId =
				typeof candidate.attachmentId === "string" &&
				DISCORD_ATTACHMENT_SNOWFLAKE.test(candidate.attachmentId)
					? candidate.attachmentId
					: undefined;
			const idInvalid =
				candidate.attachmentId !== undefined && attachmentId === undefined;
			const declaredReasonValid =
				candidate.unavailableReason === undefined ||
				candidate.unavailableReason === "invalid_metadata" ||
				candidate.unavailableReason === "producer_identity_missing";
			const metadataInvalid =
				!nameValid ||
				!typeValid ||
				!sizeValid ||
				idInvalid ||
				!declaredReasonValid ||
				candidate.unavailableReason === "invalid_metadata" ||
				(attachmentId !== undefined &&
					candidate.unavailableReason !== undefined);
			return {
				name: nameValid ? (candidate.name as string).trim() : "attachment",
				type: typeValid
					? (candidate.type as string).trim()
					: "application/octet-stream",
				sizeKb: sizeValid ? (candidate.sizeKb as number) : 0,
				...(!metadataInvalid && attachmentId ? { attachmentId } : {}),
				...(metadataInvalid
					? { unavailableReason: "invalid_metadata" as const }
					: !attachmentId
						? { unavailableReason: "producer_identity_missing" as const }
						: {}),
			};
		},
	);
	const attachmentIdCounts = new Map<string, number>();
	for (const attachment of normalizedAttachments) {
		if (!attachment.attachmentId) continue;
		attachmentIdCounts.set(
			attachment.attachmentId,
			(attachmentIdCounts.get(attachment.attachmentId) ?? 0) + 1,
		);
	}
	const attachments = normalizedAttachments.map((attachment) => {
		if (
			!attachment.attachmentId ||
			attachmentIdCounts.get(attachment.attachmentId) === 1
		) {
			return attachment;
		}
		const { attachmentId: _duplicateId, ...metadata } = attachment;
		return { ...metadata, unavailableReason: "invalid_metadata" as const };
	});
	const replyChannelId =
		value.replyChannelId === undefined
			? undefined
			: snowflake(value.replyChannelId, "replyChannelId");
	if ((value.heldSince === undefined) !== (value.heldReason === undefined)) {
		throw new Error("heldSince and heldReason must be provided together");
	}
	let heldSince: string | undefined;
	let heldReason: ChatDeliveryEnvelopeV1["heldReason"];
	if (value.heldSince !== undefined) {
		heldSince = requiredText(value.heldSince, "heldSince");
		assertUtcIsoTimestamp(heldSince, "heldSince");
		if (value.heldReason !== "discord_wiring_broken") {
			throw new Error("heldReason must be discord_wiring_broken");
		}
		heldReason = value.heldReason;
	}
	let replyTo: ChatDeliveryEnvelopeV1["replyTo"];
	if (value.replyTo !== undefined) {
		if (
			!value.replyTo ||
			typeof value.replyTo !== "object" ||
			Array.isArray(value.replyTo)
		) {
			throw new Error("replyTo must be an object");
		}
		const reference = value.replyTo as Record<string, unknown>;
		replyTo = {
			messageId: snowflake(reference.messageId, "replyTo.messageId"),
			channelId: snowflake(reference.channelId, "replyTo.channelId"),
			...(reference.authorId === undefined
				? {}
				: { authorId: snowflake(reference.authorId, "replyTo.authorId") }),
		};
	}
	let replyRoute: ChatDeliveryEnvelopeV1["replyRoute"];
	if (value.replyRoute !== undefined) {
		if (
			!value.replyRoute ||
			typeof value.replyRoute !== "object" ||
			Array.isArray(value.replyRoute)
		) {
			throw new Error("replyRoute must be an object");
		}
		const route = value.replyRoute as Record<string, unknown>;
		if (route.kind !== "roundtable_thread_from_message") {
			throw new Error("replyRoute.kind is invalid");
		}
		replyRoute = {
			kind: route.kind,
			parentChannelId: snowflake(
				route.parentChannelId,
				"replyRoute.parentChannelId",
			),
			sourceMessageId: snowflake(
				route.sourceMessageId,
				"replyRoute.sourceMessageId",
			),
			threadId: snowflake(route.threadId, "replyRoute.threadId"),
			...(route.threadName === undefined
				? {}
				: {
						threadName: requiredText(route.threadName, "replyRoute.threadName"),
					}),
		};
	}
	return {
		v: 1,
		deliveryId,
		leadId,
		chatId: snowflake(value.chatId, "chatId"),
		originChannelId: snowflake(value.originChannelId, "originChannelId"),
		messageId,
		authorId: snowflake(value.authorId, "authorId"),
		authorName: requiredText(value.authorName, "authorName"),
		ts,
		priority: value.priority,
		msgKind: value.msgKind,
		attachments,
		text: value.text,
		...(value.origin ? { origin: value.origin } : {}),
		...(voiceSessionId ? { voiceSessionId } : {}),
		...(voiceHandoff ? { voiceHandoff } : {}),
		...(heldSince ? { heldSince, heldReason } : {}),
		...(replyChannelId ? { replyChannelId } : {}),
		...(replyRoute ? { replyRoute } : {}),
		...(replyTo ? { replyTo } : {}),
	};
}

export function encodeChatDeliveryEnvelope(
	envelope: ChatDeliveryEnvelopeV1,
): string {
	return `${CHAT_DELIVERY_ENVELOPE_PREFIX}${JSON.stringify(envelope)}`;
}

export function parseChatDeliveryEnvelope(
	content: string,
): ChatDeliveryEnvelopeV1 {
	const firstLine = content.split("\n", 1)[0] ?? "";
	const prefix = firstLine.startsWith(CHAT_DELIVERY_ENVELOPE_PREFIX)
		? CHAT_DELIVERY_ENVELOPE_PREFIX
		: firstLine.startsWith(LEGACY_CHAT_ENVELOPE_PREFIX)
			? LEGACY_CHAT_ENVELOPE_PREFIX
			: undefined;
	if (!prefix) throw new Error("chat delivery v1 envelope header is missing");
	let decoded: unknown;
	try {
		decoded = JSON.parse(firstLine.slice(prefix.length));
	} catch (error) {
		throw new Error(
			`chat delivery v1 envelope JSON is invalid: ${(error as Error).message}`,
		);
	}
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new Error("chat delivery v1 envelope must be an object");
	}
	return normalizeChatDeliveryEnvelope(decoded as Record<string, unknown>);
}
