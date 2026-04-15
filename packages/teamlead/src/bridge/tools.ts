import { Router } from "express";
import { ACTION_DEFINITIONS } from "flywheel-core";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import type {
	ChatThreadCreator,
	ChatThreadResult,
} from "./ChatThreadCreator.js";
import {
	validateAndRegisterChatThread,
	validateChatThreadParams,
} from "./chat-thread-register.js";
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

/** FLY-91 Round 3: Options object for createQueryRouter (replaces positional params). */
export interface QueryRouterOptions {
	retryDispatcher?: IRetryDispatcher;
	captureSessionFn?: CaptureSessionFn;
	statusQueryFn?: StatusQueryFn;
	chatThreadsEnabled?: boolean;
	chatThreadCreator?: ChatThreadCreator;
	globalBotToken?: string;
	discordOwnerUserId?: string;
}

function omitIssueId(
	session: Session,
): Omit<Session, "issue_id"> & { identifier?: string } {
	const { issue_id: _, issue_identifier, ...rest } = session;
	return { ...rest, identifier: issue_identifier };
}

export function createQueryRouter(
	store: StateStore,
	projects: ProjectEntry[],
	opts?: QueryRouterOptions,
): Router {
	const retryDispatcher = opts?.retryDispatcher;
	const captureSessionFn = opts?.captureSessionFn;
	const statusQueryFn = opts?.statusQueryFn;
	const chatThreadsEnabled = opts?.chatThreadsEnabled;
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
				// FLY-102 Round 1 (Codex post-Round 4): `statuses` filter scopes the
				// lookup to caller-supplied statuses (e.g. CLOSE_ELIGIBLE_STATES from
				// close_runner). Returns ALL matching sessions — caller decides how
				// to disambiguate (usually: error on 0 or >1). Without this, the
				// fallback `ORDER BY last_activity_at DESC LIMIT 1` picks any status,
				// which under retries/parallel can point to a running session.
				const statusesRaw = req.query.statuses as string | undefined;
				if (statusesRaw) {
					const statuses = statusesRaw
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
					sessions = store.getSessionsByIdentifierAndStatuses(
						identifier,
						statuses,
					);
				} else {
					const session = store.getSessionByIdentifier(identifier);
					sessions = session ? [session] : [];
				}
				// FLY-80: Removed stale thread fallback (see /sessions/:id comment)
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
		// FLY-80: Removed thread fallback from conversation_threads.
		// Thread inheritance is handled by event-route.ts, Forum creation by ForumPostCreator.
		// Injecting stale conversation_threads entries caused Leads to post to deleted threads.
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

	// --- FLY-91 Round 2: Lead-centric chat thread management ---

	router.post("/chat-threads/register", async (req, res) => {
		if (!chatThreadsEnabled) {
			res.status(404).json({ error: "Chat threads not enabled" });
			return;
		}

		const { threadId, channelId, issueId, leadId, projectName } =
			req.body ?? {};
		if (!threadId || !channelId || !issueId || !leadId || !projectName) {
			res.status(400).json({
				error:
					"threadId, channelId, issueId, leadId, and projectName are required",
			});
			return;
		}

		// Linear preflight: verify issue exists before writing to DB
		if (!process.env.LINEAR_API_KEY) {
			res.status(503).json({
				error: "LINEAR_API_KEY not configured — cannot verify issue",
			});
			return;
		}
		try {
			const { LinearClient } = await import("@linear/sdk");
			const client = new LinearClient({
				apiKey: process.env.LINEAR_API_KEY,
			});
			const issue = await client.issue(issueId);
			if (!issue) {
				res.status(404).json({ error: `Issue ${issueId} not found in Linear` });
				return;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			res.status(502).json({
				error: `Cannot verify issue ${issueId} in Linear: ${msg}`,
			});
			return;
		}

		// Resolve botToken for Discord validation
		const proj = projects.find((p) => p.projectName === projectName);
		const leadCfg = proj?.leads.find((l) => l.agentId === leadId);
		const regBotToken = leadCfg?.botToken ?? opts?.globalBotToken;

		const result = await validateAndRegisterChatThread(
			{
				threadId: String(threadId),
				channelId: String(channelId),
				issueId,
				leadId,
				projectName,
				botToken: regBotToken,
			},
			store,
			projects,
		);

		if (!result.ok) {
			res.status(result.status).json({ error: result.error });
			return;
		}

		res.json({ ok: true });
	});

	// --- FLY-91 Round 3: Lead requests Bridge to create/get a chat thread ---

	router.post("/chat-threads/create", async (req, res) => {
		if (!chatThreadsEnabled) {
			res.status(404).json({ error: "Chat threads not enabled" });
			return;
		}

		const {
			issueId,
			issueIdentifier: bodyIdentifier,
			channelId,
			leadId,
			projectName,
		} = req.body ?? {};

		// Must provide at least one of issueId or issueIdentifier
		if (
			(!issueId && !bodyIdentifier) ||
			!channelId ||
			!leadId ||
			!projectName
		) {
			res.status(400).json({
				error:
					"channelId, leadId, projectName, and at least one of issueId or issueIdentifier are required",
			});
			return;
		}

		// Reuse shared validation (project/lead/channel check)
		const validation = validateChatThreadParams(
			{ channelId, leadId, projectName },
			projects,
		);
		if (!validation.ok) {
			res.status(validation.status).json({ error: validation.error });
			return;
		}

		// Linear preflight: verify issue exists + resolve identifier if needed
		if (!process.env.LINEAR_API_KEY) {
			res.status(503).json({ error: "LINEAR_API_KEY not configured" });
			return;
		}

		let resolvedIssueId: string;
		let resolvedIdentifier: string | undefined;
		let resolvedTitle: string | undefined;

		try {
			const { LinearClient } = await import("@linear/sdk");
			const client = new LinearClient({
				apiKey: process.env.LINEAR_API_KEY,
			});

			if (issueId) {
				// Direct UUID path
				const issue = await client.issue(issueId);
				if (!issue) {
					res
						.status(404)
						.json({ error: `Issue ${issueId} not found in Linear` });
					return;
				}
				resolvedIssueId = issueId;
				resolvedIdentifier = issue.identifier;
				resolvedTitle = issue.title;
			} else {
				// Identifier resolve path
				const results = await client.searchIssues(bodyIdentifier);
				const matched = results.nodes.find(
					(i: { identifier: string }) => i.identifier === bodyIdentifier,
				);
				if (!matched) {
					res.status(404).json({
						error: `Issue "${bodyIdentifier}" not found in Linear`,
					});
					return;
				}
				resolvedIssueId = matched.id;
				resolvedIdentifier = matched.identifier;
				resolvedTitle = matched.title;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			res.status(502).json({ error: `Cannot verify issue: ${msg}` });
			return;
		}

		// Resolve bot token (per-lead or global fallback)
		const botToken = validation.leadConfig.botToken ?? opts?.globalBotToken;
		if (!botToken) {
			res.status(503).json({ error: "No Discord bot token available" });
			return;
		}

		// Fail-closed: chatThreadCreator must be present when flag is on
		if (!opts?.chatThreadCreator) {
			res.status(503).json({ error: "ChatThreadCreator not initialized" });
			return;
		}

		// Delegate to shared ChatThreadCreator
		// ensureChatThread() can both return { error } AND throw on unexpected failures
		let result: ChatThreadResult;
		try {
			result = await opts.chatThreadCreator.ensureChatThread({
				chatChannelId: channelId,
				issueId: resolvedIssueId,
				issueIdentifier: resolvedIdentifier,
				issueTitle: resolvedTitle,
				botToken,
				leadId,
				ownerUserId: opts.discordOwnerUserId,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			res.status(502).json({ error: `Thread creation failed: ${msg}` });
			return;
		}

		if (result.error) {
			res.status(502).json({ error: result.error });
			return;
		}

		res.json({ threadId: result.threadId, created: result.created });
	});

	router.get("/chat-threads", (req, res) => {
		if (!chatThreadsEnabled) {
			res.status(404).json({ error: "Chat threads not enabled" });
			return;
		}

		const issueId = req.query.issueId as string;
		const channelId = req.query.channelId as string;
		if (!issueId || !channelId) {
			res.status(400).json({
				error: "issueId and channelId query params are required",
			});
			return;
		}

		const row = store.getChatThreadByIssue(issueId, channelId);
		res.json({
			threadId: row?.thread_id ?? null,
		});
	});

	return router;
}
