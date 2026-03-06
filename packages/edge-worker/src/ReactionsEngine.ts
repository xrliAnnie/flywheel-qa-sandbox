import type { SlackAction } from "./SlackInteractionServer.js";

export interface ActionHandler {
	execute(action: SlackAction): Promise<ActionResult>;
}

export interface ActionResult {
	success: boolean;
	message: string;
	alreadyResponded?: boolean;
}

export class ReactionsEngine {
	private processed = new Set<string>();

	constructor(private handlers: Record<string, ActionHandler>) {}

	async dispatch(action: SlackAction): Promise<ActionResult> {
		// Dedup by actionId + messageTs
		const dedupKey = `${action.actionId}:${action.messageTs}`;
		if (this.processed.has(dedupKey)) {
			return {
				success: false,
				message: `Action already processed: ${action.actionId}`,
			};
		}

		const handler = this.handlers[action.action];
		if (!handler) {
			return {
				success: false,
				message: `No handler for action: ${action.action}`,
			};
		}

		try {
			const result = await handler.execute(action);
			this.processed.add(dedupKey);
			return result;
		} catch (err) {
			console.error(
				`[ReactionsEngine] Handler '${action.action}' failed for ${action.actionId}:`,
				err,
			);
			return {
				success: false,
				message: `Handler failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}
}
