#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { loadProjects } from "./ProjectConfig.js";
import { startBridge } from "./bridge/plugin.js";

async function main() {
	const config = loadConfig();
	const projects = loadProjects();
	if (projects.length === 0) {
		throw new Error("No projects configured — check FLYWHEEL_PROJECTS or project config");
	}
	const { close } = await startBridge(config, projects);

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log("[Bridge] Shutting down...");
		await close();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("[Bridge] Fatal:", err);
	process.exit(1);
});
