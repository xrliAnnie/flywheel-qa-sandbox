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
import {
	archiveThreadAndRecord,
	resolveBotTokenForThread,
} from "./done-thread-archiver.js";
import { filterSessionsByLead } from "./lead-scope.js";
import {
	type ChatClassification,
	evaluateReplyGuard,
	scanIssueTokens,
} from "./reply-guard.js";
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
	/**
	 * FLY-162 P2: enables `POST /api/chat-threads/send` and (P3)
	 * `GET /api/chat-threads/by-thread/:threadId`. When false, both
	 * routes return 404 `{ error: "reply.by_issue not enabled" }`.
	 * Wired in from `BridgeConfig.replyByIssueEnabled` (config.ts).
	 */
	replyByIssueEnabled?: boolean;
	/**
	 * FLY-162 P2: optional fetch override for Discord HTTP calls made by
	 * the `/send` route. Defaults to global `fetch`. Tests inject a mock
	 * so they can stub Discord responses without colliding with their
	 * own use of `fetch` to call the test Express server.
	 */
	discordFetch?: typeof fetch;
	/**
	 * FLY-162 Layer 2: enables `POST /api/discord/reply-guard`. When false,
	 * the route returns `{ allow: true }` (guard disabled = allow everything),
	 * so the plugin proceeds normally. Wired from `BridgeConfig.replyGuardEnabled`.
	 */
	replyGuardEnabled?: boolean;
	/**
	 * FLY-162 Layer 2: configured team prefixes counted as issue tokens by the
	 * reply-guard. Wired from `BridgeConfig.issuePrefixes`. Defaults to
	 * `["FLY","GEO"]` when omitted.
	 */
	issuePrefixes?: string[];
	/**
	 * FLY-369: whether a Bearer API token is configured (`Boolean(config.apiToken)`).
	 * `tokenAuthMiddleware` is a no-op when the token is unset, and
	 * `chatThreadsEnabled` (unlike reply-by-issue) does not fail-start without
	 * one — so the privileged `POST /chat-threads/archive` route fails closed
	 * (503) when this is false. Defaults to `false` (fail-closed) so existing
	 * router tests are unaffected.
	 */
	apiTokenConfigured?: boolean;
}

function omitIssueId(
	session: Session,
): Omit<Session, "issue_id"> & { identifier?: string } {
	const { issue_id: _, issue_identifier, ...rest } = session;
	return { ...rest, identifier: issue_identifier };
}

/**
 * FLY-270: true iff `s` is a Linear issue UUID (8-4-4-4-12 hex). Used to gate
 * the /chat-threads/send early reuse: a bare UUID issueId must go through Linear
 * so the thread key canonicalizes to the identifier-keyed run-start thread,
 * rather than serving a pre-fix UUID-keyed orphan row.
 */
function isLinearUuid(s: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		s,
	);
}

/**
 * FLY-927 (Task 1.6): true iff a chat-threads write targets the unified alert
 * channel WHILE the ticket-queue gating is on. The alert channel is a bot
 * ticket queue — only the infra alert pipeline may write there. Both envs are
 * read at CALL time (live flips apply); either unset ⇒ no gating (byte-compat).
 */
function isGatedAlertChannel(channelId: string): boolean {
	if (process.env.FLYWHEEL_ALERT_ROUTING !== "1") return false;
	const alertChannel = process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID?.trim();
	return !!alertChannel && channelId === alertChannel;
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
	const replyByIssueEnabled = opts?.replyByIssueEnabled ?? false;
	const replyGuardEnabled = opts?.replyGuardEnabled ?? false;
	const issuePrefixes = opts?.issuePrefixes ?? ["FLY", "GEO"];
	const apiTokenConfigured = opts?.apiTokenConfigured ?? false;
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
			case "live":
				sessions = store.getLiveSessions();
				break;
			case "recent_terminal": {
				const rawHours = parseInt((req.query.hours as string) ?? "48", 10);
				const hours = Number.isFinite(rawHours)
					? Math.min(Math.max(rawHours, 1), 168)
					: 48;
				const since = new Date(Date.now() - hours * 60 * 60_000)
					.toISOString()
					.replace("T", " ")
					.replace(/\.\d+Z$/, "");
				sessions = store.getOperationalTerminalSessionsSince(since);
				break;
			}
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
				// Specific lookup by issue identifier.
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
				// FLY-228 (Codex R2 MED-3): when leadId is supplied, scope the
				// candidate set to this Lead BEFORE the caller's 0/>1 disambiguation
				// (e.g. close_runner --abandon). Without this, an out-of-scope
				// same-identifier parked execution could trip the >1 guard or be
				// selected only to fail the terminate scope check later. leadId
				// OMITTED → unchanged behavior (existing close_runner lookup).
				sessions = filterSessionsByLead(sessions, leadId, projects);
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
		// FLY-163: forum conversation_threads removed; per-issue chat threads
		// surface via chat_thread_id on hook payloads.
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

	// FLY-10: Runner status detection (four-state model; the 45s stall downgrade was removed in FLY-1560)
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
			// FLY-1060 QA F3: the pane heuristic (`status`) never reports
			// "completed" — consumers needing a terminal signal read the store
			// lifecycle here (+ pr_number once recorded). Additive fields.
			session_status: session.status,
			pr_number: session.pr_number ?? null,
			checked_at: new Date().toISOString(),
		});
	});

	// FLY-163: /threads/upsert + /thread/:thread_id routes removed — forum thread
	// concept gone. Per-issue chat threads are managed internally by
	// DirectEventSink + StateStore.chat_threads.

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
		const regBotToken = leadCfg?.botToken;

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

		// FLY-927 (Task 1.6): sender gating — the unified alert channel is a bot
		// TICKET QUEUE; generic Lead sends are refused so nothing but the infra
		// alert pipeline (LeadAlertNotifier / lead-alert.sh) can write there.
		// Same switch as the Router (FLYWHEEL_ALERT_ROUTING); unset = no gating.
		if (isGatedAlertChannel(channelId)) {
			res.status(403).json({
				error: "alert_channel_gated",
				hint: "告警走 LeadAlertNotifier / lead-alert.sh 管道,不走 chat-threads",
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

		// FLY-270: canonicalize the thread key to the session's issue_id (matches
		// the run-start thread; avoids identifier-vs-UUID duplicate threads).
		resolvedIssueId =
			(resolvedIdentifier
				? store.getSessionByIdentifier(resolvedIdentifier)?.issue_id
				: undefined) ??
			resolvedIdentifier ??
			resolvedIssueId;

		// Lead-attributed writes may use only that canonical Lead's credential.
		const botToken = validation.leadConfig.botToken;
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
			res.status(502).json({
				error: result.error,
				...(result.errorCode ? { errorCode: result.errorCode } : {}),
				...(result.rootMessageId
					? { rootMessageId: result.rootMessageId }
					: {}),
				...(result.threadId ? { threadId: result.threadId } : {}),
			});
			return;
		}

		res.json({ threadId: result.threadId, created: result.created });
	});

	// --- FLY-162 P2: Lead reply-by-issue ---
	//
	// Endpoint: POST /api/chat-threads/send
	// Body: { issueId? | issueIdentifier?, channelId, leadId, projectName,
	//         text, replyTo? }
	// Returns 200 { threadId, messageIds, created } on success,
	//         502 { error, threadId, messageIds, chunksSent, chunksTotal,
	//               failedChunkIndex, remainingText } on partial fail.
	//
	// Design: lookup-first. Only the FIRST send for an issue should call
	// `ensureChatThread()` (which posts a main-channel "thread created"
	// notification). All subsequent sends reuse the existing row and post
	// directly to the thread via `postDiscordMessageToChannel`.

	router.post("/chat-threads/send", async (req, res) => {
		// FLY-162 Codex code-review R1 MED: fail closed on EITHER flag
		// being off. Plan §Q6.1 status code map specifies both
		// `chatThreadsEnabled=false` and `replyByIssueEnabled=false` →
		// 404, matching how `/create` and `/register` gate on
		// `chatThreadsEnabled`. Without this guard, an operator who
		// flipped only `TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true` (and
		// forgot to keep `TEAMLEAD_CHAT_THREADS_ENABLED=true`) would
		// still let the route POST as the Discord bot.
		if (!chatThreadsEnabled) {
			res.status(404).json({ error: "Chat threads not enabled" });
			return;
		}
		if (!replyByIssueEnabled) {
			res.status(404).json({ error: "reply.by_issue not enabled" });
			return;
		}

		const {
			issueId: bodyIssueId,
			issueIdentifier: bodyIdentifier,
			channelId,
			leadId,
			projectName,
			text,
			replyTo,
		} = (req.body ?? {}) as {
			issueId?: string;
			issueIdentifier?: string;
			channelId?: string;
			leadId?: string;
			projectName?: string;
			text?: string;
			replyTo?: string;
		};

		if (
			(!bodyIssueId && !bodyIdentifier) ||
			!channelId ||
			!leadId ||
			!projectName ||
			typeof text !== "string" ||
			text.length === 0
		) {
			res.status(400).json({
				error:
					"channelId, leadId, projectName, text, and at least one of issueId/issueIdentifier are required",
			});
			return;
		}

		// FLY-927 (Task 1.6): sender gating — see /chat-threads/create above.
		if (isGatedAlertChannel(channelId)) {
			res.status(403).json({
				error: "alert_channel_gated",
				hint: "告警走 LeadAlertNotifier / lead-alert.sh 管道,不走 chat-threads",
			});
			return;
		}

		// Validate project / lead / channel (shared with /create + /register)
		const validation = validateChatThreadParams(
			{ channelId, leadId, projectName },
			projects,
		);
		if (!validation.ok) {
			res.status(validation.status).json({ error: validation.error });
			return;
		}

		// Resolve issueId. If only identifier given, fetch via Linear; if
		// both given, fetch the issueId record and validate identifier
		// matches (Codex R2 #3). Skip Linear if only issueId given AND a
		// row already exists in StateStore for that issueId — reuse path
		// doesn't need preflight.
		let resolvedIssueId: string;
		// FLY-270: track the identifier so we can canonicalize the thread key
		// (to the session's issue_id) below — fixes identifier-vs-UUID dup threads.
		let resolvedIdentifier: string | undefined;
		let resolvedTitle: string | undefined;
		const lookupRowDirect = bodyIssueId
			? store.getChatThreadByIssue(bodyIssueId, channelId)
			: undefined;

		if (
			bodyIssueId &&
			lookupRowDirect &&
			!bodyIdentifier &&
			!isLinearUuid(bodyIssueId)
		) {
			// Reuse an existing row only when issueId is NOT a Linear UUID: a bare
			// UUID must go through Linear so the key canonicalizes to the
			// identifier-keyed run-start thread instead of serving a pre-fix
			// UUID-keyed orphan row (FLY-270 / Codex code review).
			resolvedIssueId = bodyIssueId;
		} else {
			// Need Linear (either resolving identifier→UUID, or cross-validating)
			if (!process.env.LINEAR_API_KEY) {
				res.status(503).json({ error: "LINEAR_API_KEY not configured" });
				return;
			}
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({
					apiKey: process.env.LINEAR_API_KEY,
				});

				if (bodyIssueId) {
					// Path: issueId given (possibly with identifier crosscheck)
					const issue = await client.issue(bodyIssueId);
					if (!issue) {
						res.status(404).json({
							error: `Issue ${bodyIssueId} not found in Linear`,
						});
						return;
					}
					if (bodyIdentifier && issue.identifier !== bodyIdentifier) {
						res.status(400).json({
							error: `issueId and issueIdentifier mismatch (issueId resolves to ${issue.identifier}, got ${bodyIdentifier})`,
						});
						return;
					}
					resolvedIssueId = bodyIssueId;
					resolvedIdentifier = issue.identifier;
					resolvedTitle = issue.title;
				} else {
					// Identifier-only path: resolve to UUID
					const results = await client.searchIssues(bodyIdentifier!);
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
		}

		// FLY-270: canonical thread key = the session's stored issue_id (what
		// run-start used = the identifier in practice), falling back to the
		// identifier — never the bare Linear UUID. Keeps the Lead's /send thread
		// the SAME as the run-start thread (fixes identifier-vs-UUID dup threads).
		resolvedIssueId =
			(resolvedIdentifier
				? store.getSessionByIdentifier(resolvedIdentifier)?.issue_id
				: undefined) ??
			resolvedIdentifier ??
			resolvedIssueId;

		// Lead-attributed writes may use only that canonical Lead's credential.
		const botToken = validation.leadConfig.botToken;
		if (!botToken) {
			res.status(503).json({ error: "No Discord bot token available" });
			return;
		}
		const threadContext = {
			chatChannelId: channelId,
			issueId: resolvedIssueId,
			issueIdentifier: resolvedIdentifier ?? bodyIdentifier,
			issueTitle: resolvedTitle,
			botToken,
			leadId,
			ownerUserId: opts.discordOwnerUserId,
		};

		// Lookup-first: only call ensureChatThread on row miss (AC1 + AC2)
		let threadId: string;
		let created = false;
		const existing = store.getChatThreadByIssue(resolvedIssueId, channelId);
		if (existing) {
			threadId = existing.thread_id;
			if (opts?.chatThreadCreator) {
				await opts.chatThreadCreator.backfillThreadName(
					threadContext,
					threadId,
				);
			}
		} else {
			if (!opts?.chatThreadCreator) {
				res.status(503).json({ error: "ChatThreadCreator not initialized" });
				return;
			}
			let ensureResult: ChatThreadResult;
			try {
				ensureResult =
					await opts.chatThreadCreator.ensureChatThread(threadContext);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				res.status(502).json({ error: `Thread creation failed: ${msg}` });
				return;
			}
			if (ensureResult.error || !ensureResult.threadId) {
				res.status(502).json({
					error: ensureResult.error ?? "ChatThreadCreator returned no threadId",
					...(ensureResult.errorCode
						? { errorCode: ensureResult.errorCode }
						: {}),
					...(ensureResult.rootMessageId
						? { rootMessageId: ensureResult.rootMessageId }
						: {}),
					...(ensureResult.threadId ? { threadId: ensureResult.threadId } : {}),
				});
				return;
			}
			threadId = ensureResult.threadId;
			created = ensureResult.created;
		}

		// Sequential POST via helper (handles split + allowed_mentions)
		const { postDiscordMessageToChannel } = await import("./discord-utils.js");
		let postResult = await postDiscordMessageToChannel(
			threadId,
			text,
			botToken,
			{ origin: "lead_authored", ...(replyTo ? { replyTo } : {}) },
			opts?.discordFetch,
		);

		// FLY-1927: a canonical row can be claimed just before Discord turns its
		// root message into a thread. A first-chunk 404 is therefore recoverable:
		// re-enter the creator, which probes/replays ONLY this exact root, then
		// retry the message once. Never retry after a partial multi-chunk send.
		if (
			!postResult.ok &&
			postResult.error.startsWith("Discord 404") &&
			postResult.chunksSent === 0 &&
			opts?.chatThreadCreator
		) {
			let recovery: ChatThreadResult;
			try {
				recovery = await opts.chatThreadCreator.ensureChatThread(threadContext);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				res.status(502).json({
					error: `Thread recovery failed: ${msg}`,
					errorCode: "canonical_thread_unavailable",
					rootMessageId: threadId,
					threadId,
				});
				return;
			}
			if (recovery.error || !recovery.threadId) {
				res.status(502).json({
					error: recovery.error ?? "ChatThreadCreator returned no threadId",
					...(recovery.errorCode
						? { errorCode: recovery.errorCode }
						: { errorCode: "canonical_thread_unavailable" }),
					rootMessageId: recovery.rootMessageId ?? threadId,
					threadId: recovery.threadId ?? threadId,
				});
				return;
			}
			threadId = recovery.threadId;
			created = created || recovery.created;
			postResult = await postDiscordMessageToChannel(
				threadId,
				text,
				botToken,
				{ origin: "lead_authored", ...(replyTo ? { replyTo } : {}) },
				opts.discordFetch,
			);
		}

		if (!postResult.ok) {
			res.status(502).json({
				error: postResult.error,
				...(postResult.error.startsWith("Discord 404")
					? {
							errorCode: "canonical_thread_unavailable",
							rootMessageId: threadId,
						}
					: {}),
				threadId,
				messageIds: postResult.messageIds,
				chunksSent: postResult.chunksSent,
				chunksTotal: postResult.chunksTotal,
				failedChunkIndex: postResult.failedChunkIndex,
				remainingText: postResult.remainingText,
			});
			return;
		}

		res.json({
			threadId,
			messageIds: postResult.messageIds,
			created,
		});
	});

	// --- FLY-162 P3: Lead reverse-lookup by Discord thread id ---
	//
	// Endpoint: GET /api/chat-threads/by-thread/:threadId
	// Returns 200 { threadId, channelId, issueId, issueIdentifier,
	//               issueTitle, projectName }; the last three are null
	//               when no session row exists yet (still 200, AC5).
	// Returns 404 when chat threads feature disabled (AC7), or when the
	// thread is not registered / has been marked missing (AC6).
	//
	// Pure local StateStore lookup — does NOT call Linear (AC8). Gated
	// on `chatThreadsEnabled` (not `replyByIssueEnabled`) because
	// inbound enrichment is still useful when outbound is rolled back.

	router.get("/chat-threads/by-thread/:threadId", (req, res) => {
		if (!chatThreadsEnabled) {
			res.status(404).json({ error: "Chat threads not enabled" });
			return;
		}
		const threadId = req.params.threadId;
		const row = store.getChatThreadByThreadId(threadId);
		if (!row) {
			res.status(404).json({ error: "Thread not registered" });
			return;
		}
		const session = store.getSessionByIssue(row.issue_id);
		res.json({
			threadId: row.thread_id,
			channelId: row.channel_id,
			issueId: row.issue_id,
			issueIdentifier: session?.issue_identifier ?? null,
			issueTitle: session?.issue_title ?? null,
			projectName: session?.project_name ?? null,
		});
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

	// FLY-369: on-demand archive of an issue's chat thread (Done-but-not-shipped).
	// Endpoint: POST /api/chat-threads/archive
	// Body: { issueId? | issueIdentifier?, channelId, leadId, projectName }
	// Archive ALWAYS goes through the Bridge-local archiveChatThread (Bridge holds
	// the bot token). Fails closed (503) when no API token is configured, since
	// tokenAuthMiddleware no-ops without one and chatThreadsEnabled does not
	// fail-start with a token (Codex design review R1 #4). archive-on-Done auto
	// archiving is separate (reconciler); this is the manual escape hatch.
	router.post("/chat-threads/archive", async (req, res) => {
		if (!chatThreadsEnabled) {
			res.status(404).json({ error: "Chat threads not enabled" });
			return;
		}
		if (!apiTokenConfigured) {
			res.status(503).json({
				error:
					"archive endpoint requires TEAMLEAD_API_TOKEN (refusing unauthenticated privileged archive)",
			});
			return;
		}

		const {
			issueId: bodyIssueId,
			issueIdentifier: bodyIdentifier,
			channelId,
			leadId,
			projectName,
		} = (req.body ?? {}) as {
			issueId?: string;
			issueIdentifier?: string;
			channelId?: string;
			leadId?: string;
			projectName?: string;
		};

		if (
			(!bodyIssueId && !bodyIdentifier) ||
			!channelId ||
			!leadId ||
			!projectName
		) {
			res.status(400).json({
				error:
					"channelId, leadId, projectName, and at least one of issueId/issueIdentifier are required",
			});
			return;
		}

		// validateChatThreadParams enforces caller scope/authz (the requesting Lead
		// must be configured for this project + channel). The bot token used to
		// archive, however, is resolved from the THREAD's recorded lead_id below
		// (Codex code review R1 #1) — not the caller's — so a changed/multi-Lead
		// ownership still archives with the correct bot.
		const validation = validateChatThreadParams(
			{ channelId, leadId, projectName },
			projects,
		);
		if (!validation.ok) {
			res.status(validation.status).json({ error: validation.error });
			return;
		}

		// Canonicalize to the stored chat_threads.issue_id (FLY-270 key reality).
		// An identifier maps through the session row to whatever run-start stored,
		// so an identifier-only request cannot miss a UUID-keyed thread.
		let canonicalKey: string;
		if (bodyIssueId && bodyIdentifier) {
			// Both given: cross-check requires Linear (parity with /send).
			if (!process.env.LINEAR_API_KEY) {
				res.status(400).json({
					error:
						"provide only one of issueId/issueIdentifier (cross-check needs LINEAR_API_KEY)",
				});
				return;
			}
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
				const issue = await client.issue(bodyIssueId);
				if (!issue) {
					res
						.status(404)
						.json({ error: `Issue ${bodyIssueId} not found in Linear` });
					return;
				}
				if (issue.identifier !== bodyIdentifier) {
					res.status(400).json({
						error: `issueId and issueIdentifier mismatch (issueId resolves to ${issue.identifier}, got ${bodyIdentifier})`,
					});
					return;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				res.status(502).json({ error: `Cannot verify issue: ${msg}` });
				return;
			}
			canonicalKey =
				store.getSessionByIdentifier(bodyIdentifier)?.issue_id ??
				bodyIdentifier;
		} else if (bodyIdentifier) {
			canonicalKey =
				store.getSessionByIdentifier(bodyIdentifier)?.issue_id ??
				bodyIdentifier;
		} else {
			// issueId only
			const id = bodyIssueId as string;
			canonicalKey = isLinearUuid(id)
				? id
				: (store.getSessionByIdentifier(id)?.issue_id ?? id);
		}

		let thread = store.getChatThreadByIssue(canonicalKey, channelId);

		// UUID-only direct miss: resolve the identifier via Linear (if available)
		// and retry, since post-FLY-270 threads are identifier-keyed.
		if (
			!thread &&
			bodyIssueId &&
			!bodyIdentifier &&
			isLinearUuid(bodyIssueId) &&
			process.env.LINEAR_API_KEY
		) {
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
				const issue = await client.issue(bodyIssueId);
				if (issue?.identifier) {
					canonicalKey =
						store.getSessionByIdentifier(issue.identifier)?.issue_id ??
						issue.identifier;
					thread = store.getChatThreadByIssue(canonicalKey, channelId);
				}
			} catch {
				// best-effort; fall through to 404
			}
		}

		if (!thread) {
			res.status(404).json({
				error: `No chat thread for issue ${canonicalKey} in channel ${channelId}`,
			});
			return;
		}

		const session = store.getSessionByIssue(canonicalKey);
		// Resolve the bot token from the THREAD's recorded lead_id first (Codex R1
		// #1), matching the automatic sweep; labels are only used for the legacy
		// fallback when the thread has no lead_id.
		const botToken = resolveBotTokenForThread(projects, {
			projectName,
			leadId: thread.lead_id,
			labels: session ? store.getSessionLabels(session.execution_id) : [],
			fallbackBotToken: opts?.globalBotToken,
		});
		if (!botToken) {
			res.status(503).json({ error: "No Discord bot token available" });
			return;
		}

		const executionId =
			session?.execution_id ?? `fly369-archive-${canonicalKey}`;

		const result = await archiveThreadAndRecord(
			store,
			{
				threadId: thread.thread_id,
				issueId: canonicalKey,
				projectName,
				executionId,
			},
			botToken,
			{
				discordOwnerUserId: opts?.discordOwnerUserId,
				fetchImpl: opts?.discordFetch,
			},
		);

		res.json({ threadId: thread.thread_id, ...result });
	});

	// FLY-162 Layer 2: preventive reply-guard. The forked Discord plugin calls
	// this before `reply` / `edit_message` sends. The Bridge classifies the
	// target chatId (the Lead's chatChannel top level / a registered issue
	// thread / other) and scans the text for configured-prefix issue tokens,
	// then denies issue content posted at the chatChannel top level. See §12.
	//
	// When the flag is OFF we return `{ allow: true }` (200) — guard disabled
	// means allow everything — so the plugin proceeds normally rather than
	// triggering its Bridge-unavailable fail-closed path. Auth is enforced by
	// the plugin-level token middleware (validated at startup that
	// replyGuardEnabled implies apiToken is set).
	router.post("/discord/reply-guard", (req, res) => {
		if (!replyGuardEnabled) {
			res.json({ allow: true });
			return;
		}

		const body = (req.body ?? {}) as Record<string, unknown>;
		const { projectName, leadId, chatId, text } = body;

		// Codex code-review LOW: require all four to be strings, not just
		// truthy. A non-string chatId (e.g. {}) would otherwise reach
		// store.getChatThreadByThreadId() and throw inside the DB binding,
		// turning a malformed request into a 500.
		if (
			typeof projectName !== "string" ||
			projectName.trim().length === 0 ||
			typeof leadId !== "string" ||
			leadId.trim().length === 0 ||
			typeof chatId !== "string" ||
			chatId.trim().length === 0 ||
			typeof text !== "string"
		) {
			res.status(400).json({
				error:
					"projectName, leadId, chatId (non-empty strings) and text (string) are required",
			});
			return;
		}

		// Resolve project first, then the lead within it (Codex R1 #1: leadId
		// alone is ambiguous across projects that reuse role-style ids).
		const project = projects.find((p) => p.projectName === projectName);
		const leadConfig = project?.leads.find((l) => l.agentId === leadId);
		if (!project || !leadConfig) {
			// Unknown project/lead: fail-open (do not block) but log a bypass so
			// a misconfiguration is visible rather than silently disabling the guard.
			console.warn(
				`[reply-guard] guard_bypass: unknown project/lead projectName=${projectName} leadId=${leadId}`,
			);
			res.json({ allow: true, reason: "guard_bypass" });
			return;
		}

		// Classify the target chat.
		let classification: ChatClassification;
		let boundIssueIdentifier: string | null = null;
		// FLY-173: the project core channel (generalChannel) is exempt and is
		// checked FIRST — for the cos-lead (Simba) the core channel IS its
		// chatChannel, so this must win over the channel-top-level branch below,
		// otherwise core triage/overview messages with issue tokens get denied.
		// When generalChannel is unset, behavior is unchanged (backward compatible).
		if (project.generalChannel && chatId === project.generalChannel) {
			classification = "core-channel";
		} else if (chatId === leadConfig.chatChannel) {
			classification = "channel-top-level";
		} else {
			const row = store.getChatThreadByThreadId(chatId);
			if (row) {
				classification = "issue-thread";
				const session = store.getSessionByIssue(row.issue_id);
				boundIssueIdentifier = session?.issue_identifier ?? null;
			} else {
				classification = "other";
			}
		}

		const issueTokens = scanIssueTokens(text, issuePrefixes);
		const decision = evaluateReplyGuard({
			classification,
			boundIssueIdentifier,
			issueTokens,
		});

		if (decision.telemetry) {
			console.warn(
				`[reply-guard] ${decision.telemetry} lead=${leadId} bound=${boundIssueIdentifier ?? "?"} foreign=${(decision.issues ?? []).join(",")}`,
			);
		}

		res.json(decision);
	});

	return router;
}
