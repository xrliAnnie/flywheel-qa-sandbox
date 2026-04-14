import { timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import type { CipherWriter, MemoryService } from "flywheel-edge-worker";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { CleanupService, FetchDiscordClient } from "../CleanupService.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import {
	type HeartbeatNotifier,
	HeartbeatService,
	RegistryHeartbeatNotifier,
} from "../HeartbeatService.js";
import {
	type LeadConfig,
	type ProjectEntry,
	resolveLeadForIssue,
} from "../ProjectConfig.js";
import { RunnerIdleWatchdog } from "../RunnerIdleWatchdog.js";
import { StateStore } from "../StateStore.js";
import { createActionRouter } from "./actions.js";
import { ChatThreadCreator } from "./ChatThreadCreator.js";
import { buildDashboardPayload } from "./dashboard-data.js";
import { getDashboardHtml } from "./dashboard-html.js";
import { EventFilter } from "./EventFilter.js";
import { createEventRouter } from "./event-route.js";
import { ForumPostCreator } from "./ForumPostCreator.js";
import { ForumTagUpdater } from "./ForumTagUpdater.js";
import { GatePoller } from "./gate-poller.js";
import type { LeadRuntime } from "./lead-runtime.js";
import { matchesLead, parseSessionLabels } from "./lead-scope.js";
import { queryLinearIssues } from "./linear-query.js";
import { createMemoryRouter } from "./memory-route.js";
import { postMergeCleanup } from "./post-merge.js";
import { createPublishHtmlRouter } from "./publish-html-route.js";
import type { IRetryDispatcher, IStartDispatcher } from "./retry-dispatcher.js";
import { setupRunInfrastructure } from "./run-infra.js";
import { createStatusQuery } from "./runner-status.js";
import { createRunsRouter } from "./runs-route.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { captureSession as defaultCaptureSession } from "./session-capture.js";
import { createStandupRouter } from "./standup-route.js";
import { StandupService } from "./standup-service.js";
import {
	getTmuxTargetFromCommDb,
	isTmuxSessionAlive,
	killTmuxWindow,
} from "./tmux-lookup.js";
import { type CaptureSessionFn, createQueryRouter } from "./tools.js";
import { createTriageDataRouter } from "./triage-data-route.js";
import { createTriageTemplateRouter } from "./triage-template-route.js";
import type { BridgeConfig } from "./types.js";

/**
 * FLY-47: CommDB is the sole runtime — no Discord fallback.
 * Requires inbox-mcp PID lease alive. Throws on failure.
 */
export async function createLeadRuntime(
	lead: LeadConfig,
	_config: BridgeConfig,
	projectName?: string,
): Promise<LeadRuntime> {
	const { join } = await import("node:path");
	const { homedir } = await import("node:os");
	const { existsSync, readFileSync } = await import("node:fs");

	if (!projectName) {
		throw new Error(
			`Lead "${lead.agentId}": projectName is required for CommDB runtime`,
		);
	}

	const commDbPath = join(
		homedir(),
		".flywheel",
		"comm",
		projectName,
		"comm.db",
	);
	const leasePath = join(
		homedir(),
		".flywheel",
		"comm",
		projectName,
		`.inbox-ready-${lead.agentId}`,
	);

	if (
		!existsSync(commDbPath) ||
		!isLeaseAlive(leasePath, existsSync, readFileSync)
	) {
		throw new Error(
			`Lead "${lead.agentId}": inbox-mcp not ready (DB: ${existsSync(commDbPath)}, lease alive: false at ${leasePath})`,
		);
	}

	const { CommDBLeadRuntime } = await import("./commdb-lead-runtime.js");
	return new CommDBLeadRuntime(commDbPath, lead.agentId);
}

/**
 * Check if inbox-mcp PID lease file is alive.
 * Lease contains { pid, startedAt }. Process must still be running.
 */
function isLeaseAlive(
	leasePath: string,
	existsFn: (p: string) => boolean,
	readFn: (p: string, enc: BufferEncoding) => string,
): boolean {
	if (!existsFn(leasePath)) return false;
	try {
		const lease = JSON.parse(readFn(leasePath, "utf-8"));
		if (typeof lease.pid !== "number" || lease.pid <= 0) return false;
		process.kill(lease.pid, 0); // signal 0 = existence check
		return true;
	} catch {
		return false;
	}
}

function safeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function tokenAuthMiddleware(token?: string): express.RequestHandler {
	return (req, res, next) => {
		if (!token) return next();
		const header = req.headers.authorization ?? "";
		if (!safeCompare(header, `Bearer ${token}`)) {
			res.status(401).json({ error: "unauthorized" });
			return;
		}
		next();
	};
}

export class SseBroadcaster {
	private clients = new Set<express.Response>();
	private poller: ReturnType<typeof setInterval> | null = null;
	private heartbeat: ReturnType<typeof setInterval> | null = null;

	constructor(
		private store: StateStore,
		private stuckThresholdMinutes: number,
	) {}

	addClient(res: express.Response): void {
		try {
			const payload = buildDashboardPayload(
				this.store,
				this.stuckThresholdMinutes,
			);
			res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
		} catch (err) {
			console.error(
				"[SseBroadcaster] Failed to send initial state:",
				(err as Error).message,
			);
		}

		this.clients.add(res);
		if (this.clients.size === 1) this.startPolling();
	}

	removeClient(res: express.Response): void {
		this.clients.delete(res);
		if (this.clients.size === 0) this.stopPolling();
	}

	destroy(): void {
		this.stopPolling();
		for (const client of this.clients) {
			try {
				client.write(": server shutting down\n\n");
				client.end();
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (
					code !== "ERR_STREAM_WRITE_AFTER_END" &&
					code !== "ERR_STREAM_DESTROYED"
				) {
					console.warn(
						"[SseBroadcaster] Unexpected error during destroy:",
						(err as Error).message,
					);
				}
			}
		}
		this.clients.clear();
	}

	get clientCount(): number {
		return this.clients.size;
	}

	get isPolling(): boolean {
		return this.poller !== null;
	}

	private broadcastToClients(data: string): void {
		const dead: express.Response[] = [];
		for (const client of this.clients) {
			try {
				client.write(data);
			} catch {
				dead.push(client);
			}
		}
		for (const d of dead) this.clients.delete(d);
	}

	private startPolling(): void {
		this.poller = setInterval(() => {
			try {
				const payload = buildDashboardPayload(
					this.store,
					this.stuckThresholdMinutes,
				);
				const message = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
				this.broadcastToClients(message);
			} catch (err) {
				console.error(
					"[SseBroadcaster] Failed to build/broadcast payload:",
					(err as Error).message,
				);
			}
		}, 2000);
		this.heartbeat = setInterval(() => {
			this.broadcastToClients(": heartbeat\n\n");
		}, 30000);
	}

	private stopPolling(): void {
		if (this.poller) {
			clearInterval(this.poller);
			this.poller = null;
		}
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
		}
	}
}

/** GEO-294 + FLY-91 Round 3: Options object for new Bridge dependencies. */
export interface BridgeAppOptions {
	vercelToken?: string;
	/** FLY-91 Round 3: Bridge-level shared ChatThreadCreator instance. */
	chatThreadCreator?: ChatThreadCreator;
	/** FLY-91 Round 3: Global Discord bot token for thread creation fallback. */
	globalBotToken?: string;
}

export function createBridgeApp(
	store: StateStore,
	projects: ProjectEntry[],
	config: BridgeConfig,
	broadcaster?: SseBroadcaster,
	transitionOpts?: ApplyTransitionOpts,
	retryDispatcher?: IRetryDispatcher,
	cipherWriter?: CipherWriter,
	eventFilter?: EventFilter,
	forumTagUpdater?: ForumTagUpdater,
	registry?: RuntimeRegistry,
	forumPostCreator?: ForumPostCreator,
	memoryService?: MemoryService,
	captureSessionFn?: CaptureSessionFn,
	startDispatcher?: IStartDispatcher,
	standupService?: StandupService,
	standupProjectName?: string,
	opts?: BridgeAppOptions,
): express.Application {
	const app = express();
	app.disable("x-powered-by");

	app.use(express.json({ limit: "512kb" }));

	// Health — no auth
	app.get("/health", (_req, res) => {
		const active = store.getActiveSessions();
		res.json({
			ok: true,
			uptime: process.uptime(),
			sessions_count: active.length,
		});
	});

	// Dashboard — no auth (loopback only)
	app.get("/", (_req, res) => {
		res.type("html").send(getDashboardHtml());
	});

	// SSE — no auth (loopback only)
	app.get("/sse", (req, res) => {
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		if (broadcaster) {
			res.flushHeaders();
			broadcaster.addClient(res);
			req.on("close", () => broadcaster.removeClient(res));
		} else {
			// Snapshot mode — no broadcaster configured (tests or direct createBridgeApp usage)
			if (process.env.NODE_ENV !== "test") {
				console.warn(
					"[SSE] No broadcaster configured — serving one-shot snapshot",
				);
			}
			const payload = buildDashboardPayload(
				store,
				config.stuckThresholdMinutes,
			);
			res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
			res.end();
		}
	});

	// GEO-280: Post-merge cleanup callback (fire-and-forget after approve)
	// Bridge only closes tmux session + audit. Other cleanup (worktree, docs) is Runner/Orchestrator responsibility.
	const onApproved = (
		executionId: string,
		session: { issue_id: string; project_name: string },
	) => {
		postMergeCleanup(
			{
				executionId,
				issueId: session.issue_id,
				projectName: session.project_name,
			},
			store,
		).catch((err) => {
			console.error(
				`[post-merge] Cleanup failed for ${executionId}:`,
				(err as Error).message,
			);
		});
	};

	// Dashboard actions — no auth (loopback only, same handlers as /api/actions)
	app.use(
		"/actions",
		createActionRouter(
			store,
			projects,
			transitionOpts,
			config,
			retryDispatcher,
			cipherWriter,
			eventFilter,
			forumTagUpdater,
			registry,
			onApproved,
		),
	);

	// /events — ingest auth
	app.use(
		"/events",
		tokenAuthMiddleware(config.ingestToken),
		createEventRouter(
			store,
			projects,
			config,
			cipherWriter,
			transitionOpts,
			eventFilter,
			forumTagUpdater,
			registry,
			forumPostCreator,
		),
	);

	// /api/* — api auth
	app.use(
		"/api",
		tokenAuthMiddleware(config.apiToken),
		createQueryRouter(store, projects, {
			retryDispatcher,
			captureSessionFn,
			statusQueryFn: captureSessionFn
				? createStatusQuery(captureSessionFn).query
				: undefined,
			chatThreadsEnabled: config.chatThreadsEnabled,
			chatThreadCreator: opts?.chatThreadCreator,
			globalBotToken: opts?.globalBotToken,
			discordOwnerUserId: config.discordOwnerUserId,
		}),
	);
	app.use(
		"/api/actions",
		tokenAuthMiddleware(config.apiToken),
		createActionRouter(
			store,
			projects,
			transitionOpts,
			config,
			retryDispatcher,
			cipherWriter,
			eventFilter,
			forumTagUpdater,
			registry,
			onApproved,
		),
	);

	// GEO-270: Close stale tmux session (resource cleanup, no status change)
	app.post(
		"/api/sessions/:executionId/close-tmux",
		tokenAuthMiddleware(config.apiToken),
		async (req, res) => {
			const executionId = req.params.executionId as string;
			const { leadId } = (req.body ?? {}) as { leadId?: string };

			const session = store.getSession(executionId);
			if (!session) {
				res.status(404).json({ error: "Session not found" });
				return;
			}

			// FLY-44: Only block close-tmux when Runner still needs tmux
			const tmuxProtectedStates = new Set(["running", "approved_to_ship"]);
			if (tmuxProtectedStates.has(session.status)) {
				res.status(409).json({
					error: `Cannot close tmux for session in "${session.status}" state — Runner still needs tmux`,
				});
				return;
			}

			if (leadId && projects) {
				try {
					if (!matchesLead(session, leadId, projects)) {
						res.status(403).json({
							success: false,
							message: `Session ${executionId} is outside lead "${leadId}" scope`,
						});
						return;
					}
				} catch (err) {
					console.warn(
						`[close-tmux] matchesLead error for ${executionId}: ${(err as Error).message}`,
					);
					res.status(403).json({
						success: false,
						message: `Lead scope check failed: ${(err as Error).message}`,
					});
					return;
				}
			}

			const target = getTmuxTargetFromCommDb(executionId, session.project_name);
			if (!target) {
				res.json({ closed: false, reason: "No tmux target found" });
				return;
			}

			const result = await killTmuxWindow(target.tmuxWindow);

			store.insertEvent({
				event_id: `close-tmux-${executionId}-${Date.now()}`,
				execution_id: executionId,
				issue_id: session.issue_id,
				project_name: session.project_name,
				event_type: result.killed ? "tmux_closed" : "tmux_close_failed",
				source: "bridge.close-tmux",
				payload: {
					leadId: leadId ?? "unknown",
					tmuxWindow: target.tmuxWindow,
					error: result.error,
				},
			});

			res.json({ closed: result.killed, error: result.error });
		},
	);

	// GEO-270: Scan for stale sessions (manual/cron trigger)
	// With notify=true, groups stale sessions by Lead and sends Discord summary
	app.post(
		"/api/patrol/scan-stale",
		tokenAuthMiddleware(config.apiToken),
		async (req, res) => {
			const { thresholdHours, notify } = (req.body ?? {}) as {
				thresholdHours?: number;
				notify?: boolean;
			};
			const threshold = thresholdHours ?? 24;

			const stale = store.getStaleCompletedSessions(threshold);

			interface StaleEntry {
				execution_id: string;
				issue_id: string;
				issue_identifier?: string;
				issue_title?: string;
				project_name: string;
				status: string;
				last_activity_at?: string;
				hours_since_activity: number;
				tmux_alive: boolean;
				tmux_target?: string;
				session_role?: string;
			}

			const results: StaleEntry[] = [];

			for (const session of stale) {
				if (!session.project_name) continue;

				const hoursSince = session.last_activity_at
					? Math.round(
							(Date.now() -
								new Date(
									`${session.last_activity_at.replace(" ", "T")}Z`,
								).getTime()) /
								3_600_000,
						)
					: 0;

				const target = getTmuxTargetFromCommDb(
					session.execution_id,
					session.project_name,
				);

				let tmuxAlive = false;
				if (target) {
					tmuxAlive = await isTmuxSessionAlive(target.sessionName);
				}

				results.push({
					execution_id: session.execution_id,
					issue_id: session.issue_id,
					issue_identifier: session.issue_identifier,
					issue_title: session.issue_title,
					project_name: session.project_name,
					status: session.status,
					last_activity_at: session.last_activity_at,
					hours_since_activity: hoursSince,
					tmux_alive: tmuxAlive,
					tmux_target: target?.tmuxWindow,
					session_role: session.session_role,
				});
			}

			const alive = results.filter((r) => r.tmux_alive);

			// ── Discord notification (notify=true) ──
			const notifications: Array<{
				leadId: string;
				chatChannel: string;
				sessionCount: number;
				sent: boolean;
				error?: string;
			}> = [];

			if (notify && alive.length > 0 && projects.length > 0) {
				// Group alive sessions by Lead
				const byLead = new Map<
					string,
					{
						lead: import("../ProjectConfig.js").LeadConfig;
						sessions: StaleEntry[];
					}
				>();

				for (const entry of alive) {
					try {
						const fullSession = store.getSession(entry.execution_id);
						if (!fullSession) continue;
						const labels = parseSessionLabels(fullSession);
						const { lead } = resolveLeadForIssue(
							projects,
							entry.project_name,
							labels,
						);
						const existing = byLead.get(lead.agentId);
						if (existing) {
							existing.sessions.push(entry);
						} else {
							byLead.set(lead.agentId, {
								lead,
								sessions: [entry],
							});
						}
					} catch {
						// Can't resolve Lead — skip notification for this session
					}
				}

				// FLY-47: Deliver stale notification via control channel — Lead relays to Annie
				for (const [leadId, group] of byLead) {
					const { lead, sessions: leadSessions } = group;

					// Build summary for Lead to relay to Annie
					const sessionList = leadSessions
						.map((s, i) => {
							const id = s.issue_identifier ?? s.execution_id;
							const title = s.issue_title ? ` — ${s.issue_title}` : "";
							// FLY-59: Show role label for non-main sessions
							const role =
								s.session_role && s.session_role !== "main"
									? ` [${s.session_role.toUpperCase()}]`
									: "";
							return `${i + 1}. **${id}**${title}${role} (${s.status}, ${s.hours_since_activity}h ago)`;
						})
						.join("\n");

					const eventId = `stale_patrol_${Date.now()}_${leadId}`;
					const payload: import("./hook-payload.js").HookPayload = {
						event_type: "stale_session_summary",
						execution_id: leadSessions[0]?.execution_id ?? "patrol",
						issue_id: "stale-patrol",
						project_name: leadSessions[0]?.project_name ?? "unknown",
						status: "stale_completed",
						summary: `${leadSessions.length} stale sessions with tmux still alive:\n${sessionList}`,
						notification_context:
							"Tell Annie about these stale sessions and ask her to check them.",
						session_role: leadSessions[0]?.session_role ?? "main",
					};

					const seq = store.appendLeadEvent(
						leadId,
						eventId,
						"stale_session_summary",
						JSON.stringify(payload),
					);

					const runtime = registry?.getForLead(leadId);
					if (runtime) {
						const envelope: import("./lead-runtime.js").LeadEventEnvelope = {
							seq,
							event: payload,
							sessionKey: "stale-patrol",
							leadId,
							timestamp: new Date().toISOString(),
						};
						const result = await runtime.deliver(envelope);
						if (result.delivered) {
							store.markLeadEventDelivered(seq);
							notifications.push({
								leadId,
								chatChannel: lead.chatChannel,
								sessionCount: leadSessions.length,
								sent: true,
							});
						} else {
							store.recordDeliveryFailure(
								seq,
								result.error ?? "deliver returned false",
							);
							notifications.push({
								leadId,
								chatChannel: lead.chatChannel,
								sessionCount: leadSessions.length,
								sent: false,
								error: result.error ?? "control channel delivery failed",
							});
						}
					} else {
						notifications.push({
							leadId,
							chatChannel: lead.chatChannel ?? "(none)",
							sessionCount: leadSessions.length,
							sent: false,
							error: "No runtime registered",
						});
					}
				}
			}

			res.json({
				threshold_hours: threshold,
				total: results.length,
				tmux_alive: alive.length,
				tmux_dead: results.length - alive.length,
				sessions: results,
				...(notify ? { notifications } : {}),
			});
		},
	);

	// Forum tag update — proxy to Discord API (GEO-167)
	app.post(
		"/api/forum-tag",
		tokenAuthMiddleware(config.apiToken),
		async (req, res) => {
			const { thread_id, tag_ids } = req.body as {
				thread_id?: string;
				tag_ids?: string[];
			};
			if (!thread_id || typeof thread_id !== "string") {
				res.status(400).json({ error: "thread_id is required" });
				return;
			}
			if (
				!Array.isArray(tag_ids) ||
				!tag_ids.every((t) => typeof t === "string")
			) {
				res.status(400).json({ error: "tag_ids must be a string array" });
				return;
			}
			if (!config.discordBotToken) {
				res.status(503).json({ error: "Discord bot token not configured" });
				return;
			}
			try {
				const discordRes = await fetch(
					`https://discord.com/api/v10/channels/${thread_id}`,
					{
						method: "PATCH",
						headers: {
							Authorization: `Bot ${config.discordBotToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ applied_tags: tag_ids }),
					},
				);
				if (!discordRes.ok) {
					const body = await discordRes.text();
					console.warn(
						`[forum-tag] Discord returned ${discordRes.status}: ${body}`,
					);
					res
						.status(discordRes.status)
						.json({ error: "Discord API error", detail: body });
					return;
				}
				res.json({ ok: true });
			} catch (err) {
				console.error(
					"[forum-tag] Discord API call failed:",
					(err as Error).message,
				);
				res.status(502).json({ error: "Failed to reach Discord API" });
			}
		},
	);

	// CIPHER principle confirmation route
	if (cipherWriter) {
		app.post(
			"/api/cipher-principle",
			tokenAuthMiddleware(config.apiToken),
			async (req, res) => {
				const { principleId, action } = req.body as {
					principleId?: string;
					action?: string;
				};
				if (
					!principleId ||
					!action ||
					!["activate", "retire"].includes(action)
				) {
					res
						.status(400)
						.json({ error: "missing principleId or invalid action" });
					return;
				}
				if (
					!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
						principleId,
					)
				) {
					res.status(400).json({ error: "invalid principleId format" });
					return;
				}
				try {
					const updated =
						action === "activate"
							? await cipherWriter.activatePrinciple(principleId)
							: await cipherWriter.retirePrinciple(principleId, "CEO retired");
					if (!updated) {
						res
							.status(404)
							.json({ error: "principle not found or not in expected state" });
						return;
					}
					// Principles are loaded into DecisionLayer HardRules once at process start
					// (setup.ts). A running worker reuses the same DecisionLayer for its entire
					// DAG batch. This change takes effect on the next process/DAG start.
					res.json({ ok: true, effective: "next_process_start" });
				} catch {
					res.status(500).json({ error: "principle action failed" });
				}
			},
		);
	}

	// Linear API proxy — agent doesn't hold LINEAR_API_KEY directly (GEO-187)
	app.post(
		"/api/linear/create-issue",
		tokenAuthMiddleware(config.apiToken),
		async (req, res) => {
			if (!config.linearApiKey) {
				res.status(501).json({ error: "LINEAR_API_KEY not configured" });
				return;
			}
			const { title, description, priority, labels, team, project } =
				req.body ?? {};
			if (!title || typeof title !== "string") {
				res.status(400).json({ error: "title is required" });
				return;
			}
			if (title.length > 500) {
				res.status(400).json({ error: "title must be 500 chars or less" });
				return;
			}
			if (description !== undefined && typeof description !== "string") {
				res.status(400).json({ error: "description must be a string" });
				return;
			}
			if (
				priority !== undefined &&
				(typeof priority !== "number" || priority < 0 || priority > 4)
			) {
				res.status(400).json({ error: "priority must be 0-4" });
				return;
			}
			if (
				labels !== undefined &&
				(!Array.isArray(labels) ||
					!labels.every((l: unknown) => typeof l === "string"))
			) {
				res.status(400).json({ error: "labels must be a string array" });
				return;
			}
			// GEO-298: team parameter — required for multi-team workspaces
			if (team !== undefined && typeof team !== "string") {
				res.status(400).json({
					error: 'team must be a string (team key, e.g. "FLY")',
				});
				return;
			}
			// GEO-298: project parameter — optional, associates issue with a project
			if (project !== undefined && typeof project !== "string") {
				res
					.status(400)
					.json({ error: "project must be a string (project name)" });
				return;
			}
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ apiKey: config.linearApiKey });

				// GEO-298: Team resolution — by key if specified, require if >1 team
				const allTeams = await client.teams();
				let targetTeam: (typeof allTeams.nodes)[number] | undefined;
				if (team) {
					targetTeam = allTeams.nodes.find(
						(t: { key: string }) => t.key === team,
					);
					if (!targetTeam) {
						res.status(404).json({
							error: `Linear team with key "${team}" not found. Available: ${allTeams.nodes.map((t: { key: string }) => t.key).join(", ")}`,
						});
						return;
					}
				} else if (allTeams.nodes.length === 1) {
					targetTeam = allTeams.nodes[0];
				} else {
					res.status(400).json({
						error: `Multiple teams found (${allTeams.nodes.map((t: { key: string }) => t.key).join(", ")}). "team" parameter is required.`,
					});
					return;
				}

				if (!targetTeam) {
					res.status(500).json({ error: "No Linear team found" });
					return;
				}

				// GEO-298: Project resolution — optional, by name
				let projectId: string | undefined;
				if (project) {
					const projects = await client.projects({
						filter: { name: { eq: project } },
					});
					const matched = projects.nodes[0];
					if (!matched) {
						res.status(404).json({
							error: `Linear project "${project}" not found`,
						});
						return;
					}
					projectId = matched.id;
				}

				const issue = await client.createIssue({
					teamId: targetTeam.id,
					title,
					description: description ?? "",
					priority: priority ?? 0,
					labelIds: labels,
					...(projectId && { projectId }),
				});
				const created = await issue.issue;
				res.json({
					ok: true,
					issue: {
						id: created?.id,
						identifier: created?.identifier,
						url: created?.url,
					},
				});
			} catch (err) {
				console.error(
					"[linear-proxy] create-issue failed:",
					(err as Error).message,
				);
				res.status(502).json({ error: "Linear API error" });
			}
		},
	);

	app.patch(
		"/api/linear/update-issue",
		tokenAuthMiddleware(config.apiToken),
		async (req, res) => {
			if (!config.linearApiKey) {
				res.status(501).json({ error: "LINEAR_API_KEY not configured" });
				return;
			}
			const { issueId, title, description, priority, status } = req.body ?? {};
			if (!issueId || typeof issueId !== "string") {
				res.status(400).json({ error: "issueId is required" });
				return;
			}
			if (title !== undefined && typeof title !== "string") {
				res.status(400).json({ error: "title must be a string" });
				return;
			}
			if (description !== undefined && typeof description !== "string") {
				res.status(400).json({ error: "description must be a string" });
				return;
			}
			if (
				priority !== undefined &&
				(typeof priority !== "number" || priority < 0 || priority > 4)
			) {
				res.status(400).json({ error: "priority must be 0-4" });
				return;
			}
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ apiKey: config.linearApiKey });
				const update: Record<string, unknown> = {};
				if (title !== undefined) update.title = title;
				if (description !== undefined) update.description = description;
				if (priority !== undefined) update.priority = priority;
				if (status !== undefined) {
					// Resolve status name to workflow state ID
					const issue = await client.issue(issueId);
					const team = await issue.team;
					if (team) {
						const states = await team.states();
						const state = states.nodes.find(
							(s) => s.name.toLowerCase() === String(status).toLowerCase(),
						);
						if (state) {
							update.stateId = state.id;
						} else {
							const available = states.nodes.map((s) => s.name).join(", ");
							res.status(400).json({
								error: `Unknown status "${status}". Available: ${available}`,
							});
							return;
						}
					}
				}
				await client.updateIssue(issueId, update);
				res.json({ ok: true });
			} catch (err) {
				console.error(
					"[linear-proxy] update-issue failed:",
					(err as Error).message,
				);
				res.status(502).json({ error: "Linear API error" });
			}
		},
	);

	// Linear query proxy — list issues with filters (GEO-276, refactored GEO-294)
	app.get(
		"/api/linear/issues",
		tokenAuthMiddleware(config.apiToken),
		async (req, res) => {
			if (!config.linearApiKey) {
				res.status(501).json({ error: "LINEAR_API_KEY not configured" });
				return;
			}

			// Normalize query params — Express may pass arrays for repeated keys
			const project = Array.isArray(req.query.project)
				? String(req.query.project[0])
				: (req.query.project as string | undefined);
			const stateParam = Array.isArray(req.query.state)
				? (req.query.state as string[]).join(",")
				: (req.query.state as string | undefined);
			const labelsParam = Array.isArray(req.query.labels)
				? (req.query.labels as string[]).join(",")
				: (req.query.labels as string | undefined);
			const limitRaw =
				req.query.limit !== undefined
					? parseInt(String(req.query.limit), 10)
					: 50;
			const limit = Number.isNaN(limitRaw)
				? 50
				: Math.min(Math.max(1, limitRaw), 250);

			const slim = req.query.slim === "true" || req.query.slim === "1";

			try {
				const result = await queryLinearIssues(config.linearApiKey, {
					project: project ?? undefined,
					states: stateParam
						? stateParam.split(",").map((s) => s.trim())
						: undefined,
					labels: labelsParam
						? labelsParam.split(",").map((l) => l.trim())
						: undefined,
					limit,
					slim,
				});

				res.json({
					issues: result.issues,
					count: result.issues.length,
					truncated: result.truncated,
				});
			} catch (err) {
				console.error(
					"[linear-proxy] list-issues failed:",
					(err as Error).message,
				);
				res.status(502).json({ error: "Linear API error" });
			}
		},
	);

	// FLY-21: Combined triage data endpoint — issues + sessions + capacity in one call
	app.use(
		"/api/triage/data",
		tokenAuthMiddleware(config.apiToken),
		createTriageDataRouter(
			store,
			projects,
			config.linearApiKey,
			config.maxConcurrentRunners,
			startDispatcher,
		),
	);

	// FLY-27: Triage HTML template endpoint — serves static template for Simba
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const templatePath = resolve(__dirname, "../../static/triage-template.html");
	app.use(
		"/api/triage/template",
		tokenAuthMiddleware(config.apiToken),
		createTriageTemplateRouter(templatePath),
	);

	// Memory API (GEO-198/GEO-204) — conditional, only if memoryService initialized
	if (memoryService) {
		app.use(
			"/api/memory",
			tokenAuthMiddleware(config.apiToken),
			createMemoryRouter(memoryService, projects),
		);
	}

	// Discord guild ID endpoint (GEO-187) — agent can query to build Forum Thread links
	app.get(
		"/api/config/discord-guild-id",
		tokenAuthMiddleware(config.apiToken),
		(_req, res) => {
			if (!config.discordGuildId) {
				res.status(404).json({ error: "DISCORD_GUILD_ID not configured" });
				return;
			}
			res.json({ guild_id: config.discordGuildId });
		},
	);

	// GEO-195: Bootstrap endpoint — crash recovery for Claude Lead sessions
	app.post(
		"/api/bootstrap/:leadId",
		tokenAuthMiddleware(config.apiToken),
		async (req, res) => {
			const { leadId } = req.params;
			if (!leadId || typeof leadId !== "string") {
				res.status(400).json({ error: "leadId is required" });
				return;
			}
			if (!registry) {
				res.status(503).json({ error: "RuntimeRegistry not available" });
				return;
			}
			const runtime = registry.getForLead(leadId);
			if (!runtime) {
				res
					.status(404)
					.json({ error: `No runtime registered for lead "${leadId}"` });
				return;
			}
			try {
				const { generateBootstrap } = await import("./bootstrap-generator.js");
				const snapshot = await generateBootstrap(
					leadId,
					store,
					projects,
					memoryService,
					{ chatThreadsEnabled: config.chatThreadsEnabled },
				);
				await runtime.sendBootstrap(snapshot);
				res.json({
					delivered: true,
					summary: {
						activeSessions: snapshot.activeSessions.length,
						pendingDecisions: snapshot.pendingDecisions.length,
						recentFailures: snapshot.recentFailures.length,
						recentEvents: snapshot.recentEvents.length,
					},
				});
			} catch (err) {
				console.error(
					`[bootstrap] Failed for ${leadId}:`,
					(err as Error).message,
				);
				res.status(500).json({ error: "Bootstrap generation failed" });
			}
		},
	);

	// GEO-267: /api/runs — start new Runner executions
	if (startDispatcher) {
		const runsRouter = createRunsRouter(
			startDispatcher,
			store,
			projects,
			config.maxConcurrentRunners,
			config.discordGuildId,
			config.chatThreadsEnabled,
		);
		if (config.apiToken) {
			app.use("/api/runs", tokenAuthMiddleware(config.apiToken), runsRouter);
		} else {
			app.use("/api/runs", runsRouter);
		}
	}

	// GEO-288: /api/standup — daily standup trigger
	if (standupService && standupProjectName) {
		const standupRouter = createStandupRouter(
			standupService,
			standupProjectName,
		);
		if (config.apiToken) {
			app.use(
				"/api/standup",
				tokenAuthMiddleware(config.apiToken),
				standupRouter,
			);
		} else {
			app.use("/api/standup", standupRouter);
		}
	}

	// GEO-294: /api/publish-html — generic HTML publishing (Vercel deploy)
	const publishHtmlRouter = createPublishHtmlRouter(opts?.vercelToken);
	if (config.apiToken) {
		app.use(
			"/api/publish-html",
			tokenAuthMiddleware(config.apiToken),
			publishHtmlRouter,
		);
	} else {
		app.use("/api/publish-html", publishHtmlRouter);
	}

	// Catch-all 404 (must be after all routes)
	app.use((_req, res) => {
		res.status(404).json({ error: "not found" });
	});

	// JSON error handler — returns JSON instead of Express default HTML with stack trace
	app.use(((
		err: Error & { status?: number; type?: string },
		_req,
		res,
		_next,
	) => {
		if (err.type === "entity.parse.failed") {
			res.status(400).json({ error: "invalid JSON" });
			return;
		}
		console.error("[bridge] Unhandled error:", err.message);
		res.status(err.status ?? 500).json({ error: "internal error" });
	}) as express.ErrorRequestHandler);

	return app;
}

export async function startBridge(
	config: BridgeConfig,
	projects: ProjectEntry[],
	opts?: {
		store?: StateStore;
		retryDispatcher?: IRetryDispatcher;
		startDispatcher?: IStartDispatcher;
		cipherWriter?: CipherWriter;
		statusTagMap?: Record<string, string[]>;
		memoryService?: MemoryService;
		registry?: RuntimeRegistry;
	},
): Promise<{
	app: express.Application;
	store: StateStore;
	close: () => Promise<void>;
	registry: RuntimeRegistry;
}> {
	if (projects.length === 0) {
		throw new Error(
			"No projects configured — check FLYWHEEL_PROJECTS or project config",
		);
	}

	const store = opts?.store ?? (await StateStore.create(config.dbPath));
	let retryDispatcher = opts?.retryDispatcher;
	// GEO-158: FSM instance + DirectiveExecutor for validated transitions
	const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
	const executor = new DirectiveExecutor(store);
	const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
	const broadcaster = new SseBroadcaster(store, config.stuckThresholdMinutes);

	// GEO-195: Initialize RuntimeRegistry — per-lead runtime selection
	// GEO-267: Accept pre-created registry (from run-bridge.ts for DirectEventSink injection)
	const registry = opts?.registry ?? new RuntimeRegistry();
	for (const project of projects) {
		for (const lead of project.leads) {
			try {
				const runtime = await createLeadRuntime(
					lead,
					config,
					project.projectName,
				);
				registry.register(lead, runtime);
			} catch (err) {
				// No Discord fallback — if CommDB isn't ready, skip this lead
				console.warn(
					`[Bridge] Skipping runtime for "${lead.agentId}":`,
					(err as Error).message,
				);
			}
		}
	}
	if (registry.size > 0) {
		console.log(
			`[Bridge] RuntimeRegistry: ${registry.size} lead runtime(s) registered`,
		);
	}

	// FLY-80: Periodic retry for leads not ready at startup (e.g., Lead starts after Bridge).
	// Checks every 30s until all leads are registered, then stops.
	const unregisteredLeads: Array<{ lead: LeadConfig; projectName: string }> =
		[];
	for (const project of projects) {
		for (const lead of project.leads) {
			if (!registry.getForLead(lead.agentId)) {
				unregisteredLeads.push({ lead, projectName: project.projectName });
			}
		}
	}
	let runtimeRetryTimer: ReturnType<typeof setInterval> | undefined;
	if (unregisteredLeads.length > 0) {
		console.log(
			`[Bridge] ${unregisteredLeads.length} lead(s) not ready at startup — will retry registration every 30s`,
		);
		runtimeRetryTimer = setInterval(async () => {
			for (let i = unregisteredLeads.length - 1; i >= 0; i--) {
				const entry = unregisteredLeads[i]!;
				const { lead, projectName } = entry;
				try {
					const runtime = await createLeadRuntime(lead, config, projectName);
					registry.register(lead, runtime);
					unregisteredLeads.splice(i, 1);
					console.log(
						`[Bridge] Late-registered runtime for "${lead.agentId}" (project: ${projectName})`,
					);
				} catch {
					// Still not ready — will retry next interval
				}
			}
			if (unregisteredLeads.length === 0) {
				console.log(
					"[Bridge] All lead runtimes registered — stopping retry timer",
				);
				clearInterval(runtimeRetryTimer!);
				runtimeRetryTimer = undefined;
			}
		}, 30_000);
	}

	// GEO-187: EventFilter + ForumTagUpdater
	const eventFilter = new EventFilter();
	const statusTagMap = opts?.statusTagMap ?? config.statusTagMap ?? {};

	// GEO-253: 3-state + multi-forum startup diagnostics
	const allLeads = projects.flatMap((p) => p.leads);
	// GEO-275: exclude leads without forumChannel (e.g., PM leads) from forum-related diagnostics
	const forumLeads = allLeads.filter((l) => l.forumChannel != null);
	const leadsWithMap = forumLeads.filter((l) => l.statusTagMap != null);
	const leadsWithoutMap = forumLeads.filter((l) => l.statusTagMap == null);
	const globalEmpty = Object.keys(statusTagMap).length === 0;

	if (globalEmpty && leadsWithMap.length === 0) {
		console.warn(
			"[Bridge] No statusTagMap configured (global or per-lead) — ForumTagUpdater will skip all tag updates.",
		);
	} else if (
		globalEmpty &&
		leadsWithoutMap.length > 0 &&
		leadsWithMap.length > 0
	) {
		console.warn(
			`[Bridge] Global statusTagMap is empty. ${leadsWithMap.length}/${forumLeads.length} leads have per-lead statusTagMap. ` +
				`Leads missing config: ${leadsWithoutMap.map((l) => l.agentId).join(", ")} — these will skip tag updates.`,
		);
	} else if (globalEmpty) {
		console.log(
			"[Bridge] Global statusTagMap is empty; all leads have per-lead statusTagMap configured.",
		);
	} else if (!globalEmpty && leadsWithoutMap.length > 0) {
		const uniqueForums = new Set(forumLeads.map((l) => l.forumChannel));
		if (uniqueForums.size > 1) {
			console.warn(
				`[Bridge] Multiple forum channels detected but ${leadsWithoutMap.length} lead(s) lack per-lead statusTagMap ` +
					`and will fallback to global STATUS_TAG_MAP (which may contain wrong tag IDs): ` +
					`${leadsWithoutMap.map((l) => l.agentId).join(", ")}`,
			);
		}
	}
	const forumTagUpdater = new ForumTagUpdater(statusTagMap);

	// GEO-195: ForumPostCreator — Bridge auto-creates Forum Posts
	const forumPostCreator = new ForumPostCreator(store, statusTagMap);

	// GEO-288: Standup service (v2 — no scheduler, triggered by external cron)
	const standupChannel = process.env.STANDUP_CHANNEL;
	const standupSimbaMention =
		process.env.STANDUP_SIMBA_MENTION ?? "<@1487339075563290745>";

	// Resolve standup project name — single-project defaults, multi-project requires config
	const standupProjectName: string | undefined = (() => {
		const envName = process.env.STANDUP_PROJECT_NAME;
		if (envName) {
			const match = projects.find((p) => p.projectName === envName);
			if (!match) {
				console.warn(
					`[Bridge] STANDUP_PROJECT_NAME="${envName}" does not match any configured project. Standup disabled.`,
				);
				return undefined;
			}
			return match.projectName;
		}
		if (projects.length === 1) {
			return projects[0]!.projectName;
		}
		if (projects.length > 1) {
			console.warn(
				"[Bridge] Multi-project setup requires STANDUP_PROJECT_NAME. Standup disabled.",
			);
		}
		return undefined;
	})();

	// Resolve standup lead — scoped to standup project
	const standupProject = standupProjectName
		? projects.find((p) => p.projectName === standupProjectName)
		: undefined;
	const standupLeadId =
		process.env.STANDUP_LEAD_ID ??
		(() => {
			const leads = standupProject?.leads ?? projects.flatMap((p) => p.leads);
			// FLY-71: Standup is CoS (Simba) responsibility per product spec §2.1
			const cos = leads.find((l) => l.agentId.includes("cos"));
			return cos?.agentId ?? leads[0]?.agentId ?? "unknown";
		})();
	const standupLead = (standupProject?.leads ?? []).find(
		(l) => l.agentId === standupLeadId,
	);
	if (standupProjectName && !standupLead) {
		console.warn(
			`[Bridge] STANDUP_LEAD_ID="${standupLeadId}" not found in project "${standupProjectName}" leads. Standup will fail closed on delivery.`,
		);
	}
	// FLY-71: The sending bot must NOT be the standup lead (CoS/Simba), because
	// Discord bots don't receive their own MESSAGE_CREATE events — Simba needs
	// to see the standup message to trigger triage. Use a different lead's token.
	const standupSenderLead = (standupProject?.leads ?? []).find(
		(l) => l.agentId !== standupLeadId && l.botToken,
	);
	const standupBotToken = standupSenderLead?.botToken ?? standupLead?.botToken;

	// Parse stale threshold for standup (same env var as GEO-270 patrol)
	const standupStaleThresholdHours = (() => {
		const v = parseInt(process.env.TEAMLEAD_STALE_THRESHOLD_HOURS ?? "24", 10);
		return Number.isFinite(v) && v >= 1 ? v : 24;
	})();

	// LINEAR_WORKSPACE_SLUG: e.g. "geoforge3d" → constructs https://linear.app/geoforge3d/issue
	const linearWorkspaceSlug = process.env.LINEAR_WORKSPACE_SLUG;
	if (!linearWorkspaceSlug) {
		console.warn(
			"[Bridge] LINEAR_WORKSPACE_SLUG not set — standup issue links will be plain text",
		);
	}
	const linearIssueBaseUrl = linearWorkspaceSlug
		? `https://linear.app/${linearWorkspaceSlug}/issue`
		: undefined;

	let standupService: StandupService | undefined;
	if (standupProjectName) {
		standupService = new StandupService(
			store,
			projects,
			standupBotToken,
			config.maxConcurrentRunners,
			config.stuckThresholdMinutes,
			standupStaleThresholdHours,
			standupChannel,
			standupSimbaMention,
			linearIssueBaseUrl,
		);
		console.log(
			`[Bridge] Standup configured — project="${standupProjectName}", channel=${standupChannel ?? "(none)"}, lead=${standupLeadId}`,
		);
	}

	// GEO-294: Vercel token for HTML publishing
	const vercelToken = process.env.VERCEL_TOKEN;
	if (vercelToken) {
		console.log("[Bridge] HTML publishing configured (Vercel)");
	}

	// FLY-91 Round 3: Create shared ChatThreadCreator at Bridge level (before run infra).
	// Single instance shared by both DirectEventSink (via run-infra) and query router.
	const chatThreadCreator = config.chatThreadsEnabled
		? new ChatThreadCreator(store)
		: undefined;
	if (config.chatThreadsEnabled && !chatThreadCreator) {
		throw new Error(
			"[Bridge] chatThreadsEnabled=true but ChatThreadCreator failed to initialize",
		);
	}
	if (chatThreadCreator) {
		console.log("[Bridge] Shared ChatThreadCreator created");
	}

	// FLY-22/FLY-50: Create RunDispatcher internally when not injected via opts.
	// RunDispatcher implements both IStartDispatcher and IRetryDispatcher,
	// so a single instance serves both roles.
	// Track the internal dispatcher separately for cleanup — if a caller injects
	// retryDispatcher but not startDispatcher, they are different instances.
	let startDispatcher = opts?.startDispatcher;
	let internalDispatcher: IRetryDispatcher | undefined;
	if (!startDispatcher) {
		try {
			const dispatcher = await setupRunInfrastructure(
				store,
				config,
				projects,
				registry,
				{ chatThreadCreator },
			);
			startDispatcher = dispatcher;
			internalDispatcher = dispatcher;
			// FLY-50: Also wire as retryDispatcher when not externally provided
			if (!retryDispatcher) {
				retryDispatcher = dispatcher;
			}
			console.log("[Bridge] RunDispatcher created internally");
		} catch (err) {
			console.warn(
				"[Bridge] Failed to create RunDispatcher — /api/runs will be unavailable:",
				(err as Error).message,
			);
		}
	}

	const app = createBridgeApp(
		store,
		projects,
		config,
		broadcaster,
		transitionOpts,
		retryDispatcher,
		opts?.cipherWriter,
		eventFilter,
		forumTagUpdater,
		registry,
		forumPostCreator,
		opts?.memoryService,
		defaultCaptureSession,
		startDispatcher,
		standupService,
		standupProjectName,
		{
			vercelToken,
			chatThreadCreator,
			globalBotToken: config.discordBotToken,
		},
	);

	const server = app.listen(config.port, config.host);

	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});

	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : config.port;
	console.log(`[Bridge] Listening on ${config.host}:${port}`);

	// GEO-195: Use RegistryHeartbeatNotifier when registry has entries, else no-op
	const notifier: HeartbeatNotifier =
		registry.size > 0
			? new RegistryHeartbeatNotifier(
					registry,
					projects,
					store,
					eventFilter,
					config.chatThreadsEnabled,
				)
			: {
					onSessionStuck: async () => {},
					onSessionOrphaned: async () => {},
					onSessionStale: async () => {},
				};

	// GEO-270: Stale session patrol config (local variables, not in BridgeConfig)
	const staleThresholdHours = (() => {
		const v = parseInt(process.env.TEAMLEAD_STALE_THRESHOLD_HOURS ?? "24", 10);
		return Number.isFinite(v) && v >= 1 ? v : 24;
	})();
	const staleCheckIntervalMs = (() => {
		const v = parseInt(
			process.env.TEAMLEAD_STALE_CHECK_INTERVAL ?? "21600000",
			10,
		);
		return Number.isFinite(v) && v >= 1 ? v : 6 * 3_600_000;
	})();

	const heartbeatService = new HeartbeatService(
		store,
		notifier,
		config.stuckThresholdMinutes,
		config.stuckCheckIntervalMs,
		config.orphanThresholdMinutes,
		transitionOpts,
		staleThresholdHours,
		staleCheckIntervalMs,
	);
	heartbeatService.start();

	let cleanupService: CleanupService | null = null;
	if (config.discordBotToken) {
		const dc = new FetchDiscordClient(config.discordBotToken);
		cleanupService = new CleanupService(
			store,
			dc,
			config.cleanupThresholdMinutes ?? 1440,
			config.cleanupIntervalMs ?? 3_600_000,
		);
		cleanupService.start();
		console.log("[Bridge] CleanupService started");
	}

	// FLY-62: Gate question poller
	const gatePoller = new GatePoller({
		pollIntervalMs: 3_000,
		projects,
		store,
		runtimeRegistry: registry,
		chatThreadsEnabled: config.chatThreadsEnabled,
	});
	gatePoller.start();

	// FLY-92: Runner idle watchdog — detects stuck Runners via tmux capture-pane
	const idleWatchdog = new RunnerIdleWatchdog({
		pollIntervalMs: 30_000,
		waitingThresholdCycles: 2,
		projects,
		store,
		runtimeRegistry: registry,
		captureSessionFn: defaultCaptureSession,
		chatThreadsEnabled: config.chatThreadsEnabled,
	});
	idleWatchdog.start();
	console.log("[Bridge] RunnerIdleWatchdog started (30s poll)");

	const close = async () => {
		heartbeatService?.stop();
		cleanupService?.stop();
		gatePoller.stop();
		idleWatchdog.stop();
		// FLY-50: Clean up dispatchers. If retryDispatcher and internalDispatcher
		// are the same instance, only tear down once. If they differ (caller
		// injected retryDispatcher but not startDispatcher), tear down both.
		if (retryDispatcher) {
			retryDispatcher.stopAccepting();
			await retryDispatcher.drain();
			await retryDispatcher.teardownRuntimes();
		}
		if (internalDispatcher && internalDispatcher !== retryDispatcher) {
			internalDispatcher.stopAccepting();
			await internalDispatcher.drain();
			await internalDispatcher.teardownRuntimes();
		}
		if (runtimeRetryTimer) clearInterval(runtimeRetryTimer);
		await registry.shutdownAll();
		broadcaster.destroy();
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	};

	return { app, store, close, registry };
}
