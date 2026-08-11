import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type ChatDeliveryAttachment,
	type ChatDeliveryEnvelopeV1,
	type ChatDeliveryMessageKind,
	chatDeliveryId,
	encodeChatDeliveryEnvelope,
	normalizeChatDeliveryEnvelope,
	parseChatDeliveryEnvelope,
} from "./chat-delivery-envelope.js";
import { type DiscordLaneVerdict, MailboxQueue } from "./mailbox-queue.js";
import { encodeSenderRef } from "./sender-ref.js";

export const MAILBOX_DISCORD_ENV = "FLYWHEEL_MAILBOX_DISCORD";

export interface IngestDiscordChatArgs {
	dbPath: string;
	leadId: string;
	chatId: string;
	originChannelId: string;
	messageId: string;
	authorId: string;
	authorName: string;
	ts: string;
	msgKind: ChatDeliveryMessageKind;
	attachments: ChatDeliveryAttachment[];
	text: string;
	founderId?: string;
	replyChannelId?: string;
	replyRoute?: ChatDeliveryEnvelopeV1["replyRoute"];
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

function escapeXmlText(value: string): string {
	return value
		.replaceAll("<", "&lt;")
		.replace(/\p{Cc}/gu, (char) =>
			char === "\n" || char === "\r" || char === "\t" ? char : "�",
		);
}

export function renderDiscordChatContent(
	envelope: ChatDeliveryEnvelopeV1,
): string {
	const attrs = {
		source: "plugin:discord:discord",
		chat_id: envelope.chatId,
		message_id: envelope.messageId,
		user: envelope.authorName,
		user_id: envelope.authorId,
		ts: envelope.ts,
		delivery_id: envelope.deliveryId,
	};
	const attachments = envelope.attachments.map(
		(attachment) =>
			`<attachment name="${escapeXml(attachment.name)}" type="${escapeXml(attachment.type)}" size_kb="${attachment.sizeKb}" />`,
	);
	return `<channel ${Object.entries(attrs)
		.map(([key, value]) => `${key}="${escapeXml(value)}"`)
		.join(
			" ",
		)}>\n${[escapeXmlText(envelope.text), ...attachments].join("\n")}\n</channel>`;
}

export function ingestDiscordChat(
	args: IngestDiscordChatArgs,
): DiscordLaneVerdict {
	const queue = new MailboxQueue(args.dbPath);
	try {
		return ingestDiscordChatOnQueue(queue, args);
	} finally {
		queue.close();
	}
}

export function ingestDiscordChatOnQueue(
	queue: MailboxQueue,
	args: IngestDiscordChatArgs,
): DiscordLaneVerdict {
	if (
		args.msgKind === "roundtable" &&
		!args.replyChannelId &&
		!args.replyRoute
	) {
		throw new Error("roundtable Discord chat requires a reply route");
	}
	const founder = args.founderId === args.authorId;
	const envelope = normalizeChatDeliveryEnvelope({
		v: 1,
		deliveryId: chatDeliveryId(args.leadId, args.messageId),
		leadId: args.leadId,
		chatId: args.chatId,
		originChannelId: args.originChannelId,
		messageId: args.messageId,
		authorId: args.authorId,
		authorName: args.authorName,
		ts: args.ts,
		priority: 1,
		msgKind: args.msgKind,
		attachments: args.attachments,
		text: args.text,
		...(args.replyChannelId ? { replyChannelId: args.replyChannelId } : {}),
		...(args.replyRoute ? { replyRoute: args.replyRoute } : {}),
	});
	return queue.claimDiscordLane({
		id: envelope.deliveryId,
		fromAgent: founder ? "founder" : `discord:${args.authorId}`,
		toAgent: envelope.leadId,
		recipientKind: "lead",
		sourceKind: "discord_chat",
		sourceRef: envelope.deliveryId,
		type: "discord_chat",
		msgClass: "model",
		priority: 1,
		content: `${encodeChatDeliveryEnvelope(envelope)}\n${envelope.authorName}: ${envelope.text}`,
		deliveryContent: renderDiscordChatContent(envelope),
		createdAt: envelope.ts,
		carrier: "inbox",
		collapseKey: null,
		senderRef: encodeSenderRef(),
	});
}

export function discordBatchPartitionKey(row: {
	type: string;
	delivery_id: string;
	content: string;
}): string {
	if (row.type !== "discord_chat") return "model";
	try {
		const envelope = parseChatDeliveryEnvelope(row.content);
		const route = JSON.stringify({
			chatId: envelope.chatId,
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
	replyRoute?: NonNullable<ChatDeliveryEnvelopeV1["replyRoute"]>;
} {
	const envelope = parseChatDeliveryEnvelope(content);
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
