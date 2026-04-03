#!/usr/bin/env npx tsx

/**
 * Bridge daemon entry point.
 *
 * FLY-50: Simplified — RunDispatcher is now created internally by startBridge
 * via setupRunInfrastructure (packages/teamlead), eliminating the duplicated
 * glue code that previously lived in scripts/lib/.
 *
 * Usage:
 *   npx tsx scripts/run-bridge.ts
 *
 * Environment:
 *   Same as packages/teamlead/src/index.ts, plus:
 *   - ANTHROPIC_API_KEY (for Decision Layer in retry Blueprint)
 *   - GOOGLE_API_KEY + SUPABASE_URL + SUPABASE_KEY (optional, for memory)
 *   - LINEAR_API_KEY (required for start API — issue hydration)
 *   - TEAMLEAD_MAX_CONCURRENT_RUNNERS (default 3)
 */

import { createMemoryService } from "../packages/edge-worker/dist/memory/index.js";
import { startBridge } from "../packages/teamlead/dist/bridge/plugin.js";
import { loadConfig } from "../packages/teamlead/dist/config.js";
import { loadProjects } from "../packages/teamlead/dist/ProjectConfig.js";
import { StateStore } from "../packages/teamlead/dist/StateStore.js";

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

	// Phase 2: Memory service (GEO-198) — advisory, bridge starts without it
	let memoryService: Awaited<ReturnType<typeof createMemoryService>>;
	try {
		memoryService = await createMemoryService({
			googleApiKey: process.env.GOOGLE_API_KEY,
			supabaseUrl: process.env.SUPABASE_URL,
			supabaseKey: process.env.SUPABASE_KEY,
			projectName: "bridge",
			llmModel: process.env.FLYWHEEL_MEMORY_MODEL,
		});
		if (memoryService) console.log("[run-bridge] Memory service enabled");
	} catch (err) {
		console.warn("[run-bridge] Memory init failed:", (err as Error).message);
	}

	// Phase 3: Start bridge — RunDispatcher + RuntimeRegistry created internally
	const { close } = await startBridge(config, projects, {
		store,
		memoryService,
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
