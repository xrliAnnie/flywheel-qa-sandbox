import { App } from "@slack/bolt";
import type { SlackAction, ActionResult } from "flywheel-edge-worker";
import { parseActionId } from "flywheel-edge-worker";

export interface SlackBotDeps {
	reactionsDispatch: (action: SlackAction) => Promise<ActionResult>;
}

/**
 * Slack Bot using Socket Mode (@slack/bolt).
 * Outbound WebSocket — no public URL needed.
 */
export class SlackBot {
	private app: App;

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
	}

	async start(): Promise<void> {
		await this.app.start();
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
