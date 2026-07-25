import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";

type IssueThreadStore = Pick<
	StateStore,
	"getSessionByIdentifier" | "getChatThreadByIssue"
>;

/**
 * Resolve a report to the one existing Lead thread for an issue without a
 * Linear round-trip. Multiple matches fail closed because choosing one would
 * put founder feedback in the wrong department's thread.
 */
export function resolveProjectIssueThread(
	store: IssueThreadStore,
	projects: ProjectEntry[],
	issueIdentifier: string,
	projectName: string,
): string | undefined {
	const project = projects.find((entry) => entry.projectName === projectName);
	if (!project) return undefined;

	const issueKey =
		store.getSessionByIdentifier(issueIdentifier)?.issue_id ?? issueIdentifier;
	const threadIds = new Set<string>();
	const leadChannels = new Set(project.leads.map((lead) => lead.chatChannel));
	for (const channelId of leadChannels) {
		const thread = store.getChatThreadByIssue(issueKey, channelId);
		if (thread?.thread_id) threadIds.add(thread.thread_id);
	}

	return threadIds.size === 1 ? [...threadIds][0] : undefined;
}
