import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import type { TerminalArchiveAdmission } from "./terminal-thread-archive.js";

/** Resolve only same-project session aliases; never borrow another issue's land. */
export function latestThreadLandOperation(
	store: StateStore,
	projectName: string,
	issueId: string,
) {
	const aliases = new Set([issueId]);
	for (const session of store.getSessionsForIssueAliases([issueId])) {
		if (session.project_name !== projectName) continue;
		aliases.add(session.issue_id);
		if (session.issue_identifier) aliases.add(session.issue_identifier);
	}
	return [...aliases]
		.map((key) => store.getLatestLandOperationForIssue(projectName, key))
		.filter((operation): operation is NonNullable<typeof operation> =>
			Boolean(operation),
		)
		.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

// Local successful-send observation only; no Discord listener or extra poller.
const observers = new Set<(threadId: string) => void>();

export function recordBotThreadSend(threadId: string): void {
	for (const observer of observers) {
		try {
			observer(threadId);
		} catch {
			// Rearchive admission must not cause a successful message to be resent.
			console.warn(`[bot-send-rearchive] admission failed for ${threadId}`);
		}
	}
}

export function watchIssueThreadBotSends(deps: {
	store: StateStore;
	projects: ProjectEntry[];
	enqueue: (issueId: string, threadId: string) => TerminalArchiveAdmission;
	log?: (message: string) => void;
}): () => void {
	const observer = (threadId: string) => {
		const thread = deps.store.getChatThreadByThreadId(threadId);
		if (!thread?.issue_id || thread.session_role !== "main") return;
		if (!deps.store.getChatThreadArchivedAt(threadId)) {
			const project = deps.projects.find((p) =>
				p.leads?.some(
					(lead) =>
						lead.agentId === thread.lead_id &&
						lead.chatChannel === thread.channel_id,
				),
			);
			if (!project) return;
			const land = latestThreadLandOperation(
				deps.store,
				project.projectName,
				thread.issue_id,
			);
			if (!land?.merge_confirmed_at) return;
			if (
				!deps.store
					.listLandOperationSteps(land.operation_id)
					.some(
						(step) =>
							step.step === "terminal_notified" &&
							step.receipt.threadId === threadId,
					)
			)
				return;
		}
		if (deps.enqueue(thread.issue_id, threadId) === "refused") {
			(deps.log ?? console.warn)(
				`[bot-send-rearchive] enqueue refused for ${threadId}; periodic reconcile remains the backstop`,
			);
		}
	};
	observers.add(observer);
	return () => {
		observers.delete(observer);
	};
}
