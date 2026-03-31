#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildSafeRegex, CommDB, validateProjectName } from "flywheel-comm/db";
import { z } from "zod";
import { detectTerminalStatus } from "./status.js";

const execFileAsync = promisify(execFile);

// ── Required env vars (injected by claude-lead.sh) ──
const projectName = process.env.FLYWHEEL_PROJECT_NAME;
const leadId = process.env.FLYWHEEL_LEAD_ID;

if (!projectName) {
	process.stderr.write("FLYWHEEL_PROJECT_NAME is required\n");
	process.exit(1);
}
if (!leadId) {
	process.stderr.write("FLYWHEEL_LEAD_ID is required\n");
	process.exit(1);
}

validateProjectName(projectName);
const dbPath = join(homedir(), ".flywheel", "comm", projectName, "comm.db");

// ── Helpers ──

function openDb(): CommDB {
	return CommDB.openReadonly(dbPath);
}

/**
 * Scope guard: verify session belongs to this Lead.
 *
 * Read-only operations (capture/list/search/status): sessions with
 * lead_id = null are visible (legacy/unscoped sessions need observability).
 * Write operations (input): require exact lead_id match — null is rejected.
 */
function getSessionScoped(
	db: CommDB,
	sessionId: string,
	opts?: { requireExactLead?: boolean },
) {
	const session = db.getSession(sessionId);
	if (!session) {
		throw new Error(`No session found: ${sessionId}`);
	}
	if (opts?.requireExactLead) {
		// Write operations: must match exactly, null lead_id is rejected
		if (session.lead_id !== leadId) {
			throw new Error(
				`Session ${sessionId} is not in scope for lead ${leadId}`,
			);
		}
	} else {
		// Read operations: allow null lead_id (unscoped/legacy sessions)
		if (session.lead_id !== null && session.lead_id !== leadId) {
			throw new Error(
				`Session ${sessionId} is not in scope for lead ${leadId}`,
			);
		}
	}
	return session;
}

async function tmuxCapture(target: string, lines: number): Promise<string> {
	const { stdout } = await execFileAsync(
		"tmux",
		["capture-pane", "-t", target, "-p", "-S", `-${lines}`],
		{ encoding: "utf-8", timeout: 5000 },
	);
	return stdout;
}

async function tmuxAlive(tmuxTarget: string): Promise<boolean> {
	try {
		// Use list-panes with the full target (session:window) to check
		// if the specific window exists, not just the parent session.
		await execFileAsync("tmux", ["list-panes", "-t", tmuxTarget], {
			timeout: 3000,
		});
		return true;
	} catch {
		return false;
	}
}

// ── MCP Server ──

const server = new McpServer({
	name: "flywheel-terminal",
	version: "0.1.0",
});

// Tool 1: runner_terminal_capture
server.tool(
	"runner_terminal_capture",
	"Capture the last N lines of a Runner's terminal output.",
	{
		session_id: z.string().describe("Execution ID of the Runner session"),
		lines: z
			.number()
			.min(1)
			.max(500)
			.default(100)
			.describe("Number of lines to capture (default 100)"),
	},
	async ({ session_id, lines }) => {
		try {
			if (!existsSync(dbPath)) {
				throw new Error(`Database not found: ${dbPath}`);
			}
			const db = openDb();
			let tmuxTarget: string;
			try {
				const session = getSessionScoped(db, session_id);
				tmuxTarget = session.tmux_window;
			} finally {
				db.close();
			}
			const output = await tmuxCapture(tmuxTarget, lines);
			return { content: [{ type: "text" as const, text: output }] };
		} catch (e) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: ${e instanceof Error ? e.message : String(e)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool 2: runner_terminal_list
server.tool(
	"runner_terminal_list",
	"List Runner sessions observable by this Lead. Shows session IDs, tmux targets, issue IDs, and liveness status.",
	{
		active_only: z
			.boolean()
			.default(true)
			.describe("Only show running sessions (default true)"),
	},
	async ({ active_only }) => {
		try {
			if (!existsSync(dbPath)) {
				return {
					content: [{ type: "text" as const, text: "No sessions found." }],
				};
			}
			const db = openDb();
			let allResults: ReturnType<CommDB["listSessions"]>;
			try {
				allResults = active_only
					? db.getActiveSessions(projectName)
					: db.listSessions(projectName);
			} finally {
				db.close();
			}

			// Scope filter: matching lead_id OR null (unscoped legacy)
			const results = allResults.filter(
				(s) => s.lead_id === null || s.lead_id === leadId,
			);

			if (results.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No sessions found." }],
				};
			}

			const lines: string[] = [];
			for (const s of results) {
				const alive = await tmuxAlive(s.tmux_window);
				lines.push(
					`[${s.execution_id}] tmux=${s.tmux_window} issue=${s.issue_id ?? "-"} status=${s.status} alive=${alive} started=${s.started_at}`,
				);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
			};
		} catch (e) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: ${e instanceof Error ? e.message : String(e)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool 3: runner_terminal_search
server.tool(
	"runner_terminal_search",
	"Search a Runner's terminal output for a regex pattern. Returns matching lines with line numbers.",
	{
		session_id: z.string().describe("Execution ID of the Runner session"),
		pattern: z
			.string()
			.max(200)
			.describe("Regex pattern (case-insensitive, max 200 chars)"),
		lines: z
			.number()
			.min(1)
			.max(2000)
			.default(500)
			.describe("Lines of history to search (default 500)"),
	},
	async ({ session_id, pattern, lines }) => {
		try {
			if (!existsSync(dbPath)) {
				throw new Error(`Database not found: ${dbPath}`);
			}
			const db = openDb();
			let tmuxTarget: string;
			try {
				const session = getSessionScoped(db, session_id);
				tmuxTarget = session.tmux_window;
			} finally {
				db.close();
			}

			const output = await tmuxCapture(tmuxTarget, lines);
			const regex = buildSafeRegex(pattern);
			const allLines = output.split("\n");
			const matches: string[] = [];
			for (let i = 0; i < allLines.length; i++) {
				const line = allLines[i]!;
				if (regex.test(line)) {
					matches.push(`${i + 1}: ${line}`);
				}
			}

			if (matches.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No matches for "${pattern}" in ${allLines.length} lines.`,
						},
					],
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `${matches.length} matches in ${allLines.length} lines:\n${matches.join("\n")}`,
					},
				],
			};
		} catch (e) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: ${e instanceof Error ? e.message : String(e)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool 4: runner_terminal_status
server.tool(
	"runner_terminal_status",
	"Detect a Runner's terminal state: executing (agent working), waiting (prompt/confirmation visible), or idle (shell prompt, no agent). Use this before sending input — only send input when status is 'waiting'.",
	{
		session_id: z.string().describe("Execution ID of the Runner session"),
	},
	async ({ session_id }) => {
		try {
			if (!existsSync(dbPath)) {
				throw new Error(`Database not found: ${dbPath}`);
			}
			const db = openDb();
			let tmuxTarget: string;
			try {
				const session = getSessionScoped(db, session_id);
				tmuxTarget = session.tmux_window;
			} finally {
				db.close();
			}

			const alive = await tmuxAlive(tmuxTarget);
			if (!alive) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								status: "dead",
								reason: "tmux session not running",
							}),
						},
					],
				};
			}

			const output = await tmuxCapture(tmuxTarget, 30);
			const status = detectTerminalStatus(output);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(status) }],
			};
		} catch (e) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: ${e instanceof Error ? e.message : String(e)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool 5: runner_terminal_input
server.tool(
	"runner_terminal_input",
	"Send text input to a Runner's terminal via tmux send-keys. SAFETY: Only use when runner_terminal_status reports 'waiting'. Sending input while status is 'executing' may corrupt the agent's context.",
	{
		session_id: z.string().describe("Execution ID of the Runner session"),
		text: z
			.string()
			.max(2000)
			.describe("Text to send to the terminal (max 2000 chars)"),
		enter: z
			.boolean()
			.default(true)
			.describe("Whether to press Enter after the text (default true)"),
	},
	async ({ session_id, text, enter }) => {
		try {
			if (!existsSync(dbPath)) {
				throw new Error(`Database not found: ${dbPath}`);
			}
			const db = openDb();
			let tmuxTarget: string;
			try {
				const session = getSessionScoped(db, session_id, {
					requireExactLead: true,
				});
				tmuxTarget = session.tmux_window;
			} finally {
				db.close();
			}

			const alive = await tmuxAlive(tmuxTarget);
			if (!alive) {
				throw new Error(`tmux session not running for ${session_id}`);
			}

			// Use -l (literal) to prevent key-name interpretation.
			// Send text and Enter separately — -l makes "Enter" literal too.
			await execFileAsync("tmux", ["send-keys", "-t", tmuxTarget, "-l", text], {
				timeout: 5000,
			});
			if (enter) {
				await execFileAsync("tmux", ["send-keys", "-t", tmuxTarget, "Enter"], {
					timeout: 5000,
				});
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Sent${enter ? " (with Enter)" : ""}: ${text.length > 100 ? `${text.slice(0, 100)}...` : text}`,
					},
				],
			};
		} catch (e) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: ${e instanceof Error ? e.message : String(e)}`,
					},
				],
				isError: true,
			};
		}
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
