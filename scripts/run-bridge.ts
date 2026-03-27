#!/usr/bin/env npx tsx

/**
 * GEO-168: Bridge daemon with retry capability.
 * GEO-267: Extended with RunDispatcher (start + retry) and RuntimeRegistry injection.
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
import { RuntimeRegistry } from "../packages/teamlead/dist/bridge/runtime-registry.js";
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

	// Phase 2: Create RuntimeRegistry first (GEO-267)
	// Passed to setupRetryRuntime for DirectEventSink injection,
	// and to startBridge where Lead runtimes get registered into it.
	const registry = new RuntimeRegistry();

	// Phase 3: Build per-project run/retry runtime (GEO-267: RunDispatcher)
	const runDispatcher = await setupRetryRuntime(
		store,
		config,
		projects,
		registry,
	);
	console.log(
		`[run-bridge] RunDispatcher ready (maxConcurrent: ${config.maxConcurrentRunners})`,
	);

	// Phase 4: Memory service (GEO-198) — advisory, bridge starts without it
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

	// Phase 5: Start bridge with injected store + dispatchers + registry + memory
	const { close } = await startBridge(config, projects, {
		store,
		retryDispatcher: runDispatcher,
		startDispatcher: runDispatcher,
		memoryService,
		registry,
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
