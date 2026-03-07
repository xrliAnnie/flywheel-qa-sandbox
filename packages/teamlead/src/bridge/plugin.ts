import express from "express";
import { timingSafeEqual } from "node:crypto";
import { StateStore } from "../StateStore.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { BridgeConfig } from "./types.js";
import { createQueryRouter } from "./tools.js";
import { createActionRouter } from "./actions.js";
import { createEventRouter } from "./event-route.js";

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

export function createBridgeApp(
	store: StateStore,
	projects: ProjectEntry[],
	config: BridgeConfig,
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

	// /events — ingest auth
	app.use("/events", tokenAuthMiddleware(config.ingestToken), createEventRouter(store, projects, config));

	// /api/* — api auth
	app.use("/api", tokenAuthMiddleware(config.apiToken), createQueryRouter(store));
	app.use("/api/actions", tokenAuthMiddleware(config.apiToken), createActionRouter(store, projects));

	// Catch-all 404
	app.use((_req, res) => {
		res.status(404).json({ error: "not found" });
	});

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
	const app = createBridgeApp(store, projects, config);

	const server = app.listen(config.port, config.host);

	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});

	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : config.port;
	console.log(`[Bridge] Listening on ${config.host}:${port}`);

	const close = async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	};

	return { app, store, close };
}
