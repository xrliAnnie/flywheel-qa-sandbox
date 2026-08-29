/**
 * FLY-1018 dispatch-layer schema validation (plan §2.3 gate c).
 *
 * Validation lives in the DISPATCH layer, not inside tools (design
 * principle 5 — the model unexpectedly often produces invalid input).
 * Stricter than the Bridge on purpose: unknown parameters are rejected
 * (anti-hallucination; schema and tool surface evolve in the same
 * package, so locking is harmless), and empty string counts as missing
 * (spike semantics preserved).
 */

import type { JsonSchema, ToolSpec } from "../types.js";
import type { BridgeClient } from "./bridge-client.js";
import { TOOL_DECLARATIONS } from "./schemas.js";

export function validateArgs(
	schema: JsonSchema,
	args: Record<string, unknown>,
): string[] {
	const errors: string[] = [];
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
		if (prop.enum && !prop.enum.includes(val as string | number)) {
			errors.push(`${key} must be one of: ${prop.enum.join(", ")}`);
		}
		if (t === "array" && Array.isArray(val) && prop.items?.type === "string") {
			if (!val.every((x) => typeof x === "string"))
				errors.push(`${key} items must be strings`);
		}
	}
	return errors;
}

/**
 * Session binding — the north-star "talk to a SPECIFIC Lead about a
 * SPECIFIC project" anchor. request_ship_approval's target Lead comes
 * explicitly from here (Codex R3-1: never inferred from projectName).
 */
export interface SessionBinding {
	projectName: string;
	leadId: string;
	/**
	 * FLY-1060 QA F2: the bound Lead's department label. When set it is
	 * auto-applied to every created issue (binding-attached, outside the
	 * hallucination surface — same pattern as request_ship_approval's
	 * projectName/leadId) so dispatch_runner passes the Bridge dept-scope
	 * admission gate. Absent ⇒ create_issue args pass through unchanged.
	 */
	deptLabel?: string;
}

/**
 * Bind the 6 declarations to live BridgeClient executes. The model-facing
 * schemas stay exactly TOOL_DECLARATIONS — binding fields are attached
 * server-bound only, outside the hallucination surface.
 */
export function createToolRegistry(
	bridge: BridgeClient,
	binding: SessionBinding,
): Record<string, ToolSpec> {
	const specs: Record<string, ToolSpec> = {};

	const executes: Record<
		string,
		(
			args: Record<string, unknown>,
			signal: AbortSignal,
		) => ReturnType<BridgeClient["request"]>
	> = {
		// binding deptLabel merged in (case-insensitive dedupe) so agent-created
		// issues carry the department label dispatch admission requires (F2)
		create_issue: (args, signal) => {
			let body: Record<string, unknown> = args;
			if (binding.deptLabel) {
				const existing = Array.isArray(args.labels)
					? (args.labels as string[])
					: [];
				const already = existing.some(
					(l) =>
						typeof l === "string" &&
						l.toLowerCase() === binding.deptLabel?.toLowerCase(),
				);
				if (!already) {
					body = { ...args, labels: [...existing, binding.deptLabel] };
				}
			}
			return bridge.request("POST", "/api/linear/create-issue", body, signal);
		},
		dispatch_runner: (args, signal) =>
			bridge.request("POST", "/api/runs/start", args, signal),
		query_status: (args, signal) =>
			bridge.request(
				"GET",
				`/api/sessions/${encodeURIComponent(String(args.executionId))}/status`,
				undefined,
				signal,
			),
		search_memory: (args, signal) =>
			bridge.request("POST", "/api/memory/search", args, signal),
		// adapter: memory-route expects messages[]; the model only supplies
		// content. FLY-1060 QA R2 F4: the identity triple is binding-attached —
		// agent_id MUST be a configured lead agentId (GEO-204 validateMemoryIds
		// whitelist), which the model cannot know; the old schema-advertised
		// "gemini-agent" 400'd forever. Shared project bucket by design (task
		// outcomes must be recallable by future agents).
		save_memory: (args, signal) =>
			bridge.request(
				"POST",
				"/api/memory/add",
				{
					messages: [{ role: "assistant", content: args.content }],
					project_name: binding.projectName,
					agent_id: binding.leadId,
					user_id: binding.projectName,
				},
				signal,
			),
		// projectName + leadId attached from the session binding — the model
		// never sees or supplies them (plan §2.8)
		request_ship_approval: (args, signal) =>
			bridge.request(
				"POST",
				"/api/ship-approval-request",
				{
					prUrl: args.prUrl,
					summary: args.summary,
					...(args.requesterContext !== undefined && {
						requesterContext: args.requesterContext,
					}),
					projectName: binding.projectName,
					leadId: binding.leadId,
				},
				signal,
			),
	};

	for (const [name, decl] of Object.entries(TOOL_DECLARATIONS)) {
		const execute = executes[name];
		if (!execute) throw new Error(`no execute bound for tool ${name}`);
		specs[name] = {
			name: decl.name,
			description: decl.description,
			parameters: decl.parameters,
			readonly: decl.readonly,
			execute: (args, ctx) => execute(args, ctx.signal),
		};
	}
	return specs;
}

/** Subset selector, e.g. registryFor(registry, ["dispatch_runner"]). */
export function registryFor(
	registry: Record<string, ToolSpec>,
	names: string[],
): Record<string, ToolSpec> {
	const out: Record<string, ToolSpec> = {};
	for (const n of names) {
		const spec = registry[n];
		if (!spec) throw new Error(`unknown tool in registry selection: ${n}`);
		out[n] = spec;
	}
	return out;
}
