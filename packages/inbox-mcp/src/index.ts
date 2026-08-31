#!/usr/bin/env node
/**
 * Flywheel Inbox MCP Server — durable Lead mailbox acknowledgements.
 *
 * PID-based lease file signals readiness to Bridge's runtime selector.
 *
 * FLY-47: replaces Discord control channel for Bridge→Lead communication.
 * Lease is written AFTER server.connect() so Bridge never sees a "ready"
 * signal while the MCP transport is still half-wired.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CommDB } from "flywheel-comm/db";
import { z } from "zod";
import {
	deleteLease as deleteChannelLease,
	writeLease as writeChannelLease,
} from "./channel-lease.js";
import { handleBatchAck, handleEventAck } from "./delivery.js";

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

// ── DB ──

let commDb: CommDB;

function openDb(): void {
	// CommDB constructor creates the DB + schema if missing, sets WAL + busy_timeout
	commDb = new CommDB(commDbPath!);
}

// ── Lease management ──
// The v1 wire shape is {pid, startedAt}.

function writeLease(): void {
	writeChannelLease(leasePath, { pid: process.pid });
}

function deleteLease(): void {
	deleteChannelLease(leasePath);
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

server.tool(
	"flywheel_inbox_ack_batch",
	"Acknowledge a durable mailbox batch after processing every message in it. Use the batch_id from the mailbox-batch header. Idempotent; a late acknowledgement is safely ignored by Bridge.",
	{
		batch_id: z.string().min(1).describe("The durable mailbox batch id"),
	},
	async ({ batch_id }) => {
		const result = handleBatchAck(commDb, {
			leadId: leadId!,
			batchId: batch_id,
		});
		return result.ok
			? {
					content: [
						{
							type: "text" as const,
							text: `batch ACK queued: ${result.batchId}`,
						},
					],
				}
			: {
					content: [{ type: "text" as const, text: `Error: ${result.error}` }],
					isError: true,
				};
	},
);

server.tool(
	"flywheel_inbox_ack_event",
	"Acknowledge a durable Flywheel Lead event. Use the event_seq, project, and token included in that event's ACK instructions.",
	{
		event_seq: z
			.number()
			.int()
			.positive()
			.describe("The global event sequence from the ACK instructions"),
		project: z.string().min(1).describe("The Flywheel project name"),
		token: z.string().min(1).describe("The per-event bearer ACK token"),
	},
	async ({ event_seq, project, token }) => {
		const result = handleEventAck(commDb, {
			leadId: leadId!,
			eventSeq: event_seq,
			ackToken: token,
			project,
			expectedProject: projectName,
		});
		if (result.ok) {
			return {
				content: [
					{
						type: "text" as const,
						text: `ACK receipt queued: event ${result.eventSeq}`,
					},
				],
			};
		}
		return {
			content: [{ type: "text" as const, text: `Error: ${result.error}` }],
			isError: true,
		};
	},
);

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

	// Write PID lease LAST — by this point transport is connected and tools are
	// registered, so Bridge seeing the lease means acknowledgements can be handled.
	writeLease();

	// Shutdown handler
	const shutdown = () => {
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
		`[inbox-mcp] Ready — acknowledgement tools for ${leadId} on ${commDbPath}\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`[inbox-mcp] Fatal: ${(err as Error).message}\n`);
	deleteLease();
	process.exit(1);
});
