import { allowedActionsForState } from "flywheel-core";
import type { Session, StateStore } from "../StateStore.js";

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
	tmux_session?: string;
	commit_count?: number;
	lines_added?: number;
	lines_removed?: number;
	allowedActions: string[];
}

/** FLY-25: Delivery health metrics. */
export interface DashboardDeliveryHealth {
	pending_count: number;
	total_delivered: number;
	total_failed: number;
	last_failure_error: string | null;
	last_failure_at: string | null;
	success_rate: number;
	monitor_status: "healthy" | "degraded";
}

export interface DashboardPayload {
	metrics: DashboardMetrics;
	active: DashboardSession[];
	recent: DashboardSession[];
	stuck: DashboardSession[];
	delivery: DashboardDeliveryHealth;
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
		tmux_session: s.tmux_session,
		commit_count: s.commit_count,
		lines_added: s.lines_added,
		lines_removed: s.lines_removed,
		allowedActions: allowedActionsForState(s.status),
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
	const awaitingReview = active.filter(
		(s) => s.status === "awaiting_review",
	).length;
	const failedToday = terminal.filter((s) => s.status === "failed").length;
	// FLY-58: approved_to_ship is NOT completed — Runner still needs to ship
	const completedToday = terminal.filter(
		(s) => s.status === "completed" || s.status === "approved",
	).length;

	// FLY-25: Delivery health
	const deliveryStats = store.getDeliveryStats();
	const totalAttempted =
		deliveryStats.total_delivered + deliveryStats.total_failed;
	const success_rate =
		totalAttempted > 0 ? deliveryStats.total_delivered / totalAttempted : 1;
	const monitor_status: "healthy" | "degraded" =
		deliveryStats.pending_count > 0 || deliveryStats.total_failed > 0
			? "degraded"
			: "healthy";

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
		delivery: {
			pending_count: deliveryStats.pending_count,
			total_delivered: deliveryStats.total_delivered,
			total_failed: deliveryStats.total_failed,
			last_failure_error: deliveryStats.last_failure_error,
			last_failure_at: deliveryStats.last_failure_at,
			success_rate: Math.round(success_rate * 1000) / 1000,
			monitor_status,
		},
		generated_at: new Date().toISOString(),
	};
}
