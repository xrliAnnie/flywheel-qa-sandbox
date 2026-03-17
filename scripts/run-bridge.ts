#!/usr/bin/env npx tsx

/**
 * GEO-168: Bridge daemon with retry capability.
 *
 * Replaces packages/teamlead/src/index.ts as the primary bridge entry point
 * when retry re-dispatch is needed. The old index.ts continues to work as
 * a minimal daemon without retry.
 *
 * Usage:
 *   npx tsx scripts/run-bridge.ts
 *
 * Environment:
 *   Same as packages/teamlead/src/index.ts, plus:
 *   - ANTHROPIC_API_KEY (for Decision Layer in retry Blueprint)
 *   - GOOGLE_API_KEY + SUPABASE_URL + SUPABASE_KEY (optional, for memory)
 */

import { startBridge } from "../packages/teamlead/dist/bridge/plugin.js";
import { loadConfig } from "../packages/teamlead/dist/config.js";
import { loadProjects } from "../packages/teamlead/dist/ProjectConfig.js";
import { StateStore } from "../packages/teamlead/dist/StateStore.js";
import { setupRetryRuntime } from "./lib/retry-runtime.js";

async function main() {
	const config = loadConfig();
	const projects = loadProjects();
	if (projects.length === 0) {
		throw new Error(
			"No projects configured — check FLYWHEEL_PROJECTS or project config",
		);
	}

	console.log(`[run-bridge] Starting with ${projects.length} project(s)...`);

	// Phase 1: Create store (before bridge startup)
	const store = await StateStore.create(config.dbPath);
	console.log(`[run-bridge] StateStore initialized: ${config.dbPath}`);

	// Phase 2: Build per-project retry runtime
	const retryDispatcher = await setupRetryRuntime(store, config, projects);
	console.log("[run-bridge] RetryDispatcher ready");

	// Phase 3: Start bridge with injected store + dispatcher
	const { close } = await startBridge(config, projects, {
		store,
		retryDispatcher,
	});

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log("[run-bridge] Shutting down...");
		await close(); // drain() + teardown happens inside
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("[run-bridge] Fatal:", err);
	process.exit(1);
});
