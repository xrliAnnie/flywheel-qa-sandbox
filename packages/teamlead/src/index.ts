#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { CipherSyncService, CipherWriter } from "flywheel-edge-worker";
import { startBridge } from "./bridge/plugin.js";
import {
	buildHookBody,
	notifyAgent,
} from "./bridge/hook-payload.js";
import type { HookPayload } from "./bridge/hook-payload.js";
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

		cipherWriter.setNotifyFn(async (proposal) => {
			const hookPayload: HookPayload = {
				...proposal,
				execution_id: "",
				issue_id: "",
				project_name: "",
				status: "pending_ceo",
			};
			const sessionKey = `cipher-proposal-${proposal.cipher_principle_id}`;
			const body = buildHookBody("product-lead", hookPayload, sessionKey);
			if (config.gatewayUrl && config.hooksToken) {
				await notifyAgent(config.gatewayUrl, config.hooksToken, body);
			}
		});
	} catch (err) {
		console.warn("[CIPHER] Failed to initialize — running without CIPHER:", (err as Error).message);
	}

	const { close } = await startBridge(config, projects, { cipherWriter });

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
