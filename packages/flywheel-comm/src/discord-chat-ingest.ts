import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type BeginChatReceiptArgs,
	type ChatReceiptEnvelopeV1,
	chatReceiptId,
	encodeChatReceiptEnvelope,
	normalizeChatReceiptEnvelope,
	parseChatReceiptEnvelope,
} from "./commands/chat-receipt.js";
import { type DiscordLaneVerdict, MailboxQueue } from "./mailbox-queue.js";
import { encodeSenderRef } from "./sender-ref.js";

export const MAILBOX_DISCORD_ENV = "FLYWHEEL_MAILBOX_DISCORD";

export interface IngestDiscordChatArgs
	extends Omit<BeginChatReceiptArgs, "priority"> {
	founderId?: string;
	replyChannelId?: string;
	replyRoute?: ChatReceiptEnvelopeV1["replyRoute"];
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;")
		.replace(/\p{Cc}/gu, (char) =>
			char === "\n" || char === "\r" || char === "\t" ? char : "�",
		);
}

export function renderDiscordChatContent(
	envelope: ChatReceiptEnvelopeV1,
): string {
	const attrs = {
		source: "discord",
		chat_id: envelope.chatId,
		message_id: envelope.messageId,
		user: envelope.authorName,
		user_id: envelope.authorId,
		ts: envelope.ts,
		receipt_id: envelope.receiptId,
	};
	const attachments = envelope.attachments.map(
		(attachment) =>
			`<attachment name="${escapeXml(attachment.name)}" type="${escapeXml(attachment.type)}" size_kb="${attachment.sizeKb}" />`,
	);
	return `<channel ${Object.entries(attrs)
		.map(([key, value]) => `${key}="${escapeXml(value)}"`)
		.join(
			" ",
		)}>\n${[escapeXml(envelope.text), ...attachments].join("\n")}\n</channel>`;
}

export function ingestDiscordChat(
	args: IngestDiscordChatArgs,
): DiscordLaneVerdict {
	const founder = args.founderId === args.authorId;
	const envelope = normalizeChatReceiptEnvelope({
		v: 1,
		receiptId: chatReceiptId(args.leadId, args.messageId),
		leadId: args.leadId,
		chatId: args.chatId,
		originChannelId: args.originChannelId,
		messageId: args.messageId,
		authorId: args.authorId,
		authorName: args.authorName,
		ts: args.ts,
		priority: founder ? 0 : 1,
		msgKind: args.msgKind,
		attachments: args.attachments,
		text: args.text,
		...(args.replyChannelId ? { replyChannelId: args.replyChannelId } : {}),
		...(args.replyRoute ? { replyRoute: args.replyRoute } : {}),
	});
	const queue = new MailboxQueue(args.dbPath);
	try {
		return queue.claimDiscordLane({
			id: envelope.receiptId,
			fromAgent: founder ? "founder" : `discord:${args.authorId}`,
			toAgent: envelope.leadId,
			recipientKind: "lead",
			sourceKind: "discord_chat",
			sourceRef: envelope.receiptId,
			type: "discord_chat",
			msgClass: "model",
			priority: founder ? 0 : 1,
			content: `${encodeChatReceiptEnvelope(envelope)}\n${envelope.authorName}: ${envelope.text}`,
			deliveryContent: renderDiscordChatContent(envelope),
			createdAt: envelope.ts,
			carrier: "inbox",
			collapseKey: null,
			senderRef: encodeSenderRef(),
		});
	} finally {
		queue.close();
	}
}

export function discordBatchPartitionKey(row: {
	type: string;
	delivery_id: string;
	content: string;
}): string {
	if (row.type !== "discord_chat") return "model";
	try {
		const envelope = parseChatReceiptEnvelope(row.content);
		const route = JSON.stringify({
			replyChannelId: envelope.replyChannelId ?? null,
			replyRoute: envelope.replyRoute ?? null,
		});
		return `discord-route:${createHash("sha256").update(route).digest("hex")}`;
	} catch {
		return `discord-invalid:${row.delivery_id}`;
	}
}

export function parseDiscordChatRoute(content: string): {
	replyChannelId?: string;
	replyRoute?: NonNullable<ChatReceiptEnvelopeV1["replyRoute"]>;
} {
	const envelope = parseChatReceiptEnvelope(content);
	return {
		...(envelope.replyChannelId
			? { replyChannelId: envelope.replyChannelId }
			: {}),
		...(envelope.replyRoute ? { replyRoute: envelope.replyRoute } : {}),
	};
}

export function readMailboxDiscordFlag(envPath: string): {
	enabled: boolean;
	readError?: string;
} {
	try {
		const prefix = `${MAILBOX_DISCORD_ENV}=`;
		const line = readFileSync(envPath, "utf8")
			.split(/\r?\n/)
			.find((candidate) => candidate.startsWith(prefix));
		return { enabled: line?.slice(prefix.length) === "1" };
	} catch (error) {
		return { enabled: false, readError: (error as Error).message };
	}
}
