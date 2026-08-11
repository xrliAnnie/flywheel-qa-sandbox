#!/usr/bin/env node
/**
 * FLY-1573 deploy probe: start both production MCP entries over real stdio and
 * prove that each advertises its batch-ACK tool before the queue barrier opens.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const inboxEntry = fileURLToPath(
	new URL("../../../inbox-mcp/dist/index.js", import.meta.url),
);
const leadActionsEntry = fileURLToPath(
	new URL(
		"../lead-backends/codex/lead-actions/lead-actions-main.js",
		import.meta.url,
	),
);

async function listTools(
	entry: string,
	env: Record<string, string>,
): Promise<string[]> {
	if (!existsSync(entry)) throw new Error(`MCP entry missing: ${entry}`);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [entry],
		env,
		stderr: "pipe",
	});
	const client = new Client({
		name: "mailbox-queue-deploy-probe",
		version: "1",
	});
	await client.connect(transport);
	try {
		return (await client.listTools()).tools.map((tool) => tool.name);
	} finally {
		await client.close().catch(() => {});
	}
}

const dir = mkdtempSync(join(tmpdir(), "mailbox-queue-ack-probe-"));
try {
	const common = {
		FLYWHEEL_LEAD_ID: "mailbox-queue-probe-lead",
		FLYWHEEL_PROJECT_NAME: "flywheel",
		FLYWHEEL_COMM_DB: join(dir, "comm.db"),
	};
	const claudeTools = await listTools(inboxEntry, common);
	if (!claudeTools.includes("flywheel_inbox_ack_batch")) {
		throw new Error(
			`Claude inbox MCP lacks flywheel_inbox_ack_batch: ${claudeTools.join(",")}`,
		);
	}
	const codexTools = await listTools(leadActionsEntry, {
		...common,
		// Tool inventory only: preserve production's fail-closed credential
		// contract without granting this probe a live Discord credential.
		DISCORD_BOT_TOKEN: "mailbox-queue-readiness-probe-not-live",
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "0",
		FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "",
		FLYWHEEL_LEAD_ACTIONS_STATE_DIR: join(dir, "lead-actions"),
	});
	if (
		codexTools.length !== 2 ||
		codexTools[0] !== "discord_send" ||
		codexTools[1] !== "ack_batch"
	) {
		throw new Error(
			`Codex lead_actions tool surface mismatch: ${codexTools.join(",")}`,
		);
	}
	process.stdout.write(
		`${JSON.stringify({ ok: true, claude: "flywheel_inbox_ack_batch", codex: "ack_batch" })}\n`,
	);
} catch (err) {
	process.stderr.write(
		`mailbox queue ACK readiness failed: ${(err as Error).message}\n`,
	);
	process.exitCode = 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
