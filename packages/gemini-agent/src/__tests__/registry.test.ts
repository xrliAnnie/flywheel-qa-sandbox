import { workflowRegistryShapes } from "flywheel-config";
import { describe, expect, it } from "vitest";
import type { BridgeClient } from "../tools/bridge-client.js";
import { createToolRegistry, validateArgs } from "../tools/registry.js";
import { TOOL_DECLARATIONS } from "../tools/schemas.js";
import type { ToolExecCtx } from "../types.js";

describe("TOOL_DECLARATIONS (plan §2.2 D3 — the closed 6-tool MVP registry)", () => {
	it("declares exactly the 6 MVP tools", () => {
		expect(Object.keys(TOOL_DECLARATIONS).sort()).toEqual([
			"create_issue",
			"dispatch_runner",
			"query_status",
			"request_ship_approval",
			"save_memory",
			"search_memory",
		]);
	});

	it("contains no merge/ship-execution tool — request_ship_approval is the only ship-shaped surface", () => {
		for (const name of Object.keys(TOOL_DECLARATIONS)) {
			expect(name).not.toMatch(/merge|deploy/);
			if (name.includes("ship")) expect(name).toBe("request_ship_approval");
		}
	});

	it("create_issue requires only title (production contract — spike-strict description reverted)", () => {
		expect(TOOL_DECLARATIONS.create_issue.parameters.required).toEqual([
			"title",
		]);
	});

	it("request_ship_approval model-facing schema exposes only prUrl/summary/requesterContext (projectName+leadId are session-attached, not model-visible)", () => {
		const params = TOOL_DECLARATIONS.request_ship_approval.parameters;
		expect(Object.keys(params.properties ?? {}).sort()).toEqual([
			"prUrl",
			"requesterContext",
			"summary",
		]);
		expect(params.required).toEqual(["prUrl", "summary"]);
	});

	it("readonly flags: query_status/search_memory true, others false", () => {
		expect(TOOL_DECLARATIONS.query_status.readonly).toBe(true);
		expect(TOOL_DECLARATIONS.search_memory.readonly).toBe(true);
		expect(TOOL_DECLARATIONS.create_issue.readonly).toBe(false);
		expect(TOOL_DECLARATIONS.dispatch_runner.readonly).toBe(false);
		expect(TOOL_DECLARATIONS.save_memory.readonly).toBe(false);
		expect(TOOL_DECLARATIONS.request_ship_approval.readonly).toBe(false);
	});

	it("every declaration has a full parameter schema (FLY-959 lesson: zero-schema declarations make the model fabricate)", () => {
		for (const decl of Object.values(TOOL_DECLARATIONS)) {
			expect(decl.description.length).toBeGreaterThan(20);
			expect(decl.parameters.type).toBe("object");
			expect(
				Object.keys(decl.parameters.properties ?? {}).length,
			).toBeGreaterThan(0);
		}
	});

	// FLY-1060 QA F3: the old description promised "running/completed + PR URL"
	// while the real route answers a four-state pane heuristic — the model
	// polled for a "completed" that never comes until max-steps burned out.
	it("query_status describes the REAL route contract (four-state + session_status), not running/completed", () => {
		const desc = TOOL_DECLARATIONS.query_status.description;
		expect(desc).not.toContain("running/completed");
		for (const word of ["executing", "waiting", "idle", "unknown"]) {
			expect(desc).toContain(word);
		}
		expect(desc).toContain("session_status");
		expect(desc).toMatch(/do not keep polling|stop polling/i);
	});

	// FLY-1060 QA F2: dispatch admission is label-gated in production — the
	// model must know what a DEPT_SCOPE_REJECT means and how to act on it.
	it("dispatch_runner documents the department-label admission gate", () => {
		const desc = TOOL_DECLARATIONS.dispatch_runner.description;
		expect(desc).toContain("department label");
		expect(desc).toContain("DEPT_SCOPE_REJECT");
	});

	it("dispatch_runner requires the canonical work-kind enum and mirrors the runtime vocabulary", () => {
		const params = TOOL_DECLARATIONS.dispatch_runner.parameters;
		expect(params.required).toEqual(["issueId", "projectName", "taskCategory"]);
		expect(params.properties?.taskCategory?.enum).toEqual(
			workflowRegistryShapes(),
		);
		expect(
			validateArgs(params, {
				issueId: "FLY-1436",
				projectName: "flywheel",
			}),
		).toContain("missing required parameter: taskCategory");
	});

	it("create_issue documents team-scoped label-name resolution (F1)", () => {
		const labels = TOOL_DECLARATIONS.create_issue.parameters.properties?.labels;
		expect(labels?.description).toMatch(/resolved .*team|team-scoped/i);
	});

	// FLY-1060 QA R2 F4: the old schema told the model to write agent_id
	// "gemini-agent", but the real memory route (GEO-204 validateMemoryIds)
	// only accepts configured lead agentIds — the advertised value 400'd
	// forever. Identity is session-attached now, exactly like
	// request_ship_approval's projectName/leadId.
	it("save_memory model-facing schema exposes only content (identity is session-attached, not model-visible)", () => {
		const params = TOOL_DECLARATIONS.save_memory.parameters;
		expect(Object.keys(params.properties ?? {})).toEqual(["content"]);
		expect(params.required).toEqual(["content"]);
		expect(TOOL_DECLARATIONS.save_memory.description).not.toContain(
			'"gemini-agent"',
		);
	});
});

describe("createToolRegistry — binding deptLabel auto-apply (FLY-1060 QA F2)", () => {
	function capturingBridge() {
		const calls: Array<{ method: string; path: string; body: unknown }> = [];
		const bridge = {
			request: async (method: string, path: string, body?: unknown) => {
				calls.push({ method, path, body });
				return { ok: true, httpStatus: 200, body: "{}" };
			},
		} as unknown as BridgeClient;
		return { bridge, calls };
	}

	const ctx = { signal: new AbortController().signal } as ToolExecCtx;

	it("auto-applies the binding deptLabel when the model passed no labels", async () => {
		const { bridge, calls } = capturingBridge();
		const registry = createToolRegistry(bridge, {
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			deptLabel: "Eng",
		});
		await registry.create_issue?.execute({ title: "t" }, ctx);
		expect(calls[0]?.body).toEqual({ title: "t", labels: ["Eng"] });
	});

	it("appends the deptLabel to model-supplied labels", async () => {
		const { bridge, calls } = capturingBridge();
		const registry = createToolRegistry(bridge, {
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			deptLabel: "Eng",
		});
		await registry.create_issue?.execute({ title: "t", labels: ["bug"] }, ctx);
		expect(calls[0]?.body).toEqual({ title: "t", labels: ["bug", "Eng"] });
	});

	it("dedupes case-insensitively when the model already applied it", async () => {
		const { bridge, calls } = capturingBridge();
		const registry = createToolRegistry(bridge, {
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			deptLabel: "Eng",
		});
		await registry.create_issue?.execute({ title: "t", labels: ["eng"] }, ctx);
		expect(calls[0]?.body).toEqual({ title: "t", labels: ["eng"] });
	});

	it("no deptLabel configured → args pass through byte-identical (byte-compat)", async () => {
		const { bridge, calls } = capturingBridge();
		const registry = createToolRegistry(bridge, {
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
		});
		const args = { title: "t", labels: ["bug"] };
		await registry.create_issue?.execute(args, ctx);
		expect(calls[0]?.body).toBe(args);
	});

	it("deptLabel never leaks into other tools", async () => {
		const { bridge, calls } = capturingBridge();
		const registry = createToolRegistry(bridge, {
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			deptLabel: "Eng",
		});
		await registry.dispatch_runner?.execute(
			{ issueId: "FLY-1", projectName: "flywheel" },
			ctx,
		);
		expect(calls[0]?.body).toEqual({
			issueId: "FLY-1",
			projectName: "flywheel",
		});
	});
});

describe("createToolRegistry — save_memory binding identity (FLY-1060 QA R2 F4)", () => {
	function capturingBridge() {
		const calls: Array<{ method: string; path: string; body: unknown }> = [];
		const bridge = {
			request: async (method: string, path: string, body?: unknown) => {
				calls.push({ method, path, body });
				return { ok: true, httpStatus: 200, body: "{}" };
			},
		} as unknown as BridgeClient;
		return { bridge, calls };
	}

	const ctx = { signal: new AbortController().signal } as ToolExecCtx;

	it("attaches the FULL identity triple from the binding — the model only supplies content", async () => {
		const { bridge, calls } = capturingBridge();
		const registry = createToolRegistry(bridge, {
			projectName: "geoforge3d",
			leadId: "flywheel-eng-lead",
		});
		await registry.save_memory?.execute({ content: "the outcome" }, ctx);
		expect(calls[0]?.path).toBe("/api/memory/add");
		expect(calls[0]?.body).toEqual({
			messages: [{ role: "assistant", content: "the outcome" }],
			project_name: "geoforge3d",
			agent_id: "flywheel-eng-lead", // the WHITELISTED lead identity
			user_id: "geoforge3d", // shared project bucket
		});
	});

	it("model-supplied identity args can never override the binding", async () => {
		const { bridge, calls } = capturingBridge();
		const registry = createToolRegistry(bridge, {
			projectName: "geoforge3d",
			leadId: "flywheel-eng-lead",
		});
		// schema no longer declares these, but execute must be safe even if
		// a raw caller passes them: binding wins, nothing leaks through.
		await registry.save_memory?.execute(
			{
				content: "x",
				agent_id: "gemini-agent",
				user_id: "someone-else",
				project_name: "evil",
			},
			ctx,
		);
		expect(calls[0]?.body).toEqual({
			messages: [{ role: "assistant", content: "x" }],
			project_name: "geoforge3d",
			agent_id: "flywheel-eng-lead",
			user_id: "geoforge3d",
		});
	});
});

describe("validateArgs (dispatch-layer schema gate)", () => {
	const schema = {
		type: "object",
		properties: {
			title: { type: "string" },
			priority: { type: "number" },
			labels: { type: "array", items: { type: "string" } },
			docTier: { type: "string", enum: ["full", "plan_only", "none"] },
			flag: { type: "boolean" },
			meta: { type: "object" },
		},
		required: ["title"],
	};

	it("accepts valid args", () => {
		expect(validateArgs(schema, { title: "hi", priority: 2 })).toEqual([]);
	});

	it("rejects non-object args", () => {
		expect(validateArgs(schema, [] as unknown as Record<string, unknown>)) //
			.toEqual(["arguments must be a JSON object"]);
	});

	it("rejects a missing required parameter", () => {
		expect(validateArgs(schema, {})).toEqual([
			"missing required parameter: title",
		]);
	});

	it("treats empty string as missing (spike semantics preserved)", () => {
		expect(validateArgs(schema, { title: "" })).toEqual([
			"missing required parameter: title",
		]);
	});

	it("rejects unknown parameters (stricter than the Bridge — anti-hallucination)", () => {
		expect(validateArgs(schema, { title: "x", bogus: 1 })).toEqual([
			"unknown parameter: bogus",
		]);
	});

	it("rejects wrong types", () => {
		expect(validateArgs(schema, { title: 42 })).toContain(
			"title must be a string",
		);
		expect(validateArgs(schema, { title: "x", priority: "high" })).toContain(
			"priority must be a number",
		);
		expect(validateArgs(schema, { title: "x", labels: "bug" })).toContain(
			"labels must be an array",
		);
		expect(validateArgs(schema, { title: "x", flag: "yes" })).toContain(
			"flag must be a boolean",
		);
		expect(validateArgs(schema, { title: "x", meta: [1] })).toContain(
			"meta must be an object",
		);
	});

	it("rejects values outside an enum", () => {
		expect(validateArgs(schema, { title: "x", docTier: "huge" })).toEqual([
			"docTier must be one of: full, plan_only, none",
		]);
	});

	it("rejects non-string items in a string array", () => {
		expect(validateArgs(schema, { title: "x", labels: ["a", 1] })).toEqual([
			"labels items must be strings",
		]);
	});

	it("collects multiple errors in one pass", () => {
		const errors = validateArgs(schema, { bogus: 1, priority: "p" });
		expect(errors).toHaveLength(3);
	});
});
