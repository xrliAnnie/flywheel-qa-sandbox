#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import {
	CipherSyncService,
	CipherWriter,
	createMemoryService,
	type MemoryService,
} from "flywheel-edge-worker";
import { EventFilter } from "./bridge/EventFilter.js";
import type { HookPayload } from "./bridge/hook-payload.js";
import type { LeadEventEnvelope } from "./bridge/lead-runtime.js";
import { startBridge } from "./bridge/plugin.js";
import { loadConfig } from "./config.js";
import { loadProjects } from "./ProjectConfig.js";

async function main() {
	const config = loadConfig();
	const projects = loadProjects();
	if (projects.length === 0) {
		throw new Error(
			"No projects configured — check FLYWHEEL_PROJECTS or project config",
		);
	}

	// CIPHER: create writer + inject notification callback (advisory — bridge starts without it)
	let cipherWriter: CipherWriter | undefined;
	try {
		cipherWriter = await CipherWriter.create(
			join(homedir(), ".flywheel", "cipher.db"),
		);
		// Wire Supabase sync (advisory — runs after dreaming, env vars optional)
		const supabaseUrl = process.env.SUPABASE_URL;
		const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
		if (supabaseUrl && supabaseKey) {
			const syncService = new CipherSyncService({ supabaseUrl, supabaseKey });
			cipherWriter.setSyncAfterDreaming(async (db) => {
				await syncService.syncAll(db);
			});
			console.log("[CIPHER] Supabase sync enabled");
		}

		// CIPHER notifyFn is wired after startBridge returns the registry (GEO-195)
	} catch (err) {
		console.warn(
			"[CIPHER] Failed to initialize — running without CIPHER:",
			(err as Error).message,
		);
	}

	// Memory service (GEO-198) — advisory, bridge starts without it
	let memoryService: MemoryService | undefined;
	try {
		memoryService = await createMemoryService({
			googleApiKey: process.env.GOOGLE_API_KEY,
			supabaseUrl: process.env.SUPABASE_URL,
			supabaseKey: process.env.SUPABASE_KEY,
			projectName: "bridge",
			llmModel: process.env.FLYWHEEL_MEMORY_MODEL,
		});
		if (memoryService)
			console.log("[Memory] Service enabled (Supabase pgvector)");
	} catch (err) {
		console.warn("[Memory] Failed to initialize:", (err as Error).message);
	}

	const { close, registry, store } = await startBridge(config, projects, {
		cipherWriter,
		memoryService,
	});

	// Wire CIPHER notification via RuntimeRegistry (GEO-195)
	if (cipherWriter && registry) {
		const cipherEventFilter = new EventFilter();
		cipherWriter.setNotifyFn(async (proposal) => {
			const hookPayload: HookPayload = {
				...proposal,
				execution_id: "",
				issue_id: "",
				project_name: "",
				status: "pending_ceo",
			};

			// FLY-47: Annotate priority (always deliver to Lead)
			const filterResult = cipherEventFilter.classify(
				"cipher_principle_proposed",
				hookPayload,
			);
			hookPayload.filter_priority = filterResult.priority;
			hookPayload.notification_context = filterResult.reason;

			const runtime = registry.getForLead(config.defaultLeadAgentId);
			if (!runtime) return;

			const sessionKey = `cipher-proposal-${proposal.cipher_principle_id}`;
			const eventId = `cipher-${proposal.cipher_principle_id}-${Date.now()}`;
			const seq = store.appendLeadEvent(
				config.defaultLeadAgentId,
				eventId,
				"cipher_principle_proposed",
				JSON.stringify(hookPayload),
				sessionKey,
			);
			const envelope: LeadEventEnvelope = {
				seq,
				event: hookPayload,
				sessionKey,
				leadId: config.defaultLeadAgentId,
				timestamp: new Date().toISOString(),
			};
			runtime
				.deliver(envelope)
				.then(() => store.markLeadEventDelivered(seq))
				.catch(() => {});
		});
	}

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
