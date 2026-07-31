#!/usr/bin/env node
/**
 * FLY-1546 feasibility spike — minimal MCP server over the REAL v2 mailbox.
 *
 * Zero npm dependencies: raw JSON-RPC 2.0 over stdio (the MCP wire format),
 * SQLite reads via the `sqlite3` CLI in -readonly mode (never writes).
 *
 * Three checks this enables:
 *   1. `claude mcp add` → a Claude session calls the `next` tool → real letter.
 *   2. `codex mcp add`  → a Codex session calls the same tool  → real letter.
 *   3. Push: when $FLYWHEEL_SPIKE_PUSH_FILE appears, its content is pushed into
 *      the connected Claude session via the official channel protocol
 *      (`notifications/claude/channel`, capability `experimental["claude/channel"]`
 *      — same wire shape as production packages/inbox-mcp).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

const DB =
	process.env.FLYWHEEL_V2_DB ??
	`${process.env.HOME}/.flywheel/v2/flywheel-v2.db`;
const PUSH_FILE =
	process.env.FLYWHEEL_SPIKE_PUSH_FILE ?? "/tmp/fly1546-spike-push.txt";

function readMailboxHead(agentLike) {
	const where = agentLike
		? `WHERE to_agent LIKE '%' || '${agentLike.replaceAll("'", "''")}' || '%'`
		: "";
	const sql = `SELECT seq, message_uid, to_agent, kind, state, substr(payload,1,600) AS payload, created_at
               FROM mailbox ${where} ORDER BY seq DESC LIMIT 3;`;
	const out = execFileSync("sqlite3", ["-readonly", "-json", DB, sql], {
		encoding: "utf8",
	});
	return out.trim() === "" ? [] : JSON.parse(out);
}

let buffered = "";
function send(msg) {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle(req) {
	const { id, method, params } = req;
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: params?.protocolVersion ?? "2024-11-05",
				serverInfo: { name: "fly1546-spike-mailbox", version: "0.0.1" },
				capabilities: { tools: {}, experimental: { "claude/channel": {} } },
			},
		});
		return;
	}
	if (method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				tools: [
					{
						name: "next",
						description:
							"Read the newest letters in the REAL flywheel v2 mailbox (read-only; no settlement). Optional recipient filter.",
						inputSchema: {
							type: "object",
							properties: {
								recipient: {
									type: "string",
									description: "substring filter on to_agent",
								},
							},
						},
					},
				],
			},
		});
		return;
	}
	if (method === "tools/call" && params?.name === "next") {
		let text;
		try {
			text = JSON.stringify(
				readMailboxHead(params?.arguments?.recipient),
				null,
				2,
			);
		} catch (error) {
			send({
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: `ERROR: ${error.message}` }],
					isError: true,
				},
			});
			return;
		}
		send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
		return;
	}
	if (id !== undefined) {
		send({
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: `method not supported: ${method}` },
		});
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
	buffered += chunk;
	let newline = buffered.indexOf("\n");
	while (newline >= 0) {
		const raw = buffered.slice(0, newline).trim();
		buffered = buffered.slice(newline + 1);
		if (raw !== "") {
			try {
				handle(JSON.parse(raw));
			} catch (error) {
				process.stderr.write(`[spike] bad frame: ${error.message}\n`);
			}
		}
		newline = buffered.indexOf("\n");
	}
});

// Check 3 — push face: poll for the push file; when present, push its content
// into the connected session via the official channel notification.
setInterval(() => {
	if (!existsSync(PUSH_FILE)) return;
	let content;
	try {
		content = readFileSync(PUSH_FILE, "utf8");
		unlinkSync(PUSH_FILE);
	} catch {
		return;
	}
	send({
		jsonrpc: "2.0",
		method: "notifications/claude/channel",
		params: {
			content,
			meta: { from: "fly1546-spike", message_id: `spike-${Date.now()}` },
		},
	});
	process.stderr.write("[spike] pushed channel notification\n");
}, 1000);
