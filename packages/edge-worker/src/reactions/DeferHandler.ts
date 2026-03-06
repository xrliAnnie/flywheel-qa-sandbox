import type { ActionHandler, ActionResult } from "../ReactionsEngine.js";
import type { SlackAction } from "../SlackInteractionServer.js";
import { postSlackResponse } from "./postSlackResponse.js";

export class DeferHandler implements ActionHandler {
	async execute(action: SlackAction): Promise<ActionResult> {
		const msg = `Issue ${action.issueId} deferred by <@${action.userId}> — will revisit later`;
		await postSlackResponse(action.responseUrl, msg);
		return { success: true, message: msg };
	}
}
