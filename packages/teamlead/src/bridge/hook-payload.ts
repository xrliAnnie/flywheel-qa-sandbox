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
	thread_id?: string;
	forum_channel?: string;
	chat_channel?: string;
	issue_labels?: string[];
	// stuck-specific
	minutes_since_activity?: number;
	// action-specific fields (GEO-167)
	action?: string;
	action_source_status?: string;
	action_target_status?: string;
	action_reason?: string;
	// EventFilter fields (GEO-187)
	filter_priority?: "high" | "normal" | "low";
	notification_context?: string;
	forum_tag_update_result?:
		| "skipped"
		| "attempted"
		| "succeeded"
		| "failed"
		| "no_thread";
}

export function buildSessionKey(session: {
	issue_identifier?: string;
	issue_id: string;
}): string {
	return `flywheel:${session.issue_identifier ?? session.issue_id}`;
}
