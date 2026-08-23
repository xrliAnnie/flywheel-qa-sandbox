import type { AutoQaRecord, StateStore } from "../../StateStore.js";

type TestDb = { run(sql: string, params?: unknown[]): void };

function db(store: StateStore): TestDb {
	return (store as unknown as { db: TestDb }).db;
}

/** Test-only fixture for immutable rows left by the retired auto-QA writer. */
export function insertHistoricalAutoQaRecord(
	store: StateStore,
	input: {
		parentExecutionId: string;
		targetPrHeadSha: string;
		issueId: string;
		projectName: string;
		status?: AutoQaRecord["status"];
		enrollmentSource?: "auto" | "manual";
		qaExecutionId?: string;
		qaIssueId?: string;
		qaIssueIdentifier?: string;
		qaIssueTitle?: string;
		qaIssueUrl?: string;
		verdictEventId?: string;
		notified?: boolean;
	},
): void {
	db(store).run(
		`INSERT INTO auto_qa_record
		 (parent_execution_id, target_pr_head_sha, issue_id, project_name,
		  qa_execution_id, qa_issue_id, qa_issue_identifier, qa_issue_title,
		  qa_issue_url, status, enrollment_source, verdict_event_id, started_at, notified_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
		  CASE WHEN ? THEN datetime('now') END)`,
		[
			input.parentExecutionId,
			input.targetPrHeadSha,
			input.issueId,
			input.projectName,
			input.qaExecutionId ?? null,
			input.qaIssueId ?? null,
			input.qaIssueIdentifier ?? null,
			input.qaIssueTitle ?? null,
			input.qaIssueUrl ?? null,
			input.status ?? "running",
			input.enrollmentSource ?? "auto",
			input.verdictEventId ?? null,
			input.notified ? 1 : 0,
		],
	);
}

/** Test-only fixture for historical immutable ship-policy snapshots. */
export function setHistoricalQaRequiredSnapshot(
	store: StateStore,
	input: { executionId: string; required: 0 | 1; reason: string },
): void {
	db(store).run(
		"UPDATE sessions SET qa_required = ?, qa_required_reason = ? WHERE execution_id = ?",
		[input.required, input.reason, input.executionId],
	);
}
