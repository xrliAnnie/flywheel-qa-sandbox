/**
 * FLY-1018 tool declarations — the CLOSED 6-tool MVP registry (plan §2.2 D3).
 *
 * Model-facing JSON schemas aligned to the PRODUCTION Bridge contract
 * (spike-strict deviations reverted: create_issue requires title only).
 * request_ship_approval exposes only prUrl/summary/requesterContext to the
 * model — projectName + leadId are attached by BridgeClient from the session
 * binding (two fewer hallucination surfaces).
 *
 * CI guard (scripts/gemini-agent-guard.sh) asserts exactly 6 declaration
 * `name: "` lines in this file — changing the tool set must be an explicit,
 * reviewable act.
 */

import { workflowRegistryShapes } from "flywheel-config";
import type { JsonSchema } from "../types.js";

const WORKFLOW_MENU_SHAPES = workflowRegistryShapes();

export interface ToolDeclaration {
	name: string;
	description: string;
	parameters: JsonSchema;
	readonly: boolean;
}

export const TOOL_DECLARATIONS: Record<string, ToolDeclaration> = {
	create_issue: {
		name: "create_issue",
		description:
			"Create a new Linear issue in the tracker. Use this when the user asks to file, record, or turn something into an issue/ticket. Returns the created issue identifier and URL.",
		readonly: false,
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
						"Issue body: what the problem/task is, context, acceptance criteria. Optional but recommended.",
				},
				priority: {
					type: "number",
					description: "Priority 0 (none) to 4 (urgent). Optional.",
				},
				labels: {
					type: "array",
					items: { type: "string" },
					description:
						'Label names to apply, e.g. ["bug"] — each is resolved to the label of that name within the issue\'s team (team-scoped); an unknown label name fails with 404. Your department label (if configured) is applied automatically, do not add others speculatively. Optional.',
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
			required: ["title"],
		},
	},

	dispatch_runner: {
		name: "dispatch_runner",
		description:
			"Dispatch an autonomous Runner to work on an existing Linear issue. Requires the issue identifier, project name, and canonical taskCategory so work-kind routing can select the correct workflow. Returns an executionId to poll with query_status. ADMISSION: the issue must carry the target Lead's department label (issues you created via create_issue get it automatically when configured). A 403 with code DEPT_SCOPE_REJECT means the issue's labels do not satisfy that gate (reason issue_no_department_label = the label is missing; label_mismatch = it belongs to a different Lead) — recreate the issue with the correct department label or ask the user; do not retry the same dispatch unchanged.",
		readonly: false,
		parameters: {
			type: "object",
			properties: {
				issueId: {
					type: "string",
					description:
						'Linear issue identifier the Runner should work on, e.g. "FLY-123". Must be an existing issue.',
				},
				projectName: {
					type: "string",
					description: 'Project the issue belongs to, e.g. "geoforge3d".',
				},
				taskCategory: {
					type: "string",
					enum: [...WORKFLOW_MENU_SHAPES],
					description:
						"Required canonical menu: code for engineering work needing a distinct engineering-design phase, simple_code for a bounded code change followed by QA, prd for product definition, product_design_flow for product/UX design, prototype for feasibility prototypes, or generic for a non-code one-session task. It changes routing only for projects with menu/work-kind dispatch enabled.",
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
			required: ["issueId", "projectName", "taskCategory"],
		},
	},

	query_status: {
		name: "query_status",
		description:
			'Query a dispatched Runner session by its executionId (returned from dispatch_runner). Returns two independent signals: `status` — a latest-capture terminal heuristic, one of executing (active-looking output) / waiting (a visible input prompt) / idle (a shell prompt or empty pane) / unknown; and `session_status` — the run lifecycle from the store (e.g. "running", "awaiting_review" = PR opened and waiting for founder review, "completed", "failed"), plus `pr_number` once a PR is recorded (null before that; no PR URL is returned — report the pr_number). Runs take minutes to hours: after 2-3 polls, stop polling and report the current state to the user instead of waiting for a terminal state.',
		readonly: true,
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

	search_memory: {
		name: "search_memory",
		description:
			"Semantic search over the project's long-term memory (conventions, past decisions, agent routing rules). ALWAYS search memory before dispatching work if project conventions might apply. Shared bucket: set user_id equal to project_name and omit agent_id.",
		readonly: true,
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

	save_memory: {
		name: "save_memory",
		description:
			"Persist a conclusion or fact into the project's long-term SHARED memory so future agents can recall it. Use after completing a task to record the outcome. The memory is saved to this session's project bucket under the session Lead's identity automatically — you only supply the content.",
		readonly: false,
		parameters: {
			type: "object",
			properties: {
				content: {
					type: "string",
					description:
						"The fact/conclusion to remember, one self-contained statement.",
				},
			},
			required: ["content"],
		},
	},

	request_ship_approval: {
		name: "request_ship_approval",
		description:
			"REQUEST founder approval to ship/merge a completed PR. This is the ONLY ship-related action available: it files an approval request to the responsible Lead and founder. You cannot merge, ship, or deploy anything yourself — merge/ship always requires the founder's structured approval. Never claim a PR is merged.",
		readonly: false,
		parameters: {
			type: "object",
			properties: {
				prUrl: {
					type: "string",
					description:
						"The GitHub PR URL to be approved, e.g. https://github.com/org/repo/pull/123.",
				},
				summary: {
					type: "string",
					description:
						"One-line summary of what ships and why it is ready (max 2000 chars).",
				},
				requesterContext: {
					type: "string",
					description:
						"Optional: short note on who asked for this and in what context (max 500 chars).",
				},
			},
			required: ["prUrl", "summary"],
		},
	},
};
