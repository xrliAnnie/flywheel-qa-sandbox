import { Router } from "express";
import { ACTION_DEFINITIONS } from "flywheel-core";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { filterSessionsByLead } from "./lead-scope.js";
import type { IRetryDispatcher } from "./retry-dispatcher.js";
import type { StatusQueryResult } from "./runner-status.js";
import {
	type CaptureError,
	type CaptureResult,
	isCaptureError,
} from "./session-capture.js";

export type CaptureSessionFn = (
	executionId: string,
	projectName: string,
	lines: number,
) => Promise<CaptureResult | CaptureError>;

export type StatusQueryFn = (
	executionId: string,
	projectName: string,
) => Promise<StatusQueryResult>;

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
	captureSessionFn?: CaptureSessionFn,
	statusQueryFn?: StatusQueryFn,
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
				// GEO-200: Thread fallback (same logic as /sessions/:id)
				const mapped = sessions.map((s) => {
					const result = omitIssueId(s);
					if (!s.thread_id) {
						const thread = store.getThreadByIssue(s.issue_id);
						if (thread) {
							(result as Record<string, unknown>).thread_id = thread.thread_id;
						}
					}
					return result;
				});
				res.json({
					sessions: mapped,
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

		// GEO-259: Filter history to Lead scope.
		// If leadId provided but no in-scope history exists, return empty.
		let history = store.getSessionHistory(session.issue_id);
		history = filterSessionsByLead(history, leadId, projects);

		res.json({
			identifier: history.length > 0 ? session.issue_identifier : undefined,
			history: history.map(omitIssueId),
			count: history.length,
		});
	});

	router.get("/sessions/:id/capture", async (req, res) => {
		if (!captureSessionFn) {
			res.status(501).json({ error: "Capture not configured" });
			return;
		}

		const id = req.params.id;

		// Resolve session (same fallback as /sessions/:id)
		let session = store.getSession(id);
		if (!session) {
			session = store.getSessionByIdentifier(id);
		}
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}

		// Parse and validate lines parameter
		const rawLines = parseInt((req.query.lines as string) ?? "100", 10);
		const lines = Number.isFinite(rawLines)
			? Math.min(Math.max(rawLines, 1), 500)
			: 100;

		const result = await captureSessionFn(
			session.execution_id,
			session.project_name,
			lines,
		);

		if (isCaptureError(result)) {
			res.status(result.status).json({ error: result.error });
			return;
		}

		res.json({
			execution_id: session.execution_id,
			...result,
		});
	});

	// FLY-10: Runner status detection (four-state model + 45s stall watchdog)
	router.get("/sessions/:id/status", async (req, res) => {
		if (!statusQueryFn) {
			res.status(501).json({ error: "Status detection not configured" });
			return;
		}

		const id = req.params.id;

		// Resolve session (same fallback as /sessions/:id)
		let session = store.getSession(id);
		if (!session) {
			session = store.getSessionByIdentifier(id);
		}
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}

		const { result, captureErrorStatus } = await statusQueryFn(
			session.execution_id,
			session.project_name,
		);

		// Propagate non-tmux capture errors (400/404) as HTTP errors
		// consistent with /sessions/:id/capture behavior
		if (captureErrorStatus) {
			res.status(captureErrorStatus).json({ error: result.reason });
			return;
		}

		res.json({
			execution_id: session.execution_id,
			...result,
			checked_at: new Date().toISOString(),
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
		/** FLY-59: Optional role filter — defaults to 'main' when omitted */
		const sessionRole = (req.query.sessionRole as string | undefined) ?? "main";
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
		let candidates: Session[];
		if (leadId) {
			candidates = store.getSessionsByIssueAndStatuses(
				issueId,
				actionDef.fromStates,
			);
			candidates = filterSessionsByLead(candidates, leadId, projects);
		} else {
			candidates = store.getSessionsByIssueAndStatuses(
				issueId,
				actionDef.fromStates,
			);
		}

		// FLY-59: Filter by session role
		const session = candidates.find(
			(s) => (s.session_role ?? "main") === sessionRole,
		);

		if (!session) {
			res.json({
				can_execute: false,
				reason: leadId
					? `No in-scope session found for issue ${issueId} in lead "${leadId}" scope (role: ${sessionRole})`
					: `No session found for issue ${issueId} in status: ${actionDef.fromStates.join(", ")} (role: ${sessionRole})`,
			});
			return;
		}

		// GEO-168: retry-specific pre-flight checks (FLY-59: per-role)
		if (action === "retry") {
			if (retryDispatcher) {
				if (retryDispatcher.hasInflightForRole(session.issue_id, sessionRole)) {
					res.json({
						execution_id: session.execution_id,
						status: session.status,
						can_execute: false,
						reason: `Issue ${session.issue_identifier ?? session.issue_id} already has a retry in progress for role "${sessionRole}"`,
					});
					return;
				}
			}
			const active = store.getActiveSessions();
			const activeForIssue = active.find(
				(s) =>
					s.issue_id === session.issue_id &&
					(s.session_role ?? "main") === sessionRole,
			);
			if (activeForIssue) {
				res.json({
					execution_id: session.execution_id,
					status: session.status,
					can_execute: false,
					reason: `Issue ${session.issue_identifier ?? session.issue_id} already has an active session for role "${sessionRole}" (${activeForIssue.execution_id})`,
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
