/**
 * GEO-195: Bootstrap Generator — produces a LeadBootstrap snapshot
 * for crash recovery. Aggregates active sessions, pending decisions,
 * recent failures, and recently delivered events.
 * GEO-203: Dual-bucket parallel memory recall (private + shared).
 */

import { CommDB } from "flywheel-comm/db";
import { readContentRef } from "flywheel-comm/utils";
import type { MemoryService } from "flywheel-edge-worker";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import type { HookPayload } from "./hook-payload.js";
import type {
	BootstrapDecision,
	BootstrapFailure,
	BootstrapGateQuestion,
	BootstrapSession,
	LeadBootstrap,
	LeadEventEnvelope,
} from "./lead-runtime.js";
import { filterSessionsByLead } from "./lead-scope.js";
import { defaultGetCommDbPath } from "./session-capture.js";

const RECENT_EVENTS_WINDOW_MINUTES = 5;
const MAX_RECENT_FAILURES = 10;
const MAX_RECENT_SESSIONS = 20;

const MEMORY_TIMEOUT_MS = 5000;
const PRIVATE_LIMIT = 10;
const SHARED_LIMIT = 5;
const MEMORY_SOFT_LIMIT_CHARS = 1500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

/**
 * Find the ProjectEntry that contains a given leadId.
 * Returns null if the leadId is not found in any project.
 */
export function findProjectForLead(
	leadId: string,
	projects: ProjectEntry[],
): ProjectEntry | null {
	for (const project of projects) {
		if (project.leads.some((l) => l.agentId === leadId)) {
			return project;
		}
	}
	return null;
}

/**
 * Dual-bucket parallel memory recall.
 * - Private bucket: userId=leadId, agentId=leadId, limit 10
 * - Shared bucket: userId=projectName (no agentId), limit 5
 * Deduplicates shared items that overlap with private.
 * Soft limit: 1500 chars on the formatted result.
 */
async function recallMemories(
	leadId: string,
	projectName: string,
	memoryService: MemoryService,
): Promise<string | null> {
	const query = "project context and decisions";

	const [privateResult, sharedResult] = await Promise.allSettled([
		withTimeout(
			memoryService.searchMemories({
				query,
				projectName,
				userId: leadId,
				agentId: leadId,
				limit: PRIVATE_LIMIT,
			}),
			MEMORY_TIMEOUT_MS,
		),
		withTimeout(
			memoryService.searchMemories({
				query,
				projectName,
				userId: projectName,
				// No agentId for shared bucket — cross-agent
				limit: SHARED_LIMIT,
			}),
			MEMORY_TIMEOUT_MS,
		),
	]);

	const privateMemories =
		privateResult.status === "fulfilled" ? privateResult.value : [];
	const sharedMemories =
		sharedResult.status === "fulfilled" ? sharedResult.value : [];

	// Dedup: remove shared items that already appear in private
	const privateSet = new Set(privateMemories);
	const dedupedShared = sharedMemories.filter((m) => !privateSet.has(m));

	if (privateMemories.length === 0 && dedupedShared.length === 0) {
		return null;
	}

	const sections: string[] = [];

	if (privateMemories.length > 0) {
		sections.push("### Personal Memory (private)");
		for (const m of privateMemories) {
			sections.push(`- ${m}`);
		}
	}

	if (dedupedShared.length > 0) {
		sections.push("### Project Facts (shared)");
		for (const m of dedupedShared) {
			sections.push(`- ${m}`);
		}
	}

	let result = sections.join("\n");

	if (result.length > MEMORY_SOFT_LIMIT_CHARS) {
		result = `${result.slice(0, MEMORY_SOFT_LIMIT_CHARS)}\n…(truncated)`;
	}

	return result;
}

export async function generateBootstrap(
	leadId: string,
	store: StateStore,
	projects: ProjectEntry[],
	memoryService?: MemoryService,
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

	// GEO-203: Dual-bucket parallel memory recall
	let memoryRecall: string | null = null;
	if (memoryService) {
		const project = findProjectForLead(leadId, projects);
		if (project) {
			// Fail-closed: skip memory recall if memoryAllowedUsers not configured
			// or if the required userIds are not in the allowlist
			const allowedUsers = project.memoryAllowedUsers;
			if (
				!allowedUsers ||
				!allowedUsers.includes(leadId) ||
				!allowedUsers.includes(project.projectName)
			) {
				console.warn(
					`[bootstrap] Memory not configured for project "${project.projectName}" or missing userId in allowlist — skipping recall`,
				);
			} else {
				try {
					memoryRecall = await recallMemories(
						leadId,
						project.projectName,
						memoryService,
					);
				} catch (err) {
					console.warn(
						`[bootstrap] Memory recall failed for ${leadId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		} else {
			console.warn(
				`[bootstrap] Lead "${leadId}" not found in any project — skipping memory recall`,
			);
		}
	}

	// FLY-62: Collect pending gate questions across projects
	const pendingGateQuestions: BootstrapGateQuestion[] = [];
	const projectsDone = new Set<string>();
	for (const session of activeSessions) {
		if (projectsDone.has(session.project_name)) continue;
		projectsDone.add(session.project_name);

		const dbPath = defaultGetCommDbPath(session.project_name);
		let db: CommDB;
		try {
			db = CommDB.openReadonly(dbPath);
		} catch {
			continue; // DB doesn't exist yet
		}
		try {
			const pendingQs = db
				.getPendingQuestions(leadId)
				.filter((q) => q.checkpoint != null);
			const sessionByExecId = new Map(
				activeSessions
					.filter((s) => s.project_name === session.project_name)
					.map((s) => [s.execution_id, s]),
			);
			for (const q of pendingQs) {
				const matchedSession = sessionByExecId.get(q.from_agent);
				if (!matchedSession) continue;
				let content = q.content;
				if (q.content_type === "ref" && q.content_ref) {
					content = readContentRef(q.content_ref) ?? q.content;
				}
				pendingGateQuestions.push({
					questionId: q.id,
					checkpoint: q.checkpoint!,
					executionId: matchedSession.execution_id,
					issueIdentifier: matchedSession.issue_identifier,
					content,
					commDbPath: dbPath,
					createdAt: q.created_at,
				});
			}
		} finally {
			db.close();
		}
	}

	return {
		leadId,
		activeSessions: activeSessions.map(toBootstrapSession),
		pendingDecisions: pendingDecisions.map(toBootstrapDecision),
		recentFailures: recentFailures.map(toBootstrapFailure),
		recentEvents,
		memoryRecall,
		pendingGateQuestions:
			pendingGateQuestions.length > 0 ? pendingGateQuestions : undefined,
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
