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
import {
	ABANDON_STATUSES_PARAM,
	buildRunnerListText,
	DONE_STATUSES_PARAM,
	mapWithConcurrency,
	type RunnerRow,
	validateAbandonReason,
} from "./lifecycle.js";
import { detectTerminalStatus } from "./status.js";

// FLY-229: cap on terminal rows fetched per `runner_terminal_list` call, to
// bound concurrent tmux liveness probes. Parked-alive sessions are inherently
// recent (ended_at-ordered), so the cap yields no realistic false-negative; a
// visible truncation summary covers the rest.
const TERMINAL_PROBE_CAP = 150;
const PROBE_CONCURRENCY = 8;

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
	[
		"List Runner sessions observable by this Lead, classified by CommDB status + tmux liveness.",
		"class=running (CommDB running), class=parked-alive (CommDB completed/timeout but tmux+agent still alive — idle, RE-ENGAGEABLE via `flywheel-comm send`/SendMessage, NO new run needed), class=dead (terminal + tmux gone).",
		"active_only=true (default) shows running + parked-alive (hides dead); active_only=false shows all classes.",
		"NOTE: this reflects CommDB status + live tmux probe only — it does NOT see the Bridge FSM state (awaiting_review etc.).",
	].join(" "),
	{
		active_only: z
			.boolean()
			.default(true)
			.describe(
				"true (default): show running + parked-alive (re-engageable), hide dead. false: show all classes.",
			),
	},
	async ({ active_only }) => {
		try {
			if (!existsSync(dbPath)) {
				return {
					content: [{ type: "text" as const, text: "No sessions found." }],
				};
			}
			const db = openDb();
			let running: ReturnType<CommDB["getActiveSessions"]>;
			let terminal: ReturnType<CommDB["getRecentTerminalSessions"]>;
			let terminalTotal: number;
			try {
				// running: no LIMIT → in-memory lead-scope filter is fine (as before).
				running = db
					.getActiveSessions(projectName)
					.filter((s) => s.lead_id === null || s.lead_id === leadId);
				// terminal (completed/timeout): lead-scoped + ended_at-ordered + capped
				// IN SQL (FLY-229), so an in-scope parked-alive row can't be pushed out
				// of the window by another Lead's newer rows.
				terminal = db.getRecentTerminalSessions(
					projectName,
					leadId,
					TERMINAL_PROBE_CAP,
				);
				terminalTotal = db.countTerminalSessions(projectName, leadId);
			} finally {
				db.close();
			}

			// Probe liveness with bounded concurrency (not one N-wide Promise.all).
			const toRow = (
				s: (typeof running)[number],
				alive: boolean,
			): RunnerRow => ({
				executionId: s.execution_id,
				tmuxWindow: s.tmux_window,
				issueId: s.issue_id,
				status: s.status,
				alive,
				startedAt: s.started_at,
			});
			const runningRows = await mapWithConcurrency(
				running,
				PROBE_CONCURRENCY,
				async (s) => toRow(s, await tmuxAlive(s.tmux_window)),
			);
			const terminalRows = await mapWithConcurrency(
				terminal,
				PROBE_CONCURRENCY,
				async (s) => toRow(s, await tmuxAlive(s.tmux_window)),
			);

			const text = buildRunnerListText({
				running: runningRows,
				terminal: terminalRows,
				terminalTotal,
				cap: TERMINAL_PROBE_CAP,
				activeOnly: active_only,
			});
			return { content: [{ type: "text" as const, text }] };
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

// Tool 6: close_runner (FLY-102 + FLY-116)
server.tool(
	"close_runner",
	[
		"Close a Runner's tmux window AND macOS Terminal viewer tab after it has reached a non-running outcome.",
		"AUTO-CLOSE statuses (kills tmux + closes Terminal tab): completed, rejected, deferred, shelved, terminated.",
		"PRESERVE statuses (FLY-116 — keeps tmux + tab so the user can inspect scrollback): failed, blocked.",
		"  → Returns { success: false, preserved: true, reason: 'crash_preserve' }.",
		"  → Cleanup happens later when the user transitions to retry/reject/defer/shelve/terminate.",
		"REJECTS: running, awaiting_review, approved, approved_to_ship — those must be approved/rejected first.",
		"To CANCEL/ABANDON a parked runner (awaiting_review / approved_to_ship — founder decided NOT to ship): set abandon=true. This routes to the terminate action (FSM→terminated + tmux/viewer teardown + audit), so you don't have to raw `tmux kill`. abandon is a terminate-class reserved action (founder-consent gated, same as terminate) and REQUIRES a reason.",
		"FLY-638 — to FINALIZE a DONE-but-stuck runner (ship SUCCEEDED so it parked at awaiting_review/approved_to_ship, or QA PASSED so it's still running, but it exited before its final `stage set completed`): set done=true. This transitions it to completed via the FSM, THEN closes (kills tmux window + cmux session + viewer tab) and archives the issue thread (the FLY-369 close→archive cascade). Use done=true (NOT abandon) when the work finished successfully — abandon=true marks it terminated (an abort) and does NOT archive. done and abandon are mutually exclusive.",
		"FLY-1204 — a three-stage DESIGN phase-session parks at `design_done` (kept alive as the design-context holder until ship). It too is reclaimed with done=true (design_done → completed via the FSM); a normal close still rejects it on purpose, so this is the explicit way to reclaim a leaked design phase-session by hand.",
		"Use after Annie confirms closure, or per team-lead pre-authorized rules.",
		"Idempotent: if the tmux window is already gone, returns success.",
	].join(" "),
	{
		issue_identifier: z
			.string()
			.optional()
			.describe(
				"Linear issue identifier (e.g. 'FLY-102'). Either this or execution_id required.",
			),
		execution_id: z
			.string()
			.optional()
			.describe(
				"CommDB execution_id. Either this or issue_identifier required.",
			),
		reason: z
			.string()
			.describe(
				"Why closing (for audit trail — e.g. 'Annie approved after ship complete'). REQUIRED non-empty when abandon=true.",
			),
		abandon: z
			.boolean()
			.default(false)
			.describe(
				"Cancel/abandon a PARKED runner (awaiting_review / approved_to_ship). Routes to the terminate action (FSM→terminated). Default false (normal close, which rejects parked states).",
			),
		done: z
			.boolean()
			.default(false)
			.describe(
				"FLY-638: FINALIZE a DONE-but-stuck runner (ship succeeded / QA passed but it never emitted its final `stage set completed`). Transitions running/awaiting_review/approved_to_ship/design_done → completed via the FSM, then closes + archives. Also reclaims a leaked three-stage design phase-session parked at design_done (FLY-1204). Use this (NOT abandon) for successful work. Mutually exclusive with abandon. Default false.",
			),
	},
	async ({ issue_identifier, execution_id, reason, abandon, done }) => {
		if (!issue_identifier && !execution_id) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: provide issue_identifier or execution_id",
					},
				],
				isError: true,
			};
		}

		const bridgeUrl = process.env.BRIDGE_URL;
		const token = process.env.TEAMLEAD_API_TOKEN;
		if (!bridgeUrl || !token) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: BRIDGE_URL / TEAMLEAD_API_TOKEN not configured",
					},
				],
				isError: true,
			};
		}

		// FLY-638: done and abandon are mutually exclusive (one finalizes a
		// successful runner, the other aborts it) — reject the contradiction up
		// front rather than silently preferring one.
		if (abandon && done) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: abandon and done are mutually exclusive. Use done=true to finalize a runner whose work SUCCEEDED, or abandon=true to terminate one you are NOT shipping.",
					},
				],
				isError: true,
			};
		}

		// FLY-228: abandon requires a non-empty audit reason (validated up front,
		// before any Bridge call).
		let abandonReason = "";
		if (abandon) {
			try {
				abandonReason = validateAbandonReason(reason);
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
		}

		try {
			let resolvedExec = execution_id;
			if (!resolvedExec && issue_identifier) {
				// FLY-102 Round 1 (Codex post-Round 4): constrain lookup to
				// close-eligible statuses. Without this filter, the fallback
				// `ORDER BY last_activity_at DESC LIMIT 1` can pick a running
				// session under retry/parallel — closing the wrong execution.
				// Mirrors CLOSE_ELIGIBLE_STATES in close-runner.ts (kept in sync).
				//
				// FLY-228 abandon: use the PARKED status set (awaiting_review,
				// approved_to_ship) — NOT a union with closable (a union would hit
				// the >1 guard whenever an old completed run coexists with the
				// current parked one) — and scope the lookup to THIS lead so an
				// out-of-scope same-identifier parked run can't trip the >1 guard.
				// FLY-638 done: resolve a DONE-but-stuck runner by the parked/running
				// status set, lead-scoped (same disambiguation reasoning as abandon).
				const lookupStatuses = abandon
					? ABANDON_STATUSES_PARAM
					: done
						? DONE_STATUSES_PARAM
						: "blocked,completed,deferred,failed,rejected,shelved,terminated";
				const leadScope =
					abandon || done ? `&leadId=${encodeURIComponent(leadId)}` : "";
				const lookupUrl = `${bridgeUrl}/api/sessions?mode=by_identifier&identifier=${encodeURIComponent(issue_identifier)}&statuses=${encodeURIComponent(lookupStatuses)}${leadScope}`;
				const r = await fetch(lookupUrl, {
					headers: { Authorization: `Bearer ${token}` },
				});
				if (!r.ok) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: lookup failed (${r.status})`,
							},
						],
						isError: true,
					};
				}
				const json = (await r.json()) as {
					sessions?: Array<{ execution_id: string; status: string }>;
				};
				if (!json.sessions?.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: abandon
									? `Error: no parked (awaiting_review / approved_to_ship) session for ${issue_identifier} in your scope. Nothing to abandon — if the runner is still running, terminate it instead; if it already finished, use a normal close.`
									: done
										? `Error: no done-but-stuck (running / awaiting_review / approved_to_ship / design_done) session for ${issue_identifier} in your scope. Nothing to finalize — if it already reached completed/rejected/etc, use a normal close.`
										: `Error: no closable session for ${issue_identifier}. If a Runner is currently running, wait for completion or pass execution_id explicitly.`,
							},
						],
						isError: true,
					};
				}
				if (json.sessions.length > 1) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: ${json.sessions.length} ${abandon ? "parked" : done ? "done-but-stuck" : "closable"} sessions for ${issue_identifier} — pass execution_id explicitly to disambiguate. Candidates: ${json.sessions.map((s) => `${s.execution_id}(${s.status})`).join(", ")}`,
							},
						],
						isError: true,
					};
				}
				resolvedExec = json.sessions[0]?.execution_id;
			}

			// Scope guard — reuse getSessionScoped so MCP-layer errors are consistent.
			if (existsSync(dbPath)) {
				const db = openDb();
				try {
					getSessionScoped(db, resolvedExec as string, {
						requireExactLead: true,
					});
				} finally {
					db.close();
				}
			}

			// FLY-228 abandon → terminate action (reuses handleTerminate teardown +
			// founder-consent + audit; FSM→terminated kills the zombie awaiting_review
			// row). Normal close → close-runner endpoint (unchanged). FLY-638 done →
			// the SAME close-runner endpoint with done=true (FSM finalize → completed
			// → close + archive cascade).
			const r = abandon
				? await fetch(`${bridgeUrl}/api/actions/terminate`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							execution_id: resolvedExec,
							leadId,
							reason: abandonReason,
						}),
					})
				: await fetch(
						`${bridgeUrl}/api/sessions/${resolvedExec}/close-runner`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${token}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								leadId,
								reason,
								...(done && { done: true }),
							}),
						},
					);
			const body = await r.text();
			if (r.status === 409) {
				return {
					content: [{ type: "text" as const, text: `Refused: ${body}` }],
				};
			}
			if (!r.ok) {
				return {
					content: [
						{ type: "text" as const, text: `Error (${r.status}): ${body}` },
					],
					isError: true,
				};
			}
			return { content: [{ type: "text" as const, text: body }] };
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
