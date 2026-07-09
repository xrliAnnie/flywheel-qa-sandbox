/**
 * FLY-967 staged E2E — ISOLATED Bridge (Tadashi ②: never touch prod).
 *
 * A minimal Bridge instance (same assembly as the route unit tests, but with
 * the REAL LINEAR_API_KEY) serving only what /gemini needs: the Linear
 * proxies with a staged projects.json that carries the flywheel linear
 * binding. In-memory StateStore, own port, own bearer token — zero contact
 * with the production Bridge, its DB, or its config.
 *
 *   env: LINEAR_API_KEY, FLYWHEEL_API_TOKEN (staged bearer),
 *        STAGED_BRIDGE_PORT (default 9877),
 *        STAGED_PROJECTS (default ~/.flywheel/qa-fly967-staged/projects.staged.json)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBridgeApp } from "../../teamlead/dist/bridge/plugin.js";
import { RunnerAdmissionController } from "../../teamlead/dist/bridge/runner-admission.js";
import { StateStore } from "../../teamlead/dist/StateStore.js";

const need = (k) => {
	const v = process.env[k];
	if (!v) {
		console.error(`missing env ${k}`);
		process.exit(2);
	}
	return v;
};

const port = Number(process.env.STAGED_BRIDGE_PORT ?? 9877);
const projectsPath =
	process.env.STAGED_PROJECTS ??
	join(homedir(), ".flywheel", "qa-fly967-staged", "projects.staged.json");
const projects = JSON.parse(readFileSync(projectsPath, "utf-8"));

const store = await StateStore.create(":memory:");
const app = createBridgeApp(store, projects, {
	host: "127.0.0.1",
	port,
	dbPath: ":memory:",
	notificationChannel: "staged",
	defaultLeadAgentId: "eng",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
	runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
	apiToken: need("FLYWHEEL_API_TOKEN"),
	linearApiKey: need("LINEAR_API_KEY"),
});
const server = app.listen(port, "127.0.0.1", () => {
	console.log(`[staged-bridge] up on 127.0.0.1:${port} (isolated, in-memory)`);
});

const shutdown = () => {
	server.close(() => {
		store.close();
		process.exit(0);
	});
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
