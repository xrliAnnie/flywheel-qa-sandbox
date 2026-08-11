import { assertUtcIsoTimestamp } from "./mailbox-queue.js";

export const CHAT_DELIVERY_ENVELOPE_PREFIX = "[discord-chat-delivery v1] ";
const LEGACY_CHAT_ENVELOPE_PREFIX = "[discord-chat-receipt v1] ";
const DISCORD_SNOWFLAKE = /^\d+$/;

export type ChatDeliveryMessageKind = "dm" | "guild" | "roundtable";

export interface ChatDeliveryAttachment {
	name: string;
	type: string;
	sizeKb: number;
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
	replyChannelId?: string;
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

export function chatDeliveryId(leadId: string, messageId: string): string {
	return `chat:${requiredText(leadId, "leadId")}:${snowflake(messageId, "messageId")}`;
}

export function normalizeChatDeliveryEnvelope(
	value: Record<string, unknown>,
): ChatDeliveryEnvelopeV1 {
	if (value.v !== 1) throw new Error("chat delivery v1 envelope is required");
	const leadId = requiredText(value.leadId, "leadId");
	const messageId = snowflake(value.messageId, "messageId");
	const deliveryId = requiredText(
		value.deliveryId ?? value.receiptId,
		"deliveryId",
	);
	if (deliveryId !== chatDeliveryId(leadId, messageId)) {
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
	const attachments = value.attachments.map((attachment, index) => {
		if (!attachment || typeof attachment !== "object") {
			throw new Error(`attachments[${index}] must be an object`);
		}
		const candidate = attachment as Record<string, unknown>;
		if (
			typeof candidate.sizeKb !== "number" ||
			!Number.isFinite(candidate.sizeKb) ||
			candidate.sizeKb < 0
		) {
			throw new Error(`attachments[${index}].sizeKb must be non-negative`);
		}
		return {
			name: requiredText(candidate.name, `attachments[${index}].name`),
			type: requiredText(candidate.type, `attachments[${index}].type`),
			sizeKb: candidate.sizeKb,
		};
	});
	const replyChannelId =
		value.replyChannelId === undefined
			? undefined
			: snowflake(value.replyChannelId, "replyChannelId");
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
		...(replyChannelId ? { replyChannelId } : {}),
		...(replyRoute ? { replyRoute } : {}),
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
