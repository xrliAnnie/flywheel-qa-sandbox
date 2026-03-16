import express from "express";
import { timingSafeEqual } from "node:crypto";
import { WorkflowFSM, WORKFLOW_TRANSITIONS } from "flywheel-core";
import { StateStore } from "../StateStore.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { HeartbeatService, WebhookHeartbeatNotifier, type HeartbeatNotifier } from "../HeartbeatService.js";
import { CleanupService, FetchDiscordClient } from "../CleanupService.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { BridgeConfig } from "./types.js";
import { createQueryRouter } from "./tools.js";
import { createActionRouter } from "./actions.js";
import { createEventRouter } from "./event-route.js";
import { getDashboardHtml } from "./dashboard-html.js";
import { buildDashboardPayload } from "./dashboard-data.js";

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
			const payload = buildDashboardPayload(this.store, this.stuckThresholdMinutes);
			res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
		} catch (err) {
			console.error("[SseBroadcaster] Failed to send initial state:", (err as Error).message);
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
				if (code !== "ERR_STREAM_WRITE_AFTER_END" && code !== "ERR_STREAM_DESTROYED") {
					console.warn("[SseBroadcaster] Unexpected error during destroy:", (err as Error).message);
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
			try { client.write(data); } catch { dead.push(client); }
		}
		for (const d of dead) this.clients.delete(d);
	}

	private startPolling(): void {
		this.poller = setInterval(() => {
			try {
				const payload = buildDashboardPayload(this.store, this.stuckThresholdMinutes);
				const message = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
				this.broadcastToClients(message);
			} catch (err) {
				console.error("[SseBroadcaster] Failed to build/broadcast payload:", (err as Error).message);
			}
		}, 2000);
		this.heartbeat = setInterval(() => {
			this.broadcastToClients(": heartbeat\n\n");
		}, 30000);
	}

	private stopPolling(): void {
		if (this.poller) { clearInterval(this.poller); this.poller = null; }
		if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
	}
}

export function createBridgeApp(
	store: StateStore,
	projects: ProjectEntry[],
	config: BridgeConfig,
	broadcaster?: SseBroadcaster,
	transitionOpts?: ApplyTransitionOpts,
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
				console.warn("[SSE] No broadcaster configured — serving one-shot snapshot");
			}
			const payload = buildDashboardPayload(store, config.stuckThresholdMinutes);
			res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
			res.end();
		}
	});

	// Dashboard actions — no auth (loopback only, same handlers as /api/actions)
	app.use("/actions", createActionRouter(store, projects, transitionOpts, config));

	// /events — ingest auth
	app.use("/events", tokenAuthMiddleware(config.ingestToken), createEventRouter(store, projects, config, undefined, transitionOpts));

	// /api/* — api auth
	app.use("/api", tokenAuthMiddleware(config.apiToken), createQueryRouter(store));
	app.use("/api/actions", tokenAuthMiddleware(config.apiToken), createActionRouter(store, projects, transitionOpts, config));

	// Catch-all 404
	app.use((_req, res) => {
		res.status(404).json({ error: "not found" });
	});

	// JSON error handler — returns JSON instead of Express default HTML with stack trace
	app.use(((err: Error & { status?: number; type?: string }, _req, res, _next) => {
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
): Promise<{ app: express.Application; store: StateStore; close: () => Promise<void> }> {
	if (projects.length === 0) {
		throw new Error("No projects configured — check FLYWHEEL_PROJECTS or project config");
	}

	const store = await StateStore.create(config.dbPath);
	// GEO-158: FSM instance + DirectiveExecutor for validated transitions
	const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
	const executor = new DirectiveExecutor(store);
	const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
	const broadcaster = new SseBroadcaster(store, config.stuckThresholdMinutes);
	const app = createBridgeApp(store, projects, config, broadcaster, transitionOpts);

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
	const notifier: HeartbeatNotifier = (config.gatewayUrl && config.hooksToken)
		? new WebhookHeartbeatNotifier(config.gatewayUrl, config.hooksToken, config.notificationChannel)
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
		cleanupService = new CleanupService(store, dc, config.cleanupThresholdMinutes ?? 1440, config.cleanupIntervalMs ?? 3_600_000);
		cleanupService.start();
		console.log("[Bridge] CleanupService started");
	}

	const close = async () => {
		heartbeatService?.stop();
		cleanupService?.stop();
		broadcaster.destroy();
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	};

	return { app, store, close };
}
