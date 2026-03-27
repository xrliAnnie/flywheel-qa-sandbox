/**
 * GEO-195: Bootstrap Generator — produces a LeadBootstrap snapshot
 * for crash recovery. Aggregates active sessions, pending decisions,
 * recent failures, and recently delivered events.
 */

import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import type { HookPayload } from "./hook-payload.js";
import type {
	BootstrapDecision,
	BootstrapFailure,
	BootstrapSession,
	LeadBootstrap,
	LeadEventEnvelope,
} from "./lead-runtime.js";
import { filterSessionsByLead } from "./lead-scope.js";

const RECENT_EVENTS_WINDOW_MINUTES = 5;
const MAX_RECENT_FAILURES = 10;
const MAX_RECENT_SESSIONS = 20;

export async function generateBootstrap(
	leadId: string,
	store: StateStore,
	projects: ProjectEntry[],
): Promise<LeadBootstrap> {
	// Active sessions matching this lead (via label routing)
	const allActive = store.getActiveSessions();
	const activeSessions = filterSessionsByLead(allActive, leadId, projects);

	// Pending decisions (awaiting_review)
	const recent = store.getRecentSessions(MAX_RECENT_SESSIONS);
	const pendingDecisions = filterSessionsByLead(
		recent.filter((s) => s.status === "awaiting_review"),
		leadId,
		projects,
	);

	// Recent failures
	const recentFailures = filterSessionsByLead(
		recent.filter((s) => s.status === "failed"),
		leadId,
		projects,
	).slice(0, MAX_RECENT_FAILURES);

	// Recently delivered events from journal
	const eventRows = store.getRecentDeliveredEvents(
		leadId,
		RECENT_EVENTS_WINDOW_MINUTES,
	);
	const recentEvents: LeadEventEnvelope[] = eventRows.map((row) => ({
		seq: row.seq,
		event: JSON.parse(row.payload) as HookPayload,
		sessionKey: row.session_key ?? "",
		leadId,
		timestamp: row.created_at,
	}));

	return {
		leadId,
		activeSessions: activeSessions.map(toBootstrapSession),
		pendingDecisions: pendingDecisions.map(toBootstrapDecision),
		recentFailures: recentFailures.map(toBootstrapFailure),
		recentEvents,
		memoryRecall: null, // GEO-198: wire after mem0 moves to Lead
	};
}

function toBootstrapSession(s: Session): BootstrapSession {
	return {
		executionId: s.execution_id,
		issueId: s.issue_id,
		issueIdentifier: s.issue_identifier,
		issueTitle: s.issue_title,
		projectName: s.project_name,
		status: s.status,
		startedAt: s.started_at,
		threadId: s.thread_id,
	};
}

function toBootstrapDecision(s: Session): BootstrapDecision {
	return {
		executionId: s.execution_id,
		issueId: s.issue_id,
		issueIdentifier: s.issue_identifier,
		issueTitle: s.issue_title,
		projectName: s.project_name,
		decisionRoute: s.decision_route,
		commitCount: s.commit_count,
		summary: s.summary,
	};
}

function toBootstrapFailure(s: Session): BootstrapFailure {
	return {
		executionId: s.execution_id,
		issueId: s.issue_id,
		issueIdentifier: s.issue_identifier,
		issueTitle: s.issue_title,
		projectName: s.project_name,
		lastError: s.last_error,
		failedAt: s.last_activity_at,
	};
}
