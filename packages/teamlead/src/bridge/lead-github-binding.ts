import type { CommDB } from "flywheel-comm/db";
import type { StateStore } from "../StateStore.js";
/** Bridge-owned live evidence only. Retention deletion revokes this binding; no cache or new owner table. */
export function assertLeadGithubPrBinding(options: {
	store: StateStore;
	comm: CommDB;
	projectName: string;
	leadId: string;
	prNumber: number;
	headRef?: string;
	assertCurrent(): void;
}) {
	const denied = () => new Error("pr_not_bound_to_lead");
	options.assertCurrent();
	const sessions = options.store.getProjectPrSessions(
		options.projectName,
		options.prNumber,
	);
	if (
		sessions.length === 0 ||
		sessions.length > 100 ||
		new Set(sessions.map((s) => s.issue_id)).size !== 1
	)
		throw denied();
	for (const session of sessions) {
		const owner = options.comm.getSession(session.execution_id);
		if (
			session.project_name !== options.projectName ||
			session.pr_number !== options.prNumber ||
			!session.issue_id ||
			!owner ||
			owner.project_name !== options.projectName ||
			owner.issue_id !== session.issue_id ||
			owner.lead_id !== options.leadId ||
			(options.headRef !== undefined &&
				(!session.branch || session.branch !== options.headRef))
		)
			throw denied();
	}
	options.assertCurrent();
	return {
		executionIds: sessions.map((s) => s.execution_id),
		issueId: sessions[0]!.issue_id,
	};
}
