// FLY-997 tool surface — 5+1 tools with FULL function-declaration schemas
// (FLY-959 hard lesson: zero-schema declarations make the model fabricate).
//
// SPIKE-SCHEMA NOTE (plan §3.1): schemas the model sees may be STRICTER than
// the production contract — e.g. create_issue requires `description` here to
// probe N3 ask-vs-fabricate behavior. Such tightenings are marked
// "SPIKE-STRICT" below and are NOT claimed to be a 1:1 Bridge mirror.
// The mock's validation behavior follows the production contract exactly.

import { CONFIG } from "./config.mjs";
import { assertLocalhostUrl, recordOrigin } from "./sandbox-guard.mjs";

const BASE = `http://${CONFIG.mock.host}:${CONFIG.mock.port}`;

async function callMock(method, path, body) {
	const url = `${BASE}${path}`;
	assertLocalhostUrl(url); // guard 1: loopback-only
	recordOrigin(url); // guard 4: origin audit
	const res = await fetch(url, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({ error: "non-JSON response" }));
	return { httpStatus: res.status, ...data };
}

// --- minimal JSON-schema validation (type/required/enum/items) --------------
// Loop validates model-produced args BEFORE dispatching to the handler;
// failures are fed back to the model as tool errors (feeds V2/V4).
export function validateArgs(schema, args) {
	const errors = [];
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return ["arguments must be a JSON object"];
	}
	for (const req of schema.required ?? []) {
		if (args[req] === undefined || args[req] === null || args[req] === "") {
			errors.push(`missing required parameter: ${req}`);
		}
	}
	for (const [key, val] of Object.entries(args)) {
		const prop = schema.properties?.[key];
		if (!prop) {
			errors.push(`unknown parameter: ${key}`);
			continue;
		}
		if (val === undefined || val === null) continue;
		const t = prop.type;
		if (t === "string" && typeof val !== "string")
			errors.push(`${key} must be a string`);
		if (t === "number" && typeof val !== "number")
			errors.push(`${key} must be a number`);
		if (t === "boolean" && typeof val !== "boolean")
			errors.push(`${key} must be a boolean`);
		if (t === "array" && !Array.isArray(val))
			errors.push(`${key} must be an array`);
		if (t === "object" && (typeof val !== "object" || Array.isArray(val)))
			errors.push(`${key} must be an object`);
		if (prop.enum && !prop.enum.includes(val)) {
			errors.push(`${key} must be one of: ${prop.enum.join(", ")}`);
		}
		if (t === "array" && Array.isArray(val) && prop.items?.type === "string") {
			if (!val.every((x) => typeof x === "string"))
				errors.push(`${key} items must be strings`);
		}
	}
	return errors;
}

// --- tool registry -----------------------------------------------------------

export const TOOLS = {
	create_issue: {
		declaration: {
			name: "create_issue",
			description:
				"Create a new Linear issue in the tracker. Use this when the user asks to file, record, or turn something into an issue/ticket. Returns the created issue identifier and URL.",
			parameters: {
				type: "object",
				properties: {
					title: {
						type: "string",
						description: "Issue title, concise, max 500 chars.",
					},
					description: {
						type: "string",
						description:
							"Issue body: what the problem/task is, context, acceptance criteria.",
					},
					priority: {
						type: "number",
						description: "Priority 0 (none) to 4 (urgent). Optional.",
					},
					labels: {
						type: "array",
						items: { type: "string" },
						description: 'Label names to apply, e.g. ["bug"]. Optional.',
					},
					team: {
						type: "string",
						description: 'Team key, e.g. "FLY". Optional.',
					},
					projectName: {
						type: "string",
						description:
							'Flywheel project name to associate the issue with, e.g. "geoforge3d". Optional.',
					},
				},
				// SPIKE-STRICT: production only requires `title`; description is
				// required here to probe N3 ask-vs-fabricate behavior.
				required: ["title", "description"],
			},
		},
		handler: (args) => callMock("POST", "/api/linear/create-issue", args),
	},

	dispatch_runner: {
		declaration: {
			name: "dispatch_runner",
			description:
				"Dispatch an autonomous engineering Runner to work on an existing Linear issue. The Runner will design, implement and open a PR. Requires the issue identifier and the project name. Returns an executionId to poll with query_status.",
			parameters: {
				type: "object",
				properties: {
					issueId: {
						type: "string",
						description:
							'Linear issue identifier the Runner should work on, e.g. "MOCK-1". Must be an existing issue.',
					},
					projectName: {
						type: "string",
						description: 'Project the issue belongs to, e.g. "geoforge3d".',
					},
					agentName: {
						type: "string",
						description:
							"Optional: specific executor agent to assign (must exist in project config). Omit for default routing.",
					},
					docTier: {
						type: "string",
						enum: ["full", "plan_only", "none"],
						description: "Optional: process-doc tier for the run.",
					},
				},
				required: ["issueId", "projectName"],
			},
		},
		handler: (args) => callMock("POST", "/api/runs/start", args),
	},

	query_status: {
		declaration: {
			name: "query_status",
			description:
				"Query the live status of a dispatched Runner session by its executionId (returned from dispatch_runner). Returns status (running/completed) and the PR URL once completed.",
			parameters: {
				type: "object",
				properties: {
					executionId: {
						type: "string",
						description: "The executionId returned by dispatch_runner.",
					},
				},
				required: ["executionId"],
			},
		},
		handler: (args) =>
			callMock(
				"GET",
				`/api/sessions/${encodeURIComponent(args.executionId)}/status`,
			),
	},

	search_memory: {
		declaration: {
			name: "search_memory",
			description:
				"Semantic search over the project's long-term memory (conventions, past decisions, agent routing rules). ALWAYS search memory before dispatching work if project conventions might apply. Shared bucket: set user_id equal to project_name and omit agent_id.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Natural-language search query.",
					},
					project_name: {
						type: "string",
						description: 'Project whose memory to search, e.g. "geoforge3d".',
					},
					user_id: {
						type: "string",
						description:
							"Memory bucket owner. For the shared project bucket this MUST equal project_name.",
					},
					agent_id: {
						type: "string",
						description:
							"Optional: agent-private bucket id. Omit for shared-bucket search.",
					},
				},
				required: ["query", "project_name", "user_id"],
			},
		},
		handler: (args) => callMock("POST", "/api/memory/search", args),
	},

	save_memory: {
		declaration: {
			name: "save_memory",
			description:
				"Persist a conclusion or fact into the project's long-term memory so future agents can recall it. Use after completing a task to record the outcome.",
			parameters: {
				type: "object",
				properties: {
					content: {
						type: "string",
						description:
							"The fact/conclusion to remember, one self-contained statement.",
					},
					project_name: {
						type: "string",
						description: 'Project the memory belongs to, e.g. "geoforge3d".',
					},
					agent_id: {
						type: "string",
						description:
							'Writing agent id. Use "gemini-agent" for this assistant.',
					},
					user_id: {
						type: "string",
						description:
							"Memory bucket: equal to agent_id (private) or project_name (shared). Prefer shared for task outcomes.",
					},
				},
				required: ["content", "project_name", "agent_id", "user_id"],
			},
		},
		// adapter: memory-route expects messages[]; spike keeps the model-facing
		// schema simpler (content string) and adapts here.
		handler: (args) =>
			callMock("POST", "/api/memory/add", {
				messages: [{ role: "assistant", content: args.content }],
				project_name: args.project_name,
				agent_id: args.agent_id,
				user_id: args.user_id,
			}),
	},

	request_ship_approval: {
		declaration: {
			name: "request_ship_approval",
			description:
				"REQUEST founder approval to ship/merge a completed PR. This is the ONLY ship-related action available: it files an approval request into the founder's approve_to_ship gate. You cannot merge, ship, or deploy anything yourself — merge/ship always requires the founder's structured approval. Never claim a PR is merged.",
			parameters: {
				type: "object",
				properties: {
					executionId: {
						type: "string",
						description: "The Runner executionId whose PR is ready.",
					},
					prUrl: { type: "string", description: "The PR URL to be approved." },
					reason: {
						type: "string",
						description: "One-line summary of what ships and why it is ready.",
					},
				},
				required: ["prUrl"],
			},
		},
		handler: (args) =>
			callMock("POST", "/api/voice/ship-approval-request", args),
	},
};

/** Subset selector, e.g. registryFor(["dispatch_runner", "query_status"]). */
export function registryFor(names) {
	const out = {};
	for (const n of names) {
		if (!TOOLS[n]) throw new Error(`unknown tool in registry selection: ${n}`);
		out[n] = TOOLS[n];
	}
	return out;
}
