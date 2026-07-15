import type { ReconnectController } from "../HeartbeatService.js";
import type { IssueDisplayRefreshHandle } from "./issue-display-refresher.js";

/** Release reconnect-title ownership and converge each affected issue once. */
export function settleReconnectTitlesAndRefresh(
	reconnect: ReconnectController,
	refresher: IssueDisplayRefreshHandle,
	executionIds?: readonly string[],
): string[] {
	const affected =
		executionIds === undefined
			? reconnect.settleReconnectTitles()
			: reconnect.settleReconnectTitles(executionIds);
	const issueIds = [...new Set(affected.map((session) => session.issue_id))];
	for (const issueId of issueIds) refresher.enqueue(issueId);
	return issueIds;
}
