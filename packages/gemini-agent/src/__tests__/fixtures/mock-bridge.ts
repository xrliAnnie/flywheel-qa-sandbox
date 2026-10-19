/**
 * FLY-1018 contract-test fixture — ported from the FLY-997 spike's
 * mock-bridge.mjs (its validation behavior was verified line-by-line
 * against the production routes on 2026-07-08):
 *   POST /api/runs/start           — runs-route.ts (400 / 409 / 200 shapes)
 *   POST /api/linear/create-issue  — plugin.ts create-issue (400 / 502 / 200)
 *   GET  /api/sessions/:id/status  — tools.ts (404 {error:"Session not found"})
 *   POST /api/memory/search        — memory-route.ts (dual-bucket 400s)
 *   POST /api/memory/add           — memory-route.ts (messages validation)
 *   POST /api/ship-approval-request — the FLY-1018 route (plan §2.8 contract)
 *
 * Adds Bearer auth (401 {error:"unauthorized"}) mirroring
 * tokenAuthMiddleware so the client's credential path is contract-tested.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockBridgeState {
	issues: Array<Record<string, unknown>>;
	runs: Array<{
		executionId: string;
		issueId: string;
		projectName: string;
		agentName: string | null;
		docTier: string | null;
		statusPolls: number;
	}>;
	memories: Array<Record<string, unknown>>;
	shipApprovalRequests: Array<Record<string, unknown>>;
	requestLog: Array<{
		method: string;
		path: string;
		body: unknown;
		auth: string | undefined;
	}>;
	faults: Record<string, boolean>;
	counters: { issue: number; run: number; request: number };
}

function freshState(): MockBridgeState {
	return {
		issues: [],
		runs: [],
		memories: [],
		shipApprovalRequests: [],
		requestLog: [],
		faults: {},
		counters: { issue: 0, run: 0, request: 0 },
	};
}

const MEMORY_FIXTURES = [
	{
		id: "mock-mem-001",
		memory:
			"Project geoforge3d convention: printer-firmware bugs must be dispatched to agentName backend-executor (they own the firmware toolchain).",
		score: 0.92,
	},
	{
		id: "mock-mem-002",
		memory:
			"geoforge3d uses docTier plan_only for small bugfix issues by team convention.",
		score: 0.81,
	},
];

/**
 * GEO-204 validateMemoryIds mirror (FLY-1060 QA R2 F4): the real memory route
 * only accepts configured lead agentIds. The spike mock's LACK of this check
 * is exactly why F4 survived until the real-Bridge matrix — keep it mirrored
 * so the contract tests catch this defect class from now on.
 */
const MEMORY_AGENT_WHITELIST = ["flywheel-eng-lead"];

const SHIP_NOTE =
	"Ship approval requested. Nothing has been merged; founder approval and the owning runner's verified ship flow are still required.";

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface MockBridge {
	url: string;
	state: MockBridgeState;
	reset(): void;
	close(): Promise<void>;
}

export async function startMockBridge(
	token = "test-token",
): Promise<MockBridge> {
	const state = freshState();

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const raw = Buffer.concat(chunks).toString("utf8");
		let body: Record<string, unknown> = {};
		if (raw) {
			try {
				body = JSON.parse(raw);
			} catch {
				body = { __parse_error: true };
			}
		}
		const auth = req.headers.authorization;
		state.requestLog.push({
			method: req.method ?? "",
			path: url.pathname,
			body,
			auth,
		});

		const json = (status: number, out: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(out));
		};

		// tokenAuthMiddleware mirror: Bearer required on every /api route
		if (auth !== `Bearer ${token}`) {
			return json(401, { error: "unauthorized" });
		}

		if (req.method === "POST" && url.pathname === "/api/runs/start") {
			const { issueId, projectName } = body;
			if (!issueId || typeof issueId !== "string")
				return json(400, { success: false, message: "issueId is required" });
			if (!projectName || typeof projectName !== "string")
				return json(400, {
					success: false,
					message: "projectName is required",
				});
			const rawAgentName = body.agentName;
			if (rawAgentName !== undefined && rawAgentName !== null) {
				if (typeof rawAgentName !== "string")
					return json(400, {
						success: false,
						code: "INVALID_AGENT_NAME",
						reason: "wrong_type",
						silent: false,
					});
				if (rawAgentName.length === 0)
					return json(400, {
						success: false,
						code: "INVALID_AGENT_NAME",
						reason: "empty_string",
						silent: false,
					});
			}
			const rawLeadId = body.leadId;
			if (typeof rawLeadId !== "string" || rawLeadId.trim().length === 0)
				return json(403, {
					success: false,
					code: "DEPT_SCOPE_REJECT",
					reason: "lead_identity_required",
					canonicalLeadId: null,
					silent: false,
				});
			const existing = state.runs.find((r) => r.issueId === issueId);
			if (state.faults.dispatch409 || existing) {
				const execId = existing?.executionId ?? "exec-mock-preexisting";
				return json(409, {
					success: false,
					message: `Issue ${issueId} already has an active session for role "main" (${execId}, status: running). If that session is parked and still alive (idle), re-engage it via 'flywheel-comm send' / SendMessage instead of starting a new run — check runner_terminal_list (class=parked-alive).`,
				});
			}
			state.counters.run += 1;
			const executionId = `exec-mock-${String(state.counters.run).padStart(3, "0")}`;
			state.runs.push({
				executionId,
				issueId,
				projectName,
				agentName: (rawAgentName as string | undefined) ?? null,
				docTier: (body.docTier as string | undefined) ?? null,
				statusPolls: 0,
			});
			return json(200, {
				success: true,
				executionId,
				issueId,
				chatThreadId: "mock-thread-001",
				message: `Runner started for ${issueId}`,
			});
		}

		if (req.method === "POST" && url.pathname === "/api/linear/create-issue") {
			const { title, description, priority, labels, team, project } = body;
			if (!title || typeof title !== "string")
				return json(400, { error: "title is required" });
			if (title.length > 500)
				return json(400, { error: "title must be 500 chars or less" });
			if (description !== undefined && typeof description !== "string")
				return json(400, { error: "description must be a string" });
			if (
				priority !== undefined &&
				(typeof priority !== "number" ||
					(priority as number) < 0 ||
					(priority as number) > 4)
			)
				return json(400, { error: "priority must be 0-4" });
			if (
				labels !== undefined &&
				(!Array.isArray(labels) ||
					!labels.every((l: unknown) => typeof l === "string"))
			)
				return json(400, { error: "labels must be a string array" });
			if (team !== undefined && typeof team !== "string")
				return json(400, {
					error: 'team must be a string (team key, e.g. "FLY")',
				});
			if (project !== undefined && typeof project !== "string")
				return json(400, { error: "project must be a string (project name)" });
			if (state.faults.createIssue502)
				return json(502, { error: "Linear API error" });
			state.counters.issue += 1;
			const identifier = `MOCK-${state.counters.issue}`;
			state.issues.push({ identifier, title, description, labels, team });
			return json(200, {
				ok: true,
				issue: {
					id: `mock-uuid-${state.counters.issue}`,
					identifier,
					url: `https://linear.example.invalid/issue/${identifier}`,
				},
			});
		}

		const statusMatch = url.pathname.match(
			/^\/api\/sessions\/([^/]+)\/status$/,
		);
		if (req.method === "GET" && statusMatch) {
			if (state.faults.statusNotFound)
				return json(404, { error: "Session not found" });
			const id = decodeURIComponent(statusMatch[1] ?? "");
			const run = state.runs.find(
				(r) => r.executionId === id || r.issueId === id,
			);
			if (!run) return json(404, { error: "Session not found" });
			run.statusPolls += 1;
			const completed = run.statusPolls >= 2;
			return json(200, {
				execution_id: run.executionId,
				status: completed ? "completed" : "running",
				...(completed && {
					pr_url: `https://github.com/example/repo/pull/${900 + state.counters.run}`,
				}),
				checked_at: new Date().toISOString(),
			});
		}

		if (req.method === "POST" && url.pathname === "/api/memory/search") {
			const { query, project_name, agent_id, user_id } = body;
			if (!isNonEmptyString(query))
				return json(400, { error: "query must be a non-empty string" });
			if (!isNonEmptyString(project_name))
				return json(400, {
					error: "project_name must be a non-empty string",
				});
			if (agent_id !== undefined && !isNonEmptyString(agent_id))
				return json(400, {
					error: "agent_id must be a non-empty string if provided",
				});
			if (agent_id !== undefined && !MEMORY_AGENT_WHITELIST.includes(agent_id))
				return json(400, {
					error: `unknown agent_id: "${agent_id}" for project "${project_name}"`,
				});
			if (!isNonEmptyString(user_id))
				return json(400, { error: "user_id must be a non-empty string" });
			if (agent_id === undefined) {
				if (user_id !== project_name)
					return json(400, {
						error:
							"when agent_id is omitted, user_id must equal project_name (shared bucket)",
					});
			} else if (user_id !== agent_id && user_id !== project_name) {
				return json(400, {
					error:
						"user_id must equal agent_id (private bucket) or project_name (shared bucket)",
				});
			}
			return json(200, { memories: MEMORY_FIXTURES });
		}

		if (req.method === "POST" && url.pathname === "/api/memory/add") {
			const { messages, project_name, agent_id, user_id, metadata } = body;
			if (!isNonEmptyString(project_name))
				return json(400, {
					error: "project_name must be a non-empty string",
				});
			if (!isNonEmptyString(agent_id))
				return json(400, { error: "agent_id must be a non-empty string" });
			if (!MEMORY_AGENT_WHITELIST.includes(agent_id))
				return json(400, {
					error: `unknown agent_id: "${agent_id}" for project "${project_name}"`,
				});
			if (!isNonEmptyString(user_id))
				return json(400, { error: "user_id must be a non-empty string" });
			if (!Array.isArray(messages) || messages.length === 0)
				return json(400, { error: "messages must be a non-empty array" });
			for (const msg of messages) {
				if (!isPlainObject(msg))
					return json(400, { error: "each message must be an object" });
				if (msg.role !== "user" && msg.role !== "assistant")
					return json(400, {
						error: 'message role must be "user" or "assistant"',
					});
				if (!isNonEmptyString(msg.content))
					return json(400, {
						error: "message content must be a non-empty string",
					});
			}
			if (metadata !== undefined && !isPlainObject(metadata))
				return json(400, { error: "metadata must be a plain object" });
			state.memories.push({ messages, project_name, agent_id, user_id });
			return json(200, {
				results: [
					{ id: `mock-mem-add-${state.memories.length}`, event: "ADD" },
				],
			});
		}

		if (
			req.method === "POST" &&
			url.pathname === "/api/ship-approval-request"
		) {
			// FLY-1018 route contract (plan §2.8)
			const { prUrl, summary, projectName, leadId, requesterContext } = body;
			if (!isNonEmptyString(prUrl))
				return json(400, { success: false, message: "prUrl is required" });
			if (!isNonEmptyString(summary))
				return json(400, { success: false, message: "summary is required" });
			if (!isNonEmptyString(projectName))
				return json(400, {
					success: false,
					message: "projectName is required",
				});
			if (!isNonEmptyString(leadId))
				return json(400, { success: false, message: "leadId is required" });
			state.counters.request += 1;
			const requestId = `ship-req-mock-${String(state.counters.request).padStart(3, "0")}`;
			state.shipApprovalRequests.push({
				requestId,
				prUrl,
				summary,
				projectName,
				leadId,
				requesterContext: requesterContext ?? null,
			});
			return json(200, { ok: true, requestId, note: SHIP_NOTE });
		}

		return json(404, { error: `unknown route ${req.method} ${url.pathname}` });
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const port = (server.address() as AddressInfo).port;

	return {
		url: `http://127.0.0.1:${port}`,
		state,
		reset() {
			Object.assign(state, freshState());
		},
		close() {
			return new Promise((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}
