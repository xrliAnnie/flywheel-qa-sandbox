import { timingSafeEqual } from "node:crypto";
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
import { StateStore } from "../StateStore.js";
import { createActionRouter } from "./actions.js";
import { postMergeCleanup } from "./post-merge.js";
import { buildDashboardPayload } from "./dashboard-data.js";
import { getDashboardHtml } from "./dashboard-html.js";
import { EventFilter } from "./EventFilter.js";
import { createEventRouter } from "./event-route.js";
import { ForumPostCreator } from "./ForumPostCreator.js";
import { ForumTagUpdater } from "./ForumTagUpdater.js";
import type { LeadRuntime } from "./lead-runtime.js";
import { createMemoryRouter } from "./memory-route.js";
import { OpenClawRuntime } from "./openclaw-runtime.js";
import type { IRetryDispatcher, IStartDispatcher } from "./retry-dispatcher.js";
import { createRunsRouter } from "./runs-route.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { matchesLead, parseSessionLabels } from "./lead-scope.js";
import { captureSession as defaultCaptureSession } from "./session-capture.js";
import {
	getTmuxTargetFromCommDb,
	isTmuxSessionAlive,
	killTmuxSession,
} from "./tmux-lookup.js";
import { type CaptureSessionFn, createQueryRouter } from "./tools.js";
import type { BridgeConfig } from "./types.js";

/** Create the appropriate LeadRuntime for a lead config. */
export async function createLeadRuntime(
	lead: LeadConfig,
	config: BridgeConfig,
): Promise<LeadRuntime> {
	if (lead.runtime === "claude-discord") {
		if (!lead.controlChannel) {
			throw new Error(
				`Lead "${lead.agentId}" has runtime=claude-discord but missing controlChannel`,
			);
		}
		// GEO-252: use per-lead botToken, fall back to global DISCORD_BOT_TOKEN
		const token = lead.botToken ?? config.discordBotToken;
		if (!token) {
			throw new Error(
				`Lead "${lead.agentId}" has runtime=claude-discord but no botToken (botTokenEnv=${lead.botTokenEnv ?? "unset"}) and DISCORD_BOT_TOKEN is not set`,
			);
		}
		const { ClaudeDiscordRuntime } = await import(
			"./claude-discord-runtime.js"
		);
		return new ClaudeDiscordRuntime(lead.controlChannel, token);
	}
	if (!config.gatewayUrl || !config.hooksToken) {
		throw new Error(
			`Lead "${lead.agentId}" uses openclaw runtime but OPENCLAW_GATEWAY_URL or OPENCLAW_HOOKS_TOKEN is not set`,
		);
	}
	return new OpenClawRuntime(config.gatewayUrl, config.hooksToken);
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
	const onApproved = (executionId: string, session: { issue_id: string; project_name: string }) => {
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
		createQueryRouter(store, projects, retryDispatcher, captureSessionFn),
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

			// Only allow closing sessions in terminal states
			const terminalStates = new Set([
				"completed",
				"failed",
				"blocked",
				"approved",
				"terminated",
			]);
			if (!terminalStates.has(session.status)) {
				res.status(409).json({
					error: `Cannot close tmux for session in "${session.status}" state — only terminal states allowed`,
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

			const target = getTmuxTargetFromCommDb(
				executionId,
				session.project_name,
			);
			if (!target) {
				res.json({ closed: false, reason: "No tmux target found" });
				return;
			}

			const result = await killTmuxSession(target.sessionName);

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
						const fullSession = store.getSession(
							entry.execution_id,
						);
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

				// Send grouped summary to each Lead's chatChannel
				for (const [leadId, group] of byLead) {
					const { lead, sessions: leadSessions } = group;
					const token =
						lead.botToken ?? config.discordBotToken;
					if (!token || !lead.chatChannel) {
						notifications.push({
							leadId,
							chatChannel: lead.chatChannel ?? "(none)",
							sessionCount: leadSessions.length,
							sent: false,
							error: "No bot token or chatChannel",
						});
						continue;
					}

					// Build summary message
					const lines = [
						"🔍 **Stale Session Patrol**",
						"",
						`你名下有 **${leadSessions.length}** 个 session 已完成但 tmux 仍然开着：`,
						"",
					];
					for (let i = 0; i < leadSessions.length; i++) {
						const s = leadSessions[i]!;
						const id =
							s.issue_identifier ?? s.execution_id;
						const title = s.issue_title
							? ` — ${s.issue_title}`
							: "";
						lines.push(
							`${i + 1}. **${id}**${title}`,
						);
						lines.push(
							`   状态: ${s.status} | ${s.hours_since_activity}h ago`,
						);
					}
					lines.push("");
					lines.push(
						"请检查并处理。处理完后请回报结果。",
					);

					const content = lines.join("\n");

					// Send to Discord chatChannel
					const controller = new AbortController();
					const timeout = setTimeout(
						() => controller.abort(),
						5000,
					);
					try {
						const discordRes = await fetch(
							`https://discord.com/api/v10/channels/${lead.chatChannel}/messages`,
							{
								method: "POST",
								headers: {
									Authorization: `Bot ${token}`,
									"Content-Type": "application/json",
								},
								body: JSON.stringify({ content }),
								signal: controller.signal,
							},
						);
						if (!discordRes.ok) {
							const body = await discordRes
								.text()
								.catch(() => "");
							notifications.push({
								leadId,
								chatChannel: lead.chatChannel,
								sessionCount: leadSessions.length,
								sent: false,
								error: `Discord ${discordRes.status}: ${body}`,
							});
						} else {
							notifications.push({
								leadId,
								chatChannel: lead.chatChannel,
								sessionCount: leadSessions.length,
								sent: true,
							});
						}
					} catch (err) {
						notifications.push({
							leadId,
							chatChannel: lead.chatChannel,
							sessionCount: leadSessions.length,
							sent: false,
							error: (err as Error).message,
						});
					} finally {
						clearTimeout(timeout);
					}
				}
			}

			res.json({
				threshold_hours: threshold,
				total: results.length,
				tmux_alive: alive.length,
				tmux_dead: results.length - alive.length,
				sessions: results,
				...(notify
					? { notifications }
					: {}),
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
				res
					.status(400)
					.json({
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
				let targetTeam;
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
						res
							.status(404)
							.json({
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

	// Linear query proxy — list issues with filters (GEO-276)
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

			// Build Linear GraphQL filter
			const filter: Record<string, unknown> = {};
			if (project) {
				filter.project = { name: { eq: project } };
			}
			if (stateParam) {
				const states = stateParam.split(",").map((s) => s.trim());
				if (states.length === 1) {
					filter.state = { type: { eq: states[0] } };
				} else {
					filter.state = { type: { in: states } };
				}
			}
			if (labelsParam) {
				const labels = labelsParam.split(",").map((l) => l.trim());
				if (labels.length === 1) {
					filter.labels = { name: { eq: labels[0] } };
				} else {
					filter.or = labels.map((name) => ({
						labels: { name: { eq: name } },
					}));
				}
			}

			const query = `
				query ListIssues($filter: IssueFilter, $first: Int) {
					issues(filter: $filter, first: $first, orderBy: updatedAt) {
						nodes {
							id
							identifier
							title
							description
							priority
							priorityLabel
							url
							createdAt
							updatedAt
							state { name type }
							labels { nodes { name } }
							assignee { name }
						}
						pageInfo { hasNextPage endCursor }
					}
				}
			`;

			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ apiKey: config.linearApiKey });
				const result = await client.client.rawRequest(query, {
					filter,
					first: limit,
				});

				const data = result.data as {
					issues: {
						nodes: Array<{
							id: string;
							identifier: string;
							title: string;
							description: string | null;
							priority: number;
							priorityLabel: string;
							url: string;
							createdAt: string;
							updatedAt: string;
							state: { name: string; type: string };
							labels: { nodes: Array<{ name: string }> };
							assignee: { name: string } | null;
						}>;
						pageInfo: { hasNextPage: boolean; endCursor: string | null };
					};
				};

				const nodes = data.issues.nodes;
				const issues = nodes.map((n) => ({
					id: n.id,
					identifier: n.identifier,
					title: n.title,
					description: n.description,
					priority: n.priority,
					priorityLabel: n.priorityLabel,
					state: n.state.name,
					stateType: n.state.type,
					labels: n.labels.nodes.map((l) => l.name),
					assignee: n.assignee?.name ?? null,
					url: n.url,
					createdAt: n.createdAt,
					updatedAt: n.updatedAt,
				}));

				res.json({
					issues,
					count: issues.length,
					truncated: data.issues.pageInfo.hasNextPage,
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
				const snapshot = await generateBootstrap(leadId, store, projects);
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
		);
		if (config.apiToken) {
			app.use("/api/runs", tokenAuthMiddleware(config.apiToken), runsRouter);
		} else {
			app.use("/api/runs", runsRouter);
		}
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
	const retryDispatcher = opts?.retryDispatcher;
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
				const runtime = await createLeadRuntime(lead, config);
				registry.register(lead, runtime);
			} catch (err) {
				// Non-fatal for openclaw leads without gateway (test/dev environments)
				if (lead.runtime === "claude-discord") throw err;
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
		opts?.startDispatcher,
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
			? new RegistryHeartbeatNotifier(registry, projects, store, eventFilter)
			: {
					onSessionStuck: async () => {},
					onSessionOrphaned: async () => {},
					onSessionStale: async () => {},
				};

	// GEO-270: Stale session patrol config (local variables, not in BridgeConfig)
	const staleThresholdHours = (() => {
		const v = parseInt(
			process.env.TEAMLEAD_STALE_THRESHOLD_HOURS ?? "24",
			10,
		);
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

	const close = async () => {
		heartbeatService?.stop();
		cleanupService?.stop();
		if (retryDispatcher) {
			retryDispatcher.stopAccepting();
			await retryDispatcher.drain();
			await retryDispatcher.teardownRuntimes();
		}
		await registry.shutdownAll();
		broadcaster.destroy();
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	};

	return { app, store, close, registry };
}
