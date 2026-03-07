import { App } from "@slack/bolt";
import type { SlackAction, ActionResult } from "flywheel-edge-worker";
import { parseActionId } from "flywheel-edge-worker";

export interface SlackBotDeps {
	reactionsDispatch: (action: SlackAction) => Promise<ActionResult>;
	onMessage?: (question: string, threadTs?: string) => Promise<string | null>;
	getThreadIssue?: (threadTs: string) => string | undefined;
	allowedUserIds?: string[];
	allowAllUsers?: boolean;
}

export function stripBotMention(text: string, botUserId: string): string {
	return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

/**
 * Slack Bot using Socket Mode (@slack/bolt).
 * Outbound WebSocket — no public URL needed.
 */
export class SlackBot {
	private app: App;
	private botUserId = "";

	constructor(
		botToken: string,
		appToken: string,
		private channelId: string,
		private deps: SlackBotDeps,
	) {
		this.app = new App({
			token: botToken,
			appToken: appToken,
			socketMode: true,
		});

		this.app.action(/^flywheel_/, async ({ action, body, ack, respond }) => {
			await ack();
			const slackAction = adaptBoltAction(action, body);
			const result = await this.deps.reactionsDispatch(slackAction);
			if (!result.alreadyResponded) {
				await respond({
					replace_original: false,
					text: result.success
						? `Action '${slackAction.action}' completed`
						: `Failed: ${result.message}`,
				});
			}
		});

		// @mention handler — responds when CEO @mentions the bot
		this.app.event("app_mention", async ({ event, say }) => {
			if (!this.deps.onMessage) return;
			if (!this.isAllowedUser(event.user)) return;
			if (event.channel !== this.channelId) return;

			const question = stripBotMention(event.text ?? "", this.botUserId);
			if (!question.trim()) return;

			const threadTs = event.thread_ts ?? event.ts;
			const response = await this.deps.onMessage(question, threadTs);
			if (response) {
				await say({ text: response, thread_ts: threadTs });
			}
		});

		// Thread message handler — responds in known notification threads
		this.app.message(async ({ message, say }) => {
			if (!this.deps.onMessage || !this.deps.getThreadIssue) return;

			const msg = message as any;
			if (msg.subtype || msg.bot_id) return;
			if (!msg.thread_ts) return;
			if (!this.isAllowedUser(msg.user)) return;
			if (msg.channel !== this.channelId) return;

			// Skip messages that mention THIS bot — app_mention handler covers those
			if (msg.text?.includes(`<@${this.botUserId}>`)) return;

			// Only respond in known threads (created by TemplateNotifier)
			const issueId = this.deps.getThreadIssue(msg.thread_ts);
			if (!issueId) return;

			const response = await this.deps.onMessage(msg.text ?? "", msg.thread_ts);
			if (response) {
				await say({ text: response, thread_ts: msg.thread_ts });
			}
		});
	}

	private isAllowedUser(userId: string | undefined): boolean {
		if (!userId) return false;
		if (this.deps.allowAllUsers) return true;
		if (!this.deps.allowedUserIds?.length) return false;
		return this.deps.allowedUserIds.includes(userId);
	}

	async start(): Promise<void> {
		await this.app.start();
		// Cache bot user ID for stripBotMention
		try {
			const authResult = await this.app.client.auth.test();
			this.botUserId = (authResult.user_id as string) ?? "";
		} catch {
			console.warn("[SlackBot] Could not retrieve bot user ID");
		}
	}

	async stop(): Promise<void> {
		await this.app.stop();
	}

	/**
	 * Post a Block Kit message to the configured channel.
	 * Returns the message_ts for thread tracking.
	 */
	async postMessage(
		text: string,
		blocks?: unknown[],
		threadTs?: string,
	): Promise<string | undefined> {
		const args: Record<string, unknown> = {
			channel: this.channelId,
			text,
		};
		if (blocks) args.blocks = blocks;
		if (threadTs) args.thread_ts = threadTs;

		const result = await this.app.client.chat.postMessage(args as any);
		return result.ts;
	}
}

/**
 * Convert @slack/bolt action payload to our SlackAction interface.
 * Reuses parseActionId from edge-worker for consistent parsing.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function adaptBoltAction(action: any, body: any): SlackAction {
	const actionId: string = action.action_id ?? "";
	const parsed = parseActionId(actionId);

	let executionId: string | undefined;
	try {
		const val =
			typeof action.value === "string"
				? JSON.parse(action.value)
				: undefined;
		const rawId = val?.executionId ?? val?.execution_id;
		// Validate executionId is a UUID to prevent injection
		if (typeof rawId === "string" && UUID_PATTERN.test(rawId)) {
			executionId = rawId;
		}
	} catch {
		/* ignore parse errors */
	}

	return {
		actionId,
		issueId: parsed?.issueId ?? "",
		action: parsed?.action ?? "",
		userId: body.user?.id ?? "unknown",
		responseUrl: body.response_url ?? "",
		messageTs: body.message?.ts ?? "",
		executionId,
	};
}
