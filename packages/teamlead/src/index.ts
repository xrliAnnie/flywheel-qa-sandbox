#!/usr/bin/env node

import { join } from "node:path";
import { homedir } from "node:os";
import { CipherWriter } from "flywheel-edge-worker";
import { loadConfig } from "./config.js";
import { loadProjects } from "./ProjectConfig.js";
import { startBridge } from "./bridge/plugin.js";
import { buildHookBody } from "./bridge/hook-payload.js";
import { notifyAgent } from "./bridge/event-route.js";
import type { HookPayload } from "./bridge/hook-payload.js";

async function main() {
	const config = loadConfig();
	const projects = loadProjects();
	if (projects.length === 0) {
		throw new Error("No projects configured — check FLYWHEEL_PROJECTS or project config");
	}

	// CIPHER: create writer + inject notification callback
	const cipherWriter = await CipherWriter.create(
		join(homedir(), ".flywheel", "cipher.db"),
	);
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

	const { close } = await startBridge(config, projects, cipherWriter);

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
