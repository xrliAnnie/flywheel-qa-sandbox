import type { ActionHandler, ActionResult } from "../ReactionsEngine.js";
import type { SlackAction } from "../SlackInteractionServer.js";
import { postSlackResponse } from "./postSlackResponse.js";

export class RejectHandler implements ActionHandler {
	async execute(action: SlackAction): Promise<ActionResult> {
		const msg = `Issue ${action.issueId} rejected by <@${action.userId}>`;
		await postSlackResponse(action.responseUrl, msg);
		return { success: true, message: msg, alreadyResponded: true };
	}
}
