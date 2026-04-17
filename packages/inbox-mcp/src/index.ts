#!/usr/bin/env node
/**
 * Flywheel Inbox MCP Server — CommDB → Lead channel push delivery.
 *
 * Polls CommDB for unread instructions addressed to this Lead and delivers
 * them via `notifications/claude/channel`. PID-based lease file signals
 * readiness to Bridge's runtime selector.
 *
 * FLY-47: replaces Discord control channel for Bridge→Lead communication.
 * FLY-109: at-least-once semantics via delivered_at + explicit model-triggered
 * flywheel_inbox_ack tool. Lease is written AFTER server.connect() so Bridge
 * never sees a "ready" signal while the MCP transport is still half-wired.
 */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CommDB } from "flywheel-comm/db";
import { z } from "zod";
import {
	type DeliveryMessage,
	handleAck,
	processPendingDeliveries,
} from "./delivery.js";

// ── Required env vars (injected by claude-lead.sh) ──

const commDbPath = process.env.FLYWHEEL_COMM_DB;
const leadId = process.env.FLYWHEEL_LEAD_ID;
const projectName = process.env.FLYWHEEL_PROJECT_NAME;

if (!commDbPath) {
	process.stderr.write("FLYWHEEL_COMM_DB is required\n");
	process.exit(1);
}
if (!leadId) {
	process.stderr.write("FLYWHEEL_LEAD_ID is required\n");
	process.exit(1);
}

// Retry window: how long after a delivery before we re-push an unacked message.
// Default 30s balances "don't spam on ack latency" vs "don't wait too long on drop".
const RETRY_WINDOW_SEC = Number.parseInt(
	process.env.FLYWHEEL_INBOX_RETRY_WINDOW_SEC ?? "30",
	10,
);
if (!Number.isFinite(RETRY_WINDOW_SEC) || RETRY_WINDOW_SEC <= 0) {
	process.stderr.write(
		`FLYWHEEL_INBOX_RETRY_WINDOW_SEC must be a positive integer (got: ${process.env.FLYWHEEL_INBOX_RETRY_WINDOW_SEC})\n`,
	);
	process.exit(1);
}

// ── Lease file path ──

const leaseDir = projectName
	? join(homedir(), ".flywheel", "comm", projectName)
	: dirname(commDbPath);
const leasePath = join(leaseDir, `.inbox-ready-${leadId}`);

// ── DB ──

let commDb: CommDB;

function openDb(): void {
	// CommDB constructor creates the DB + schema if missing, sets WAL + busy_timeout
	commDb = new CommDB(commDbPath!);
}

// ── Lease management ──

function writeLease(): void {
	mkdirSync(leaseDir, { recursive: true });
	writeFileSync(
		leasePath,
		JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
	);
}

function deleteLease(): void {
	try {
		unlinkSync(leasePath);
	} catch {
		// Already deleted or never written — fine
	}
}

// ── MCP Server ──

const server = new McpServer(
	{
		name: "flywheel-inbox",
		version: "0.2.0",
	},
	{
		capabilities: {
			experimental: {
				"claude/channel": {},
			},
		},
	},
);

// Tool: flywheel_inbox_ack — called by the Lead model after it has processed
// an inbox message. This is the at-least-once ack; without it the message will
// be redelivered after RETRY_WINDOW_SEC.
server.tool(
	"flywheel_inbox_ack",
	"Acknowledge a processed inbox message by its message_id. Call this exactly once per channel message you receive (the message_id is in the notification's meta field). Idempotent — repeat calls are safe.",
	{
		message_id: z
			.string()
			.describe("The message_id from the channel notification's meta field"),
	},
	async ({ message_id }) => {
		const result = handleAck(commDb, message_id, leadId!);
		if (result.ok) {
			return {
				content: [
					{ type: "text" as const, text: `acked: ${message_id}` },
				],
			};
		}
		return {
			content: [{ type: "text" as const, text: `Error: ${result.error}` }],
			isError: true,
		};
	},
);

// ── Poll loop ──

const POLL_INTERVAL_MS = 1000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function pollOnce(): Promise<void> {
	try {
		await processPendingDeliveries(
			commDb,
			leadId!,
			RETRY_WINDOW_SEC,
			async (msg: DeliveryMessage) => {
				await server.server.notification({
					method: "notifications/claude/channel",
					params: {
						content: msg.content,
						meta: {
							from: msg.from_agent,
							message_id: msg.id,
						},
					},
				});
			},
		);
	} catch (err) {
		process.stderr.write(
			`[inbox-mcp] Poll error: ${(err as Error).message}\n`,
		);
	}
}

// ── Startup ──

async function main(): Promise<void> {
	// Clean up any stale lease from a previous run
	deleteLease();

	// Open DB and verify access
	try {
		openDb();
	} catch (err) {
		process.stderr.write(
			`[inbox-mcp] Failed to open CommDB at ${commDbPath}: ${(err as Error).message}\n`,
		);
		process.exit(1);
	}

	// Connect MCP transport FIRST — only after this returns is the server wired
	// up to handle notifications and tool calls. FLY-109: lease goes AFTER this.
	const transport = new StdioServerTransport();
	await server.connect(transport);

	// Start polling after MCP connection is established
	pollTimer = setInterval(() => {
		pollOnce().catch((err) => {
			process.stderr.write(
				`[inbox-mcp] Poll error: ${(err as Error).message}\n`,
			);
		});
	}, POLL_INTERVAL_MS);

	// Write PID lease LAST — by this point transport is connected and poll loop
	// is running, so Bridge seeing the lease means we can actually deliver.
	// The remaining race (client-side handler not yet registered) is absorbed
	// by the ack/retry machinery in RETRY_WINDOW_SEC.
	writeLease();

	// Shutdown handler
	const shutdown = () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		deleteLease();
		try {
			commDb?.close();
		} catch {
			// Ignore close errors during shutdown
		}
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	process.stderr.write(
		`[inbox-mcp] Ready — polling for ${leadId} from ${commDbPath} (retry window ${RETRY_WINDOW_SEC}s)\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`[inbox-mcp] Fatal: ${(err as Error).message}\n`);
	deleteLease();
	process.exit(1);
});
