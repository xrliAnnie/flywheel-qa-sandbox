/**
 * GEO-195: Bootstrap Generator — produces a LeadBootstrap snapshot
 * for crash recovery. Aggregates active sessions, pending decisions,
 * recent failures, and recently delivered events.
 * GEO-203: Dual-bucket parallel memory recall (private + shared).
 */

import { CommDB } from "flywheel-comm/db";
import { isRunnerStopReport } from "flywheel-comm/runner-stop-report";
import { readContentRef } from "flywheel-comm/utils";
import type { MemoryService } from "flywheel-edge-worker";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import type { HookPayload } from "./hook-payload.js";
import type {
	BootstrapDecision,
	BootstrapFailure,
	BootstrapGateQuestion,
	BootstrapRunnerQuestion,
	BootstrapSession,
	LeadBootstrap,
	LeadEventEnvelope,
} from "./lead-runtime.js";
import { filterSessionsByLead, matchesLead } from "./lead-scope.js";
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
	opts?: { chatThreadsEnabled?: boolean },
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

	// FLY-62 + FLY-161: Collect pending questions for this Lead. The CommDB
	// query is filtered by `to_agent=leadId`, so we don't risk leaking other
	// Leads' questions even when a project hosts multiple Leads (R2 Issue 1).
	// We iterate only the projects containing the requested leadId.
	const pendingGateQuestions: BootstrapGateQuestion[] = [];
	const pendingRunnerQuestions: BootstrapRunnerQuestion[] = [];
	const targetProjects = projects.filter((p) =>
		p.leads.some((l) => l.agentId === leadId),
	);
	for (const project of targetProjects) {
		// FLY-161 (Codex R1 review): `targetLead` is resolved PER PROJECT, not
		// once globally. If the same `leadId` participates in multiple projects
		// with different `chatChannel`s, the runner_question chatThreadId hint
		// must follow the current project's Lead config — otherwise subsequent
		// projects would inherit the first project's chatChannel, mis-routing
		// the chat-thread suggestion.
		const targetLead = project.leads.find((l) => l.agentId === leadId);
		const dbPath = defaultGetCommDbPath(project.projectName);
		let db: CommDB;
		try {
			db = CommDB.openReadonly(dbPath);
		} catch {
			continue; // DB doesn't exist yet
		}
		try {
			const pendingQs = db.getPendingQuestions(leadId);
			for (const q of pendingQs) {
				// FLY-161: questions from `store.getSession` (NOT activeSessions)
				// — runner_question must survive Runner completion. Orphan rows
				// (no session record) are dropped with a warn for parity with
				// GatePoller.
				const matchedSession = store.getSession(q.from_agent);
				if (!matchedSession) {
					console.warn(
						`[bootstrap] orphan question — no session for from_agent=${q.from_agent} (qid=${q.id}, lead=${leadId})`,
					);
					continue;
				}
				let content = q.content;
				if (q.content_type === "ref" && q.content_ref) {
					content = readContentRef(q.content_ref) ?? q.content;
				}
				if (isRunnerStopReport({ id: q.id, kind: q.kind, content })) {
					continue;
				}

				if (q.checkpoint != null) {
					// gate_question — preserve pre-FLY-161 gating: active session
					// AND label-scope match (R2 Issue 3 + R3 Issue 1).
					if (
						!store.workflowGatePresentationDisposition({
							executionId: q.from_agent,
							checkpoint: q.checkpoint,
							questionId: q.id,
						}).allow
					) {
						continue;
					}
					if (
						matchedSession.status !== "running" &&
						matchedSession.status !== "awaiting_review" &&
						matchedSession.status !== "approved_to_ship"
					) {
						continue;
					}
					let scoped: boolean;
					try {
						scoped = matchesLead(matchedSession, leadId, projects);
					} catch (err) {
						console.warn(
							`[bootstrap] gate-question lead-scope verify error for session ${matchedSession.execution_id}: ${(err as Error).message}`,
						);
						continue;
					}
					if (!scoped) continue;

					const gate: BootstrapGateQuestion = {
						questionId: q.id,
						checkpoint: q.checkpoint!,
						executionId: matchedSession.execution_id,
						issueIdentifier: matchedSession.issue_identifier,
						content,
						commDbPath: dbPath,
						createdAt: q.created_at,
						sessionRole: matchedSession.session_role,
					};
					pendingGateQuestions.push(gate);
				} else {
					// runner_question — route by to_agent only. No active-session
					// constraint and no label-scope check (the Runner explicitly
					// named this Lead via `flywheel-comm ask --lead`).
					const rq: BootstrapRunnerQuestion = {
						questionId: q.id,
						executionId: matchedSession.execution_id,
						issueIdentifier: matchedSession.issue_identifier,
						content,
						commDbPath: dbPath,
						createdAt: q.created_at,
						sessionRole: matchedSession.session_role,
					};
					// FLY-91 + FLY-161 R4: chatThreadId follows the **target Lead**
					// (the one named by the Runner), NOT the source session's
					// label-derived Lead — otherwise a cross-label ask routes
					// correctly by to_agent but the chat-thread hint points at
					// the wrong Lead's chatChannel.
					if (opts?.chatThreadsEnabled && targetLead?.chatChannel) {
						// FLY-892 (converge): one issue = one thread.
						const ct = store.getChatThreadByIssue(
							matchedSession.issue_id,
							targetLead.chatChannel,
						);
						if (ct) rq.chatThreadId = ct.thread_id;
					}
					pendingRunnerQuestions.push(rq);
				}
			}
		} finally {
			db.close();
		}
	}

	// FLY-91: Enrich bootstrap sessions with chatThreadId (only when feature is enabled)
	const bootstrapSessions = activeSessions.map((s) => {
		const bs = toBootstrapSession(s);
		if (opts?.chatThreadsEnabled) {
			try {
				const labels = store.getSessionLabels(s.execution_id);
				const { lead } = resolveLeadForIssue(projects, s.project_name, labels);
				if (lead.chatChannel) {
					// FLY-892 (converge): one issue = one thread.
					const ct = store.getChatThreadByIssue(s.issue_id, lead.chatChannel);
					if (ct) bs.chatThreadId = ct.thread_id;
				}
			} catch {
				// Lead resolution failed — skip chatThreadId
			}
		}
		return bs;
	});

	return {
		leadId,
		activeSessions: bootstrapSessions,
		pendingDecisions: pendingDecisions.map(toBootstrapDecision),
		recentFailures: recentFailures.map(toBootstrapFailure),
		recentEvents,
		memoryRecall,
		pendingGateQuestions:
			pendingGateQuestions.length > 0 ? pendingGateQuestions : undefined,
		pendingRunnerQuestions:
			pendingRunnerQuestions.length > 0 ? pendingRunnerQuestions : undefined,
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
		sessionRole: s.session_role,
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
		sessionRole: s.session_role,
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
		sessionRole: s.session_role,
	};
}
