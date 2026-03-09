import type { StateStore, Session } from "../StateStore.js";

export interface DashboardMetrics {
	running: number;
	awaiting_review: number;
	completed_today: number;
	failed_today: number;
}

export interface DashboardSession {
	execution_id: string;
	issue_identifier?: string;
	issue_title?: string;
	project_name: string;
	status: string;
	started_at?: string;
	last_activity_at?: string;
	branch?: string;
	last_error?: string;
	decision_route?: string;
	commit_count?: number;
	lines_added?: number;
	lines_removed?: number;
}

export interface DashboardPayload {
	metrics: DashboardMetrics;
	active: DashboardSession[];
	recent: DashboardSession[];
	stuck: DashboardSession[];
	generated_at: string;
}

function todayStartUTC(): string {
	const now = new Date();
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")} 00:00:00`;
}

function toDashboardSession(s: Session): DashboardSession {
	return {
		execution_id: s.execution_id,
		issue_identifier: s.issue_identifier,
		issue_title: s.issue_title,
		project_name: s.project_name,
		status: s.status,
		started_at: s.started_at,
		last_activity_at: s.last_activity_at,
		branch: s.branch,
		last_error: s.last_error,
		decision_route: s.decision_route,
		commit_count: s.commit_count,
		lines_added: s.lines_added,
		lines_removed: s.lines_removed,
	};
}

export function buildDashboardPayload(
	store: StateStore,
	stuckThresholdMinutes: number,
): DashboardPayload {
	const active = store.getActiveSessions();
	const terminal = store.getTerminalSessionsSince(todayStartUTC());
	const recent = store.getRecentOutcomeSessions(10);
	const stuck = store.getStuckSessions(stuckThresholdMinutes);

	const running = active.filter((s) => s.status === "running").length;
	const awaitingReview = active.filter((s) => s.status === "awaiting_review").length;
	const failedToday = terminal.filter((s) => s.status === "failed").length;
	const completedToday = terminal.filter((s) => s.status !== "failed").length;

	return {
		metrics: {
			running,
			awaiting_review: awaitingReview,
			completed_today: completedToday,
			failed_today: failedToday,
		},
		active: active.map(toDashboardSession),
		recent: recent.map(toDashboardSession),
		stuck: stuck.map(toDashboardSession),
		generated_at: new Date().toISOString(),
	};
}
