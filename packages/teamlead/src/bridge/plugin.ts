import { timingSafeEqual } from "node:crypto";
import express from "express";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { CleanupService, FetchDiscordClient } from "../CleanupService.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import {
	type HeartbeatNotifier,
	HeartbeatService,
	WebhookHeartbeatNotifier,
} from "../HeartbeatService.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import type { CipherWriter } from "flywheel-edge-worker";
import { createActionRouter } from "./actions.js";
import { buildDashboardPayload } from "./dashboard-data.js";
import { getDashboardHtml } from "./dashboard-html.js";
import { EventFilter } from "./EventFilter.js";
import { createEventRouter } from "./event-route.js";
import { ForumTagUpdater } from "./ForumTagUpdater.js";
import type { IRetryDispatcher } from "./retry-dispatcher.js";
import { createQueryRouter } from "./tools.js";
import type { BridgeConfig } from "./types.js";

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
		),
	);

	// /events — ingest auth
	app.use(
		"/events",
		tokenAuthMiddleware(config.ingestToken),
		createEventRouter(store, projects, config, cipherWriter, transitionOpts, eventFilter, forumTagUpdater),
	);

	// /api/* — api auth
	app.use(
		"/api",
		tokenAuthMiddleware(config.apiToken),
		createQueryRouter(store, retryDispatcher),
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
		),
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
		app.post("/api/cipher-principle", tokenAuthMiddleware(config.apiToken), async (req, res) => {
			const { principleId, action } = req.body as { principleId?: string; action?: string };
			if (!principleId || !action || !["activate", "retire"].includes(action)) {
				res.status(400).json({ error: "missing principleId or invalid action" });
				return;
			}
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principleId)) {
				res.status(400).json({ error: "invalid principleId format" });
				return;
			}
			try {
				const updated = action === "activate"
					? await cipherWriter.activatePrinciple(principleId)
					: await cipherWriter.retirePrinciple(principleId, "CEO retired");
				if (!updated) {
					res.status(404).json({ error: "principle not found or not in expected state" });
					return;
				}
				// Principles are loaded into DecisionLayer HardRules once at process start
				// (setup.ts). A running worker reuses the same DecisionLayer for its entire
				// DAG batch. This change takes effect on the next process/DAG start.
				res.json({ ok: true, effective: "next_process_start" });
			} catch {
				res.status(500).json({ error: "principle action failed" });
			}
		});
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
			const { title, description, priority, labels } = req.body ?? {};
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
			if (priority !== undefined && (typeof priority !== "number" || priority < 0 || priority > 4)) {
				res.status(400).json({ error: "priority must be 0-4" });
				return;
			}
			if (labels !== undefined && (!Array.isArray(labels) || !labels.every((l: unknown) => typeof l === "string"))) {
				res.status(400).json({ error: "labels must be a string array" });
				return;
			}
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ apiKey: config.linearApiKey });
				const teams = await client.teams();
				const team = teams.nodes[0];
				if (!team) {
					res.status(500).json({ error: "No Linear team found" });
					return;
				}
				const issue = await client.createIssue({
					teamId: team.id,
					title,
					description: description ?? "",
					priority: priority ?? 0,
					labelIds: labels,
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
				console.error("[linear-proxy] create-issue failed:", (err as Error).message);
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
			if (priority !== undefined && (typeof priority !== "number" || priority < 0 || priority > 4)) {
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
						if (state) update.stateId = state.id;
					}
				}
				await client.updateIssue(issueId, update);
				res.json({ ok: true });
			} catch (err) {
				console.error("[linear-proxy] update-issue failed:", (err as Error).message);
				res.status(502).json({ error: "Linear API error" });
			}
		},
	);

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
		cipherWriter?: CipherWriter;
		statusTagMap?: Record<string, string[]>;
	},
): Promise<{
	app: express.Application;
	store: StateStore;
	close: () => Promise<void>;
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

	// GEO-187: EventFilter + ForumTagUpdater
	const eventFilter = new EventFilter();
	const statusTagMap = opts?.statusTagMap ?? {};
	const forumTagUpdater = new ForumTagUpdater(statusTagMap);

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
	);

	const server = app.listen(config.port, config.host);

	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});

	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : config.port;
	console.log(`[Bridge] Listening on ${config.host}:${port}`);

	// Always start HeartbeatService — orphan reaping is critical even without gateway.
	// If no gateway hooks configured, use a no-op notifier (reaping still works, just no Slack).
	const notifier: HeartbeatNotifier =
		config.gatewayUrl && config.hooksToken
			? new WebhookHeartbeatNotifier(
					config.gatewayUrl,
					config.hooksToken,
					config.notificationChannel,
					eventFilter,
				)
			: { onSessionStuck: async () => {}, onSessionOrphaned: async () => {} };
	const heartbeatService = new HeartbeatService(
		store,
		notifier,
		config.stuckThresholdMinutes,
		config.stuckCheckIntervalMs,
		config.orphanThresholdMinutes,
		transitionOpts,
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
		broadcaster.destroy();
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	};

	return { app, store, close };
}
