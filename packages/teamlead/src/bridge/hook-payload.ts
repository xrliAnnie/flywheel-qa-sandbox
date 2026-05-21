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
	// FLY-62: gate_question event fields
	checkpoint?: string;
	question_id?: string;
	from_agent?: string;
	comm_db_path?: string;
	// FLY-159: gate_timed_out event fields (Lead notifies Annie via Discord)
	waited_ms?: number;
	original_message?: string;
	timeout_behavior?: string;
	/** "default" (no --timeout-behavior flag) | "flag" (flag was present) */
	timeout_behavior_source?: string;
	// GEO-292: PR tracking
	pr_number?: number;
	// FLY-59: Session role for multi-session-per-issue support
	session_role?: string;
	// FLY-47: stage context — explicit guidance for Lead (e.g., "Runner completed work, PR still needs review")
	stage_context?: string;
	// EventFilter fields (GEO-187)
	filter_priority?: "high" | "normal" | "low";
	notification_context?: string;
	forum_tag_update_result?:
		| "skipped"
		| "attempted"
		| "succeeded"
		| "failed"
		| "no_thread";
	// FLY-91: Chat thread for per-issue conversation in chatChannel
	chat_thread_id?: string;
}

export function buildSessionKey(session: {
	issue_identifier?: string;
	issue_id: string;
}): string {
	return `flywheel:${session.issue_identifier ?? session.issue_id}`;
}

/**
 * FLY-159: Format a millisecond duration as a short human-readable string.
 * Used by gate_timed_out formatters so Annie can read "waited 48h" / "waited
 * 10s" instead of a raw ms count.
 *
 * Examples:
 *   formatDurationMs(10_000)        → "10s"
 *   formatDurationMs(90_000)        → "1m 30s"
 *   formatDurationMs(3_600_000)     → "1h"
 *   formatDurationMs(172_800_000)   → "48h"
 *   formatDurationMs(5_400_000)     → "1h 30m"
 *   formatDurationMs(undefined as never) → "—"
 */
export function formatDurationMs(ms: number | undefined | null): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) {
		const sec = totalSec % 60;
		return sec === 0 ? `${totalMin}m` : `${totalMin}m ${sec}s`;
	}
	const hours = Math.floor(totalMin / 60);
	const min = totalMin % 60;
	return min === 0 ? `${hours}h` : `${hours}h ${min}m`;
}
