#!/usr/bin/env node
/**
 * FLY-1547 — the v2 mailbox service, faces 1+2 in one per-session process:
 *
 *  1. MCP tool face (send/next/settle/ask/status) over the v2 host socket —
 *     read receipts and the 读/办 two-chapter contract enforced here;
 *  2. Claude push face — `notifications/claude/channel` rings a pointer-only
 *     bell ("你有新信") when the mailbox high-water advances; content always
 *     travels through `next`.
 *
 * Health contract (§2.5): the lease at $FLYWHEEL_V2_MAILBOX_LEASE is touched
 * after every successful status poll; K consecutive failures or a rejected
 * channel notification → fail-stop (delete lease, exit) so the engine's
 * doorbell falls back to the pointer paste loudly instead of trusting a
 * live-but-broken child. Restart policy (frozen): ring once for whatever is
 * pending at startup — a duplicate bell is benign, a swallowed one is not.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	deleteLease,
	touchLease,
	writeLease,
} from "flywheel-inbox-mcp/channel-lease";
import { V2Client } from "flywheel-v2-cli";
import { z } from "zod";
import { initialBellState, runBellCycle } from "./bell.js";
import { createHostPort } from "./host-port.js";
import { resolveIdentity } from "./identity.js";
import { MailboxService } from "./service.js";

const socketPath = process.env.FLYWHEEL_V2_SOCKET;
const secretPath = process.env.FLYWHEEL_V2_SECRET_PATH;
const leasePath = process.env.FLYWHEEL_V2_MAILBOX_LEASE;
if (!socketPath || !secretPath) {
	process.stderr.write(
		"[mailbox-mcp] FLYWHEEL_V2_SOCKET and FLYWHEEL_V2_SECRET_PATH are required\n",
	);
	process.exit(1);
}

let identity: ReturnType<typeof resolveIdentity>;
try {
	identity = resolveIdentity(process.env);
} catch (error) {
	process.stderr.write(
		`[mailbox-mcp] ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exit(1);
}

const client = new V2Client({ socketPath, secretPath });
const host = createHostPort(client, identity);
const service = new MailboxService(host);

const server = new McpServer(
	{ name: "flywheel-v2-mailbox", version: "0.1.0" },
	{ capabilities: { experimental: { "claude/channel": {} } } },
);

function asText(value: unknown): {
	content: Array<{ type: "text"; text: string }>;
} {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
	};
}

function asError(error: unknown): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	return {
		content: [
			{
				type: "text" as const,
				text: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
			},
		],
		isError: true,
	};
}

server.tool(
	"next",
	"取下一封信。FYI 章读到即办结(下一次 mailbox 调用时自动销账);办事章/未知章保持挂账直到 settle。取信即在账本留下读痕(谁/几点/哪封)。",
	{},
	async () => {
		try {
			return asText(await service.next());
		} catch (error) {
			return asError(error);
		}
	},
);

server.tool(
	"settle",
	"办结当前未结的信。回答 runner_ask 用 reply(只给 body,路由由服务端从信里派生);task_assignment 的最终结算带 effects。重复调用安全(oneShot 重放)。",
	{
		reply: z.object({ body: z.string().min(1) }).optional(),
		effects: z.array(z.unknown()).optional(),
	},
	async ({ reply, effects }) => {
		try {
			return asText(
				await service.settle({
					...(reply ? { reply } : {}),
					...(effects ? { effects } : {}),
				}),
			);
		} catch (error) {
			return asError(error);
		}
	},
);

server.tool(
	"send",
	"发一封信。必须自带 dedupe_key(重试必须复用同一个 key,同字节=幂等,异字节=冲突报错)。",
	{
		to: z.string().min(1),
		kind: z.string().min(1),
		body: z.string().min(1),
		dedupe_key: z.string().min(1),
	},
	async ({ to, kind, body, dedupe_key }) => {
		try {
			return asText(
				await service.send({ to, kind, body, dedupeKey: dedupe_key }),
			);
		} catch (error) {
			return asError(error);
		}
	},
);

server.tool(
	"ask",
	"runner→lead 的问/报/阻(收件人由服务端按 issue 解析)。lead 回信不用这个——用 settle({reply})。",
	{
		ask_kind: z.enum(["ask", "progress", "blocked"]),
		body: z.string().min(1),
	},
	async ({ ask_kind, body }) => {
		try {
			return asText(await service.ask({ askKind: ask_kind, body }));
		} catch (error) {
			return asError(error);
		}
	},
);

server.tool(
	"status",
	"本人信箱账面:pending/在办计数、两章欠账、高水位 seq、每 kind 最老一封。",
	{},
	async () => {
		try {
			return asText(await service.status());
		} catch (error) {
			return asError(error);
		}
	},
);

// ── Channel bell (face 2) ──

const POLL_INTERVAL_MS = 1000;
const MAX_CONSECUTIVE_FAILURES = 5;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const bellState = initialBellState();

function failStop(reason: string): never {
	process.stderr.write(`[mailbox-mcp] fail-stop: ${reason}\n`);
	if (leasePath) deleteLease(leasePath);
	process.exit(1);
}

// R3-F3: the bell cycle is the extracted state machine in bell.ts — health is
// refreshed only after a fully successful cycle (a required ring included),
// cycles never overlap, and notification-only failures fail-stop too.
const bellIo = {
	peekMaxPendingSeq: () => service.peekMaxPendingSeq(),
	notify: async (maxSeq: number) => {
		await server.server.notification({
			method: "notifications/claude/channel",
			params: {
				content:
					"[flywheel-v2 mailbox] 你有新信。用 mailbox 的 next 工具取信;FYI 自动办结,问题类办完须 settle。",
				meta: { max_pending_seq: String(maxSeq) },
			},
		});
	},
	touchLease: () => {
		if (leasePath) touchLease(leasePath, new Date().toISOString());
	},
	failStop,
	log: (message: string) => {
		process.stderr.write(`[mailbox-mcp] ${message}\n`);
	},
	maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
};

async function bellOnce(): Promise<void> {
	await runBellCycle(bellState, bellIo);
}

async function main(): Promise<void> {
	if (leasePath) deleteLease(leasePath);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Startup jitter (0-1s) so N sessions do not thunder the host in phase.
	const jitterMs = Math.floor(Math.random() * POLL_INTERVAL_MS);
	setTimeout(() => {
		pollTimer = setInterval(() => {
			void bellOnce();
		}, POLL_INTERVAL_MS);
	}, jitterMs);
	// Lease AFTER transport connect (v1 inbox-mcp ordering): the engine seeing
	// the lease means the channel is actually wired.
	if (leasePath) writeLease(leasePath, { pid: process.pid });
	const shutdown = () => {
		if (pollTimer) clearInterval(pollTimer);
		if (leasePath) deleteLease(leasePath);
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	process.stderr.write(
		`[mailbox-mcp] ready — ${identity.mode} ${host.selfId()}\n`,
	);
}

main().catch((error) => {
	process.stderr.write(
		`[mailbox-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	if (leasePath) deleteLease(leasePath);
	process.exit(1);
});
