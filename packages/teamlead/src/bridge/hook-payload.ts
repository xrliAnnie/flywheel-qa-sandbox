export interface HookPayload {
	event_type: string;
	execution_id: string;
	issue_id: string;
	issue_identifier?: string;
	issue_title?: string;
	project_name?: string;
	status?: string;
	decision_route?: string;
	commit_count?: number;
	lines_added?: number;
	lines_removed?: number;
	summary?: string;
	last_error?: string;
	thread_ts?: string;
	channel?: string;
	// stuck-specific
	minutes_since_activity?: number;
}

export function buildSessionKey(session: { issue_identifier?: string; issue_id: string }): string {
	return `flywheel:${session.issue_identifier ?? session.issue_id}`;
}

export function buildHookBody(
	agentId: string,
	payload: HookPayload,
	sessionKey?: string,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		agentId,
		message: JSON.stringify(payload),
	};
	if (sessionKey) body.sessionKey = sessionKey;
	return body;
}
