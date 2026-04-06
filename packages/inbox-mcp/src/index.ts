#!/usr/bin/env node
/**
 * Flywheel Inbox MCP Server — CommDB → Lead channel push delivery.
 *
 * Polls CommDB for unread instructions addressed to this Lead and delivers
 * them via `notifications/claude/channel`. PID-based lease file signals
 * readiness to Bridge's runtime selector.
 *
 * FLY-47: replaces Discord control channel for Bridge→Lead communication.
 */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";

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

// ── Lease file path ──

const leaseDir = projectName
	? join(homedir(), ".flywheel", "comm", projectName)
	: dirname(commDbPath);
const leasePath = join(leaseDir, `.inbox-ready-${leadId}`);

// ── DB queries (prepared once) ──

interface MessageRow {
	id: string;
	from_agent: string;
	content: string;
	created_at: string;
}

let commDb: CommDB;
let stmtUnread: Database.Statement;
let stmtMarkRead: Database.Statement;

function openDb(): void {
	// CommDB constructor creates the DB + schema if missing, sets WAL + busy_timeout
	commDb = new CommDB(commDbPath!);

	// Prepared statements on the underlying DB handle
	const rawDb = (commDb as unknown as { db: Database.Database }).db;
	stmtUnread = rawDb.prepare(
		`SELECT id, from_agent, content, created_at FROM messages
     WHERE to_agent = ? AND type = 'instruction' AND read_at IS NULL
     AND expires_at > datetime('now')
     ORDER BY created_at ASC`,
	);
	stmtMarkRead = rawDb.prepare(
		"UPDATE messages SET read_at = datetime('now') WHERE id = ?",
	);
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
		version: "0.1.0",
	},
	{
		capabilities: {
			experimental: {
				"claude/channel": {},
			},
		},
	},
);

// ── Poll loop ──

const POLL_INTERVAL_MS = 1000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function pollOnce(): Promise<void> {
	let messages: MessageRow[];
	try {
		messages = stmtUnread.all(leadId) as MessageRow[];
	} catch (err) {
		process.stderr.write(
			`[inbox-mcp] DB read error: ${(err as Error).message}\n`,
		);
		return;
	}

	for (const msg of messages) {
		try {
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
			// Only mark read after successful notification send
			stmtMarkRead.run(msg.id);
		} catch (err) {
			// Channel notification failed — message stays unread, retry next cycle
			process.stderr.write(
				`[inbox-mcp] Notification failed for ${msg.id}: ${(err as Error).message}\n`,
			);
			break; // Stop processing this batch to preserve ordering
		}
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

	// Write PID lease — signals readiness to Bridge
	writeLease();

	// Connect MCP transport
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
		`[inbox-mcp] Ready — polling for ${leadId} from ${commDbPath}\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`[inbox-mcp] Fatal: ${(err as Error).message}\n`);
	deleteLease();
	process.exit(1);
});
