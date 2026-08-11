import { ingestDiscordChat } from "flywheel-comm/discord-chat-ingest";
import type { MailboxQueue } from "flywheel-comm/mailbox-queue";
import type { DiscordInboundMessage } from "./CodexDiscordGateway.js";
import type { ExternalReceiptSaga } from "./ExternalReceiptSaga.js";
import type { LeadInputRouter } from "./LeadInputRouter.js";
import type { LeadJournal } from "./LeadJournal.js";
import type { RoundtableReplyRoute } from "./roundtable-reply-route.js";

export interface CodexDiscordMailboxStrategyOptions {
	leadId: string;
	founderId?: string;
	dbPath: string;
	queue: MailboxQueue;
	journal: Pick<LeadJournal, "getByIdempotencyKey">;
	router: Pick<LeadInputRouter, "submit">;
	externalReceiptSaga: Pick<ExternalReceiptSaga, "complete">;
	mailboxReady?: () => boolean;
	logger?: { warn: (message: string, context?: unknown) => void };
}

export class CodexDiscordMailboxStrategy {
	private readonly logger: NonNullable<
		CodexDiscordMailboxStrategyOptions["logger"]
	>;

	constructor(private readonly opts: CodexDiscordMailboxStrategyOptions) {
		this.logger = opts.logger ?? {
			warn: (message, context) => console.warn(message, context ?? ""),
		};
	}

	accept(input: {
		message: DiscordInboundMessage;
		payload: string;
		createdAt: string;
		replyChannelId?: string;
		replyRoute?: RoundtableReplyRoute;
	}): "handled" | "legacy" | "retry" {
		const { message } = input;
		try {
			const accepted = this.opts.journal.getByIdempotencyKey(message.id);
			const xdept = this.opts.queue.getById(
				`xdept:${this.opts.leadId}:${message.id}`,
			);
			if (accepted) {
				if (xdept && xdept.state !== "ACKED") {
					this.opts.externalReceiptSaga.complete(message.id);
				}
				return "handled";
			}
			if (xdept && xdept.state !== "ACKED" && xdept.state !== "DEAD") {
				this.opts.router.submit({
					idempotencyKey: message.id,
					source: "discord",
					payload: input.payload,
					...(input.replyChannelId
						? { replyChannelId: input.replyChannelId }
						: {}),
					...(input.replyRoute ? { replyRoute: input.replyRoute } : {}),
				});
				this.opts.externalReceiptSaga.complete(message.id);
				return "handled";
			}
			if (
				this.opts.queue.getIdentityCarrier(
					`chat:${this.opts.leadId}:${message.id}`,
				) !== undefined
			) {
				return "handled";
			}
			if (this.opts.mailboxReady && !this.opts.mailboxReady()) return "retry";
			ingestDiscordChat({
				dbPath: this.opts.dbPath,
				leadId: this.opts.leadId,
				chatId: message.channelId,
				originChannelId: message.channelId,
				messageId: message.id,
				authorId: message.authorId,
				authorName: message.authorId,
				ts: input.createdAt,
				msgKind: input.replyRoute ? "roundtable" : "guild",
				attachments: [],
				text: input.payload,
				...(this.opts.founderId ? { founderId: this.opts.founderId } : {}),
				...(input.replyChannelId
					? { replyChannelId: input.replyChannelId }
					: {}),
				...(input.replyRoute ? { replyRoute: input.replyRoute } : {}),
			});
			return "handled";
		} catch (error) {
			this.logger.warn("discord_mailbox_ingest_failed", {
				messageId: message.id,
				error: (error as Error).message,
			});
			return "retry";
		}
	}
}
