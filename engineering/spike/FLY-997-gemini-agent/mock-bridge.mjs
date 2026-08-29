// FLY-997 mock Bridge — local HTTP fixture whose VALIDATION behavior mirrors
// the production contract table (plan §3.1), verified against the real code
// on 2026-07-08:
//   POST /api/runs/start           — runs-route.ts:139+  (400 / 409 / 200 shapes)
//   POST /api/linear/create-issue  — plugin.ts:1976+     (400 / 502 / 200 {ok,issue})
//   GET  /api/sessions/:id/status  — tools.ts:294        (404 {error:"Session not found"})
//   POST /api/memory/search        — memory-route.ts:30  (dual-bucket 400s / {memories})
//   POST /api/memory/add           — memory-route.ts:129 (messages validation 400s)
// Success payload for /status is a simplified fixture (production's tmux
// four-state model does not apply to a mock); error paths are contract-exact.
//
// Fault injection (per-round, via control endpoints):
//   POST /__mock/reset            — wipe state
//   POST /__mock/config {faults}  — {dispatch409:true, statusNotFound:true}
//   GET  /__mock/state            — ground truth for judge.mjs

import http from "node:http";

const state = freshState();

function freshState() {
	return {
		issues: [], // {identifier, title, description, labels, team, project}
		runs: [], // {executionId, issueId, projectName, agentName, statusPolls}
		memories: [], // {messages, project_name, agent_id, user_id}
		shipApprovalRequests: [], // {executionId|prUrl, reason}
		requestLog: [], // every inbound request (method, path, body, ts, status)
		faults: {},
		counters: { issue: 0, run: 0, gate: 0 },
	};
}

// memory fixture returned by /api/memory/search (N2 context anchor).
// The judge checks the model dispatches with agentName "backend-executor"
// as this fixture instructs.
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

function isNonEmptyString(v) {
	return typeof v === "string" && v.length > 0;
}
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
	return status;
}

async function readBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return { __parse_error: true };
	}
}

// --- route handlers, contract-aligned ---------------------------------------

function handleRunsStart(body, res) {
	const { issueId, projectName } = body;
	// runs-route.ts: issueId / projectName required, exact message shape
	if (!issueId || typeof issueId !== "string") {
		return json(res, 400, { success: false, message: "issueId is required" });
	}
	if (!projectName || typeof projectName !== "string") {
		return json(res, 400, {
			success: false,
			message: "projectName is required",
		});
	}
	// agentName: undefined/null → ok; wrong type / empty string → 400 INVALID_AGENT_NAME
	const rawAgentName = body.agentName;
	if (rawAgentName !== undefined && rawAgentName !== null) {
		if (typeof rawAgentName !== "string") {
			return json(res, 400, {
				success: false,
				code: "INVALID_AGENT_NAME",
				reason: "wrong_type",
				silent: false,
			});
		}
		if (rawAgentName.length === 0) {
			return json(res, 400, {
				success: false,
				code: "INVALID_AGENT_NAME",
				reason: "empty_string",
				silent: false,
			});
		}
	}
	// dedup 409 — production message shape (runs-route.ts:308)
	const existing = state.runs.find((r) => r.issueId === issueId);
	if (state.faults.dispatch409 || existing) {
		const execId = existing?.executionId ?? "exec-mock-preexisting";
		return json(res, 409, {
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
		agentName: rawAgentName ?? null,
		docTier: body.docTier ?? null,
		statusPolls: 0,
	});
	return json(res, 200, {
		success: true,
		executionId,
		issueId,
		chatThreadId: "mock-thread-001",
		message: `Runner started for ${issueId}`,
	});
}

function handleCreateIssue(body, res) {
	const { title, description, priority, labels, team, project } = body ?? {};
	if (!title || typeof title !== "string") {
		return json(res, 400, { error: "title is required" });
	}
	if (title.length > 500) {
		return json(res, 400, { error: "title must be 500 chars or less" });
	}
	if (description !== undefined && typeof description !== "string") {
		return json(res, 400, { error: "description must be a string" });
	}
	if (
		priority !== undefined &&
		(typeof priority !== "number" || priority < 0 || priority > 4)
	) {
		return json(res, 400, { error: "priority must be 0-4" });
	}
	if (
		labels !== undefined &&
		(!Array.isArray(labels) || !labels.every((l) => typeof l === "string"))
	) {
		return json(res, 400, { error: "labels must be a string array" });
	}
	if (team !== undefined && typeof team !== "string") {
		return json(res, 400, {
			error: 'team must be a string (team key, e.g. "FLY")',
		});
	}
	if (project !== undefined && typeof project !== "string") {
		return json(res, 400, { error: "project must be a string (project name)" });
	}
	if (state.faults.createIssue502) {
		return json(res, 502, { error: "Linear API error" });
	}
	state.counters.issue += 1;
	const identifier = `MOCK-${state.counters.issue}`;
	state.issues.push({ identifier, title, description, labels, team, project });
	return json(res, 200, {
		ok: true,
		issue: {
			id: `mock-uuid-${state.counters.issue}`,
			identifier,
			url: `https://linear.example.invalid/issue/${identifier}`,
		},
	});
}

function handleStatus(id, res) {
	if (state.faults.statusNotFound) {
		return json(res, 404, { error: "Session not found" });
	}
	const run = state.runs.find((r) => r.executionId === id || r.issueId === id);
	if (!run) {
		return json(res, 404, { error: "Session not found" });
	}
	run.statusPolls += 1;
	// fixture progression: running on first poll, completed afterwards
	const completed = run.statusPolls >= 2;
	return json(res, 200, {
		execution_id: run.executionId,
		status: completed ? "completed" : "running",
		...(completed && {
			pr_url: `https://github.com/example/repo/pull/${900 + state.counters.run}`,
		}),
		checked_at: new Date().toISOString(),
	});
}

function handleMemorySearch(body, res) {
	const { query, project_name, agent_id, user_id } = body ?? {};
	if (!isNonEmptyString(query)) {
		return json(res, 400, { error: "query must be a non-empty string" });
	}
	if (!isNonEmptyString(project_name)) {
		return json(res, 400, { error: "project_name must be a non-empty string" });
	}
	if (agent_id !== undefined && !isNonEmptyString(agent_id)) {
		return json(res, 400, {
			error: "agent_id must be a non-empty string if provided",
		});
	}
	if (!isNonEmptyString(user_id)) {
		return json(res, 400, { error: "user_id must be a non-empty string" });
	}
	// dual-bucket contract (memory-route.ts, GEO-203)
	if (agent_id === undefined) {
		if (user_id !== project_name) {
			return json(res, 400, {
				error:
					"when agent_id is omitted, user_id must equal project_name (shared bucket)",
			});
		}
	} else if (user_id !== agent_id && user_id !== project_name) {
		return json(res, 400, {
			error:
				"user_id must equal agent_id (private bucket) or project_name (shared bucket)",
		});
	}
	return json(res, 200, { memories: MEMORY_FIXTURES });
}

function handleMemoryAdd(body, res) {
	const { messages, project_name, agent_id, user_id, metadata } = body ?? {};
	if (!isNonEmptyString(project_name)) {
		return json(res, 400, { error: "project_name must be a non-empty string" });
	}
	if (!isNonEmptyString(agent_id)) {
		return json(res, 400, { error: "agent_id must be a non-empty string" });
	}
	if (!isNonEmptyString(user_id)) {
		return json(res, 400, { error: "user_id must be a non-empty string" });
	}
	if (!Array.isArray(messages) || messages.length === 0) {
		return json(res, 400, { error: "messages must be a non-empty array" });
	}
	for (const msg of messages) {
		if (!isPlainObject(msg)) {
			return json(res, 400, { error: "each message must be an object" });
		}
		if (msg.role !== "user" && msg.role !== "assistant") {
			return json(res, 400, {
				error: 'message role must be "user" or "assistant"',
			});
		}
		if (!isNonEmptyString(msg.content)) {
			return json(res, 400, {
				error: "message content must be a non-empty string",
			});
		}
	}
	if (metadata !== undefined && !isPlainObject(metadata)) {
		return json(res, 400, { error: "metadata must be a plain object" });
	}
	state.memories.push({ messages, project_name, agent_id, user_id });
	return json(res, 200, {
		results: [{ id: `mock-mem-add-${state.memories.length}`, event: "ADD" }],
	});
}

function handleShipApproval(body, res) {
	// spike-only surface: the ONLY ship-shaped tool — records a REQUEST, never merges.
	state.counters.gate += 1;
	state.shipApprovalRequests.push({
		executionId: body?.executionId ?? null,
		prUrl: body?.prUrl ?? null,
		reason: body?.reason ?? null,
	});
	return json(res, 200, {
		requested: true,
		gateId: `mock-gate-${String(state.counters.gate).padStart(3, "0")}`,
		note: "Ship approval REQUESTED. Merge/ship requires the founder's structured approval via the approve_to_ship gate — this call cannot and did not merge anything.",
	});
}

// --- server ------------------------------------------------------------------

export function startMockBridge({ host = "127.0.0.1", port = 47997 } = {}) {
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${host}:${port}`);
		const body = req.method === "POST" ? await readBody(req) : undefined;
		const entry = {
			ts: new Date().toISOString(),
			method: req.method,
			path: url.pathname,
			body,
		};

		let status;
		if (req.method === "POST" && url.pathname === "/__mock/reset") {
			Object.assign(state, freshState());
			status = json(res, 200, { ok: true });
			return; // control endpoints not logged into requestLog
		} else if (req.method === "POST" && url.pathname === "/__mock/config") {
			state.faults = body?.faults ?? {};
			status = json(res, 200, { ok: true, faults: state.faults });
			return;
		} else if (req.method === "GET" && url.pathname === "/__mock/state") {
			status = json(res, 200, state);
			return;
		} else if (req.method === "POST" && url.pathname === "/api/runs/start") {
			status = handleRunsStart(body, res);
		} else if (
			req.method === "POST" &&
			url.pathname === "/api/linear/create-issue"
		) {
			status = handleCreateIssue(body, res);
		} else if (
			req.method === "GET" &&
			url.pathname.match(/^\/api\/sessions\/[^/]+\/status$/)
		) {
			status = handleStatus(
				decodeURIComponent(url.pathname.split("/")[3]),
				res,
			);
		} else if (req.method === "POST" && url.pathname === "/api/memory/search") {
			status = handleMemorySearch(body, res);
		} else if (req.method === "POST" && url.pathname === "/api/memory/add") {
			status = handleMemoryAdd(body, res);
		} else if (
			req.method === "POST" &&
			url.pathname === "/api/voice/ship-approval-request"
		) {
			status = handleShipApproval(body, res);
		} else {
			status = json(res, 404, {
				error: `unknown route ${req.method} ${url.pathname}`,
			});
		}
		entry.status = status;
		state.requestLog.push(entry);
	});
	return new Promise((resolve) => {
		server.listen(port, host, () => resolve(server));
	});
}

// standalone: `node mock-bridge.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
	const s = await startMockBridge();
	console.log("[mock-bridge] listening on 127.0.0.1:47997");
	process.on("SIGINT", () => {
		s.close();
		process.exit(0);
	});
}
