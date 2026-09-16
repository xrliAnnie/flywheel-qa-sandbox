import { CommDB } from "flywheel-comm/db";
import {
	createTerminalSessionCore,
	type TerminalSessionCoreOptions,
} from "flywheel-comm/terminal-observation";
import type { StateStore } from "../StateStore.js";

/** Per-request Bridge-owned adapter. The parent receives projected results, never a StateStore handle.
 * Session rows are live binding evidence; missing/pruned rows fail closed. No session
 * events or retained history are consumed and no database is created or migrated here. */
export function createLeadTerminalCore(
	options: {
		projectName: string;
		leadId: string;
		commDbPath: string;
		store: Pick<StateStore, "getSession">;
		authorizeIssue(issueId: string): Promise<() => void>;
	} & Pick<
		TerminalSessionCoreOptions,
		"assertCurrent" | "inspect" | "capture" | "send"
	>,
) {
	const denied = () => new Error("terminal_scope_denied");
	// Bind the operation to its first observed row; this is a comparison token,
	// not an authorization cache. Every read below still authorizes the live issue.
	let pinned: string | undefined;
	function read(executionId: string) {
		const canonical = options.store.getSession(executionId);
		if (!canonical || canonical.project_name !== options.projectName)
			throw denied();
		const db = CommDB.openReadonly(options.commDbPath);
		try {
			const row = db.getSession(executionId);
			if (
				!row ||
				row.project_name !== options.projectName ||
				(row.lead_id !== options.leadId && row.lead_id !== null) ||
				(row.issue_id !== canonical.issue_id &&
					row.issue_id !== canonical.issue_identifier)
			)
				throw denied();
			return {
				issueId: canonical.issue_id,
				issueIdentifier: canonical.issue_identifier,
				canonicalStatus: canonical.status,
				canonicalTarget: canonical.tmux_session,
				binding: {
					executionId: row.execution_id,
					projectName: row.project_name,
					leadId: row.lead_id,
					target: row.tmux_window,
					status: row.status,
				},
			};
		} finally {
			db.close();
		}
	}
	return createTerminalSessionCore({
		projectName: options.projectName,
		leadId: options.leadId,
		assertCurrent: options.assertCurrent,
		inspect: options.inspect,
		capture: options.capture,
		send: options.send,
		getSession: async (executionId) => {
			await options.assertCurrent();
			const before = read(executionId);
			const revision = JSON.stringify(before);
			if (pinned !== undefined && pinned !== revision)
				throw new Error("terminal_session_changed");
			pinned = revision;
			const guard = await options.authorizeIssue(before.issueId);
			await options.assertCurrent();
			guard();
			let after: ReturnType<typeof read>;
			try {
				after = read(executionId);
			} catch {
				throw new Error("terminal_session_changed");
			}
			if (JSON.stringify(before) !== JSON.stringify(after))
				throw new Error("terminal_session_changed");
			guard();
			return after.binding;
		},
	});
}
