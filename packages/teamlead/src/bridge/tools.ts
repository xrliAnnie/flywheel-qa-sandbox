import { Router } from "express";
import { ACTION_DEFINITIONS } from "flywheel-core";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { filterSessionsByLead } from "./lead-scope.js";
import type { IRetryDispatcher } from "./retry-dispatcher.js";

function omitIssueId(
	session: Session,
): Omit<Session, "issue_id"> & { identifier?: string } {
	const { issue_id: _, issue_identifier, ...rest } = session;
	return { ...rest, identifier: issue_identifier };
}

export function createQueryRouter(
	store: StateStore,
	projects: ProjectEntry[],
	retryDispatcher?: IRetryDispatcher,
): Router {
	const router = Router();

	router.get("/sessions", (req, res) => {
		const mode = (req.query.mode as string) ?? "active";
		const leadId = req.query.leadId as string | undefined;
		const rawLimit = parseInt((req.query.limit as string) ?? "20", 10);
		const limit = Number.isFinite(rawLimit)
			? Math.min(Math.max(rawLimit, 1), 200)
			: 20;

		let sessions: Session[];

		switch (mode) {
			case "active":
				sessions = store.getActiveSessions();
				break;
			case "recent":
				sessions = store.getRecentSessions(limit);
				break;
			case "stuck": {
				const rawThreshold = parseInt(
					(req.query.stuck_threshold as string) ?? "15",
					10,
				);
				const threshold = Number.isFinite(rawThreshold)
					? Math.min(Math.max(rawThreshold, 1), 1440)
					: 15;
				sessions = store.getStuckSessions(threshold);
				break;
			}
			case "by_identifier": {
				// Specific lookup — leadId not applied (caller knows the identifier)
				const identifier = req.query.identifier as string;
				if (!identifier) {
					res.status(400).json({
						error: "identifier query param required for mode=by_identifier",
					});
					return;
				}
				const session = store.getSessionByIdentifier(identifier);
				sessions = session ? [session] : [];
				res.json({
					sessions: sessions.map(omitIssueId),
					count: sessions.length,
				});
				return;
			}
			default:
				res.status(400).json({ error: `Unknown mode: ${mode}` });
				return;
		}

		// GEO-259: Apply lead scope filter for bulk modes (no-op if leadId not provided)
		sessions = filterSessionsByLead(sessions, leadId, projects);

		res.json({
			sessions: sessions.map(omitIssueId),
			count: sessions.length,
		});
	});

	router.get("/sessions/:id", (req, res) => {
		const id = req.params.id;

		// Deterministic fallback: try execution_id first, then identifier
		let session = store.getSession(id);
		if (!session) {
			session = store.getSessionByIdentifier(id);
		}
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}

		const result = omitIssueId(session);
		// Thread fallback: if session has no thread_id, check conversation_threads
		if (!session.thread_id) {
			const thread = store.getThreadByIssue(session.issue_id);
			if (thread) {
				(result as Record<string, unknown>).thread_id = thread.thread_id;
			}
		}
		res.json(result);
	});

	router.get("/sessions/:id/history", (req, res) => {
		const id = req.params.id;
		const leadId = req.query.leadId as string | undefined;

		// Resolve session first using same deterministic fallback
		let session = store.getSession(id);
		if (!session) {
			session = store.getSessionByIdentifier(id);
		}
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}

		// GEO-259: Filter history to Lead scope
		let history = store.getSessionHistory(session.issue_id);
		history = filterSessionsByLead(history, leadId, projects);

		res.json({
			identifier: session.issue_identifier,
			history: history.map(omitIssueId),
			count: history.length,
		});
	});

	// --- v1.0 Phase 1: Thread management + action resolution ---

	router.post("/threads/upsert", (req, res) => {
		const { thread_id, channel, issue_id, execution_id } = req.body ?? {};
		if (!thread_id || !channel || !issue_id || !execution_id) {
			res.status(400).json({
				error: "thread_id, channel, issue_id, and execution_id are required",
			});
			return;
		}

		// Coerce to string — Discord snowflake IDs exceed Number.MAX_SAFE_INTEGER
		const safeThreadId = String(thread_id);
		const safeChannel = String(channel);

		// 1. Verify execution exists
		const session = store.getSession(String(execution_id));
		if (!session) {
			res
				.status(404)
				.json({ error: `No session found for execution_id ${execution_id}` });
			return;
		}

		// 2. Verify issue_id matches
		if (session.issue_id !== issue_id) {
			res.status(400).json({
				error: `issue_id mismatch: session has "${session.issue_id}", request has "${issue_id}"`,
			});
			return;
		}

		// 3. Check thread_id not already bound to a different issue
		const existingIssue = store.getThreadIssue(safeThreadId);
		if (existingIssue && existingIssue !== issue_id) {
			res.status(409).json({
				error: `thread_id ${safeThreadId} is already bound to issue ${existingIssue}`,
			});
			return;
		}

		// 4. Upsert thread + bind session
		store.upsertThread(safeThreadId, safeChannel, issue_id);
		store.setSessionThreadId(String(execution_id), safeThreadId);

		res.json({ ok: true });
	});

	router.get("/thread/:thread_id", (req, res) => {
		const threadId = req.params.thread_id;
		const issueId = store.getThreadIssue(threadId);
		if (!issueId) {
			res.json({ found: false });
			return;
		}

		const latestSession = store.getSessionByIssue(issueId);
		res.json({
			found: true,
			issue_id: issueId,
			issue_identifier: latestSession?.issue_identifier,
			latest_execution: latestSession ? omitIssueId(latestSession) : undefined,
		});
	});

	router.get("/resolve-action", (req, res) => {
		const issueId = req.query.issue_id as string;
		const action = req.query.action as string;
		const leadId = req.query.leadId as string | undefined;
		if (!issueId || !action) {
			res
				.status(400)
				.json({ error: "issue_id and action query params are required" });
			return;
		}

		const actionDef = ACTION_DEFINITIONS.find((d) => d.action === action);
		if (!actionDef) {
			res.status(400).json({ error: `Unknown action: ${action}` });
			return;
		}

		// GEO-259: Scope-aware candidate selection when leadId provided
		let session: Session | undefined;
		if (leadId) {
			const candidates = store.getSessionsByIssueAndStatuses(
				issueId,
				actionDef.fromStates,
			);
			const inScope = filterSessionsByLead(candidates, leadId, projects);
			session = inScope[0]; // Already ordered by last_activity_at DESC
		} else {
			session = store.getLatestSessionByIssueAndStatuses(
				issueId,
				actionDef.fromStates,
			);
		}

		if (!session) {
			res.json({
				can_execute: false,
				reason: leadId
					? `No in-scope session found for issue ${issueId} in lead "${leadId}" scope`
					: `No session found for issue ${issueId} in status: ${actionDef.fromStates.join(", ")}`,
			});
			return;
		}

		// GEO-168: retry-specific pre-flight checks
		if (action === "retry") {
			if (retryDispatcher) {
				const inflight = retryDispatcher.getInflightIssues();
				if (inflight.has(session.issue_id)) {
					res.json({
						execution_id: session.execution_id,
						status: session.status,
						can_execute: false,
						reason: `Issue ${session.issue_identifier ?? session.issue_id} already has a retry in progress`,
					});
					return;
				}
			}
			const active = store.getActiveSessions();
			const activeForIssue = active.find(
				(s) => s.issue_id === session.issue_id,
			);
			if (activeForIssue) {
				res.json({
					execution_id: session.execution_id,
					status: session.status,
					can_execute: false,
					reason: `Issue ${session.issue_identifier ?? session.issue_id} already has an active session (${activeForIssue.execution_id})`,
				});
				return;
			}
		}

		res.json({
			execution_id: session.execution_id,
			status: session.status,
			can_execute: true,
		});
	});

	return router;
}
