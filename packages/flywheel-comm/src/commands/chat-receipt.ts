import { CommDB } from "../db.js";
import {
	assertUtcIsoTimestamp,
	CHAT_DELIVERY_UNCONFIRMED_REASON,
	MailboxQueue,
} from "../mailbox-queue.js";
import { encodeSenderRef } from "../sender-ref.js";

const ENVELOPE_PREFIX = "[discord-chat-receipt v1] ";
const DISCORD_SNOWFLAKE = /^\d+$/;

export type ChatReceiptMessageKind = "dm" | "guild" | "roundtable";

export interface ChatReceiptAttachment {
	name: string;
	type: string;
	sizeKb: number;
}

export interface ChatReceiptEnvelopeV1 {
	v: 1;
	receiptId: string;
	leadId: string;
	chatId: string;
	originChannelId: string;
	messageId: string;
	authorId: string;
	authorName: string;
	ts: string;
	priority: 0 | 1;
	msgKind: ChatReceiptMessageKind;
	attachments: ChatReceiptAttachment[];
	text: string;
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

function priority(value: unknown): 0 | 1 {
	if (value !== 0 && value !== 1) {
		throw new Error("priority must be 0 or 1");
	}
	return value;
}

function messageKind(value: unknown): ChatReceiptMessageKind {
	if (value !== "dm" && value !== "guild" && value !== "roundtable") {
		throw new Error("msgKind must be dm, guild, or roundtable");
	}
	return value;
}

function attachments(value: unknown): ChatReceiptAttachment[] {
	if (!Array.isArray(value)) {
		throw new Error("attachments must be an array");
	}
	return value.map((attachment, index) => {
		if (!attachment || typeof attachment !== "object") {
			throw new Error(`attachments[${index}] must be an object`);
		}
		const candidate = attachment as Record<string, unknown>;
		const sizeKb = candidate.sizeKb;
		if (typeof sizeKb !== "number" || !Number.isFinite(sizeKb) || sizeKb < 0) {
			throw new Error(`attachments[${index}].sizeKb must be non-negative`);
		}
		return {
			name: requiredText(candidate.name, `attachments[${index}].name`),
			type: requiredText(candidate.type, `attachments[${index}].type`),
			sizeKb,
		};
	});
}

export function chatReceiptId(leadId: string, messageId: string): string {
	return `chat:${requiredText(leadId, "leadId")}:${snowflake(
		messageId,
		"messageId",
	)}`;
}

function normalizeEnvelope(
	value: Record<string, unknown>,
): ChatReceiptEnvelopeV1 {
	if (value.v !== 1) throw new Error("chat receipt v1 envelope is required");
	const leadId = requiredText(value.leadId, "leadId");
	const messageId = snowflake(value.messageId, "messageId");
	const receiptId = requiredText(value.receiptId, "receiptId");
	if (receiptId !== chatReceiptId(leadId, messageId)) {
		throw new Error(
			"chat receipt v1 envelope receiptId does not match its route",
		);
	}
	const ts = requiredText(value.ts, "ts");
	assertUtcIsoTimestamp(ts, "ts");
	if (typeof value.text !== "string") {
		throw new Error("text must be a string");
	}
	return {
		v: 1,
		receiptId,
		leadId,
		chatId: snowflake(value.chatId, "chatId"),
		originChannelId: snowflake(value.originChannelId, "originChannelId"),
		messageId,
		authorId: snowflake(value.authorId, "authorId"),
		authorName: requiredText(value.authorName, "authorName"),
		ts,
		priority: priority(value.priority),
		msgKind: messageKind(value.msgKind),
		attachments: attachments(value.attachments),
		text: value.text,
	};
}

export function parseChatReceiptEnvelope(
	content: string,
): ChatReceiptEnvelopeV1 {
	const firstLine = content.split("\n", 1)[0] ?? "";
	if (!firstLine.startsWith(ENVELOPE_PREFIX)) {
		throw new Error("chat receipt v1 envelope header is missing");
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(firstLine.slice(ENVELOPE_PREFIX.length));
	} catch (error) {
		throw new Error(
			`chat receipt v1 envelope JSON is invalid: ${(error as Error).message}`,
		);
	}
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new Error("chat receipt v1 envelope must be an object");
	}
	return normalizeEnvelope(decoded as Record<string, unknown>);
}

export interface BeginChatReceiptArgs {
	dbPath: string;
	leadId: string;
	chatId: string;
	originChannelId: string;
	messageId: string;
	authorId: string;
	authorName: string;
	priority: 0 | 1;
	ts: string;
	msgKind: ChatReceiptMessageKind;
	attachments: ChatReceiptAttachment[];
	text: string;
}

export function beginChatReceipt(args: BeginChatReceiptArgs): {
	receiptId: string;
	seq: number;
} {
	const envelope = normalizeEnvelope({
		v: 1,
		receiptId: chatReceiptId(args.leadId, args.messageId),
		leadId: args.leadId,
		chatId: args.chatId,
		originChannelId: args.originChannelId,
		messageId: args.messageId,
		authorId: args.authorId,
		authorName: args.authorName,
		ts: args.ts,
		priority: args.priority,
		msgKind: args.msgKind,
		attachments: args.attachments,
		text: args.text,
	});
	const queue = new MailboxQueue(args.dbPath);
	try {
		const row = queue.enqueue({
			id: envelope.receiptId,
			fromAgent: "founder",
			toAgent: envelope.leadId,
			recipientKind: "lead",
			sourceKind: "discord_chat",
			sourceRef: envelope.receiptId,
			type: "external_delivery",
			msgClass: "model",
			priority: envelope.priority,
			content: `${ENVELOPE_PREFIX}${JSON.stringify(envelope)}\n${envelope.authorName}: ${envelope.text}`,
			refId: null,
			createdAt: envelope.ts,
			carrier: "external",
			senderRef: encodeSenderRef(),
		});
		if (row.outcome === "archived") {
			throw new Error(
				`chat receipt was already archived: ${envelope.receiptId}`,
			);
		}
		return { receiptId: row.row.id, seq: row.row.seq };
	} finally {
		queue.close();
	}
}

export function completeChatReceipt(args: {
	dbPath: string;
	leadId: string;
	messageId: string;
	now: string;
	env?: Record<string, string | undefined>;
}): { receiptId: string; delivered: true } {
	const receiptId = chatReceiptId(args.leadId, args.messageId);
	const queue = new MailboxQueue(args.dbPath);
	try {
		if (!queue.markExternalDelivered(receiptId, args.now)) {
			throw new Error(`chat receipt not found or not external: ${receiptId}`);
		}
		return { receiptId, delivered: true };
	} finally {
		queue.close();
	}
}

export function settleChatReceipt(args: {
	dbPath: string;
	leadId: string;
	messageId: string;
	replyId: string;
	now: string;
}): { receiptId: string; processed: true } {
	const receiptId = chatReceiptId(args.leadId, args.messageId);
	const replyId = snowflake(args.replyId, "replyId");
	const queue = new MailboxQueue(args.dbPath);
	try {
		queue.settle({
			messageOrDeliveryId: receiptId,
			event: "processed",
			now: args.now,
			evidence: {
				v: 1,
				kind: "discord_explicit_reply",
				ref: replyId,
				actor: requiredText(args.leadId, "leadId"),
				actor_kind: "lead",
				fence: {
					leadId: requiredText(args.leadId, "leadId"),
					chatReplyTo: snowflake(args.messageId, "messageId"),
				},
				basis: ["discord_reply_reference"],
			},
		});
		return { receiptId, processed: true };
	} finally {
		queue.close();
	}
}

export interface PendingChatReceiptRow {
	seq: number;
	id: string;
	createdAt: string;
	envelope: ChatReceiptEnvelopeV1 | null;
	parse_error?: string;
}

export function listPendingChatReceipts(args: {
	dbPath: string;
	leadId: string;
	cursorSeq?: number;
	limit?: number;
	createdBefore?: string;
	excludeQuarantined?: boolean;
}): { rows: PendingChatReceiptRow[]; nextCursor: number } {
	const leadId = requiredText(args.leadId, "leadId");
	const db = new CommDB(args.dbPath, false);
	try {
		const sourceRows = db.listChatReceiptPending({
			toLead: leadId,
			cursorSeq: args.cursorSeq,
			limit: args.limit,
			createdBefore: args.createdBefore,
			excludeQuarantined: args.excludeQuarantined,
		});
		const rows = sourceRows.map((row): PendingChatReceiptRow => {
			try {
				return {
					seq: row.seq,
					id: row.id,
					createdAt: row.created_at,
					envelope: parseChatReceiptEnvelope(row.content),
				};
			} catch (error) {
				return {
					seq: row.seq,
					id: row.id,
					createdAt: row.created_at,
					envelope: null,
					parse_error: (error as Error).message,
				};
			}
		});
		return {
			rows,
			nextCursor: rows.at(-1)?.seq ?? args.cursorSeq ?? 0,
		};
	} finally {
		db.close();
	}
}

export function quarantineChatReceipt(args: {
	dbPath: string;
	leadId: string;
	messageId: string;
	now: string;
}): { receiptId: string; quarantined: true } {
	const receiptId = chatReceiptId(args.leadId, args.messageId);
	const db = new CommDB(args.dbPath, false);
	try {
		if (!db.quarantineChatReceipt({ receiptId, now: args.now })) {
			throw new Error(`chat receipt cannot be quarantined: ${receiptId}`);
		}
		return { receiptId, quarantined: true };
	} finally {
		db.close();
	}
}

export function chatReceiptQuarantineReason(): string {
	return CHAT_DELIVERY_UNCONFIRMED_REASON;
}
