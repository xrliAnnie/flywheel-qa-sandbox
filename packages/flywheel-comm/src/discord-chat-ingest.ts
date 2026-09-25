import { createHash } from "node:crypto";
import {
	type ChatDeliveryAttachment,
	type ChatDeliveryEnvelopeV1,
	type ChatDeliveryMessageKind,
	chatDeliveryId,
	encodeChatDeliveryEnvelope,
	normalizeChatDeliveryEnvelope,
	parseChatDeliveryEnvelope,
} from "./chat-delivery-envelope.js";
import {
	assertUtcIsoTimestamp,
	type DiscordLaneVerdict,
	MailboxQueue,
} from "./mailbox-queue.js";
import { encodeSenderRef } from "./sender-ref.js";

// 529 roundtrip probes consume the canonical envelope through this public
// package entrypoint, including its thread reply route.
export { chatDeliveryId };
export { parseChatDeliveryEnvelope };
export type { ChatDeliveryEnvelopeV1 };

export const DISCORD_WIRING_BROKEN_STALE_REASON = "discord_wiring_broken_stale";

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
	origin?: ChatDeliveryEnvelopeV1["origin"];
	voiceSessionId?: string;
	voiceHandoff?: ChatDeliveryEnvelopeV1["voiceHandoff"];
	heldSince?: string;
	heldReason?: ChatDeliveryEnvelopeV1["heldReason"];
	deadLetter?: {
		reason: typeof DISCORD_WIRING_BROKEN_STALE_REASON;
		at: string;
	};
	founderId?: string;
	replyChannelId?: string;
	replyRoute?: ChatDeliveryEnvelopeV1["replyRoute"];
	replyTo?: ChatDeliveryEnvelopeV1["replyTo"];
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

function voiceDeliveryPreamble(
	handoff: ChatDeliveryEnvelopeV1["voiceHandoff"],
): string {
	if (!handoff)
		return "[voice] 这句话是 founder 口述并会被念给她听;请在本 thread 用可说出口的短句回复。";
	const agenda = handoff.agenda;
	if (agenda?.kind === "brief")
		return `[voice agenda] 这是语音模式层发给你的议程请求（purpose=${agenda.purpose}），不是 founder 说的话。请按下文写出你要对她说的话，用 \`flywheel-comm voice agenda say --request ${handoff.handoffId} …\` 提交；不要把原文或清单交给她念。`;
	if (agenda?.kind === "turn")
		return `[voice handoff] 这是 founder 明确交给 Lead 的请求；她是在语音议程件 ${agenda.itemKey}（${agenda.itemState === "active" ? "当前正在谈" : "已经结束"}）进行中说的。请用 \`flywheel-comm voice agenda say --request ${handoff.handoffId}${agenda.answerKey ? ` --key ${agenda.answerKey}` : ""} --item ${agenda.itemKey} …\` 回答${agenda.itemState === "active" ? "，她拍板后用 `voice agenda close` 处置这一件" : "（这件已结束，只做说明，不能 close）"}。`;
	return "[voice handoff] 这是 founder 明确交给 Lead 的请求；请由 Lead 判断和执行，并在回复中保留 handoff 关联。";
}

export function renderDiscordChatContent(
	envelope: ChatDeliveryEnvelopeV1,
): string {
	const attrs = {
		source: envelope.origin === "voice" ? "voice" : "plugin:discord:discord",
		...(envelope.voiceSessionId
			? { "voice-session": envelope.voiceSessionId }
			: {}),
		...(envelope.voiceHandoff
			? {
					handoff_id: envelope.voiceHandoff.handoffId,
					handoff_intent: envelope.voiceHandoff.intentKind,
					...(envelope.voiceHandoff.agenda
						? {
								agenda_kind: envelope.voiceHandoff.agenda.kind,
								agenda_item: envelope.voiceHandoff.agenda.itemKey ?? "none",
							}
						: {}),
				}
			: {}),
		chat_id: envelope.chatId,
		message_id: envelope.messageId,
		user: envelope.authorName,
		user_id: envelope.authorId,
		ts: envelope.ts,
		delivery_id: envelope.deliveryId,
		...(envelope.replyTo
			? {
					reply_to_message_id: envelope.replyTo.messageId,
					reply_to_channel_id: envelope.replyTo.channelId,
					...(envelope.replyTo.authorId
						? { reply_to_user_id: envelope.replyTo.authorId }
						: {}),
				}
			: {}),
		...(envelope.heldSince
			? {
					held_since: envelope.heldSince,
					held_reason: envelope.heldReason as string,
				}
			: {}),
	};
	const visibleAttachments = envelope.attachments.slice(0, 10);
	const attachments = visibleAttachments.map((attachment) => {
		const contentState = attachment.attachmentId
			? "metadata_only"
			: "unavailable";
		return `<attachment name="${escapeXml(attachment.name)}" type="${escapeXml(attachment.type)}" size_kb="${attachment.sizeKb}"${attachment.attachmentId ? ` attachment_id="${escapeXml(attachment.attachmentId)}"` : ""} content_state="${contentState}"${attachment.unavailableReason ? ` reason="${escapeXml(attachment.unavailableReason)}"` : ""} />`;
	});
	const omittedAttachmentCount =
		envelope.attachments.length - attachments.length;
	const body = [
		...(envelope.origin === "voice"
			? [voiceDeliveryPreamble(envelope.voiceHandoff)]
			: []),
		escapeXmlText(envelope.text),
		...attachments,
		...(omittedAttachmentCount > 0
			? [
					`<attachments_unavailable count="${omittedAttachmentCount}" reason="attachment_limit_exceeded" />`,
				]
			: []),
		...(envelope.attachments.length > 0
			? [
					"这里仅有附件信息，未提供内容；请通过本会话已有附件读取工具获取，工具不存在则明确告知不可用。",
				]
			: []),
	];
	return `<channel ${Object.entries(attrs)
		.map(([key, value]) => `${key}="${escapeXml(value)}"`)
		.join(" ")}>\n${body.join("\n")}\n</channel>`;
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
	if (args.deadLetter) {
		if (!args.heldSince) throw new Error("deadLetter requires heldSince");
		if (args.deadLetter.reason !== DISCORD_WIRING_BROKEN_STALE_REASON) {
			throw new Error("deadLetter.reason is invalid");
		}
		assertUtcIsoTimestamp(args.deadLetter.at, "deadLetter.at");
	}
	if (
		args.msgKind === "roundtable" &&
		!args.replyChannelId &&
		!args.replyRoute
	) {
		throw new Error("roundtable Discord chat requires a reply route");
	}
	const founder = args.founderId === args.authorId;
	const identity = {
		...(args.origin ? { origin: args.origin } : {}),
		...(args.voiceSessionId ? { voiceSessionId: args.voiceSessionId } : {}),
		...(args.voiceHandoff ? { voiceHandoff: args.voiceHandoff } : {}),
	};
	const envelope = normalizeChatDeliveryEnvelope({
		v: 1,
		deliveryId: chatDeliveryId(args.leadId, args.messageId, identity),
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
		...(args.origin ? { origin: args.origin } : {}),
		...(args.voiceSessionId ? { voiceSessionId: args.voiceSessionId } : {}),
		...(args.voiceHandoff ? { voiceHandoff: args.voiceHandoff } : {}),
		...(args.heldSince ? { heldSince: args.heldSince } : {}),
		...(args.heldReason ? { heldReason: args.heldReason } : {}),
		...(args.replyChannelId ? { replyChannelId: args.replyChannelId } : {}),
		...(args.replyRoute ? { replyRoute: args.replyRoute } : {}),
		...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
	});
	// The first delivery owns its immutable content. Gateway/REST producers and
	// upgrade replays may carry different optional reference metadata. Returning
	// the existing lane rejects any rewrite without poisoning their cursors.
	return queue.claimDiscordLane({
		id: envelope.deliveryId,
		fromAgent: founder ? "founder" : `discord:${args.authorId}`,
		toAgent: envelope.leadId,
		recipientKind: "lead",
		sourceKind: envelope.origin === "voice" ? "voice" : "discord_chat",
		sourceRef: envelope.deliveryId,
		type: "discord_chat",
		msgClass: "model",
		priority: 1,
		content: `${encodeChatDeliveryEnvelope(envelope)}\n${envelope.authorName}: ${envelope.text}`,
		deliveryContent: renderDiscordChatContent(envelope),
		createdAt: envelope.ts,
		carrier: "inbox",
		collapseKey: envelope.heldSince ? `discord-held:${envelope.chatId}` : null,
		senderRef: encodeSenderRef(),
		...(args.deadLetter ? { deadLetter: args.deadLetter } : {}),
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
		// A Lead reply is bound back to exactly one voice handoff, so a handoff
		// never shares a journal entry with other chat on the same route.
		if (envelope.voiceHandoff) {
			return `voice-handoff:${envelope.voiceHandoff.handoffId}`;
		}
		const route = JSON.stringify({
			chatId: envelope.chatId,
			replyChannelId: envelope.replyChannelId ?? null,
			replyRoute: envelope.replyRoute ?? null,
			...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
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
