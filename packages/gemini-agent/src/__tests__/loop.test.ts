import { describe, expect, it } from "vitest";
import { AbortedError, ModelCallError } from "../errors.js";
import { type RunLoopOptions, runLoop } from "../loop.js";
import type {
	AuditLog,
	ModelSurface,
	ModelTurn,
	ToolResult,
	ToolSpec,
} from "../types.js";

/** Recording audit — the ordering oracle for the dispatch gate. */
function recordingAudit() {
	const events: Array<Record<string, unknown>> = [];
	const audit: AuditLog = {
		sessionStart: (e) => events.push({ type: "session_start", ...e }),
		modelCall: (step, transition) =>
			events.push({ type: "model_call", step, transition }),
		modelResponse: (step, functionCallCount) =>
			events.push({ type: "model_response", step, functionCallCount }),
		toolDispatch: (step, tool, _digest, decision) =>
			events.push({ type: "tool_dispatch", step, tool, decision }),
		toolResult: (step, tool, ok) =>
			events.push({ type: "tool_result", step, tool, ok }),
		retry: () => events.push({ type: "retry" }),
		terminal: (reason) => events.push({ type: "terminal", reason }),
		warning: (message) => events.push({ type: "warning", message }),
	};
	return { audit, events };
}

function turnOf(
	functionCalls: ModelTurn["functionCalls"],
	text: string | null = null,
	usage = { inputTokens: 10, outputTokens: 5 },
): ModelTurn {
	return { functionCalls, text, usage };
}

/** Scripted surface: each entry is a turn to return or an error to throw. */
function scriptedSurface(script: Array<ModelTurn | Error>): ModelSurface & {
	continues: Array<
		Array<{ callId: string; name: string; result: string; isError: boolean }>
	>;
} {
	let i = 0;
	const continues: Array<
		Array<{ callId: string; name: string; result: string; isError: boolean }>
	> = [];
	const next = async (): Promise<ModelTurn> => {
		const entry = script[i];
		i += 1;
		if (entry === undefined) throw new Error("script exhausted");
		if (entry instanceof Error) throw entry;
		return entry;
	};
	return {
		continues,
		start: () => next(),
		continueWith: (results) => {
			continues.push(results);
			return next();
		},
	};
}

function makeTool(
	name: string,
	overrides: Partial<ToolSpec> = {},
	onExecute?: (args: Record<string, unknown>) => Promise<ToolResult>,
): ToolSpec {
	return {
		name,
		description: `${name} tool`,
		parameters: {
			type: "object",
			properties: { title: { type: "string" } },
			required: ["title"],
		},
		readonly: false,
		execute:
			onExecute ??
			(async () => ({ ok: true, httpStatus: 200, body: '{"ok":true}' })),
		...overrides,
	};
}

function baseOpts(
	surface: ModelSurface,
	registry: Record<string, ToolSpec>,
	extra: Partial<RunLoopOptions> = {},
): RunLoopOptions {
	const { audit } = recordingAudit();
	return {
		surface,
		registry,
		system: "sys",
		user: "user",
		audit,
		signal: new AbortController().signal,
		sessionId: "sid",
		model: "m",
		surfaceName: "interactions",
		maxSteps: 12,
		tokenBudgetIn: 200_000,
		tokenBudgetOut: 20_000,
		resultCapChars: 16_000,
		...extra,
	};
}

describe("runLoop", () => {
	it("completed: tool round then final answer, stats populated", async () => {
		const surface = scriptedSurface([
			turnOf([{ id: "c1", name: "create_issue", args: { title: "t" } }]),
			turnOf([], "all done"),
		]);
		const registry = { create_issue: makeTool("create_issue") };
		const t = await runLoop(baseOpts(surface, registry));
		expect(t.reason).toBe("completed");
		expect(t.finalText).toBe("all done");
		expect(t.stats.steps).toBe(2);
		expect(t.stats.toolCalls).toBe(1);
		expect(t.stats.toolErrors).toBe(0);
		expect(t.stats.hallucinatedToolCalls).toBe(0);
		expect(t.stats.inputTokens).toBe(20);
		expect(t.stats.outputTokens).toBe(10);
		// the executed result is fed back verbatim
		expect(surface.continues[0]?.[0]).toMatchObject({
			callId: "c1",
			name: "create_issue",
			result: '{"ok":true}',
			isError: false,
		});
	});

	it("hallucinated tool name: never executed, error feedback lists available tools", async () => {
		const surface = scriptedSurface([
			turnOf([{ id: "c1", name: "merge_pr", args: {} }]),
			turnOf([], "ok"),
		]);
		let executed = false;
		const registry = {
			create_issue: makeTool("create_issue", {}, async () => {
				executed = true;
				return { ok: true, body: "{}" };
			}),
		};
		const t = await runLoop(baseOpts(surface, registry));
		expect(t.reason).toBe("completed");
		expect(executed).toBe(false);
		expect(t.stats.hallucinatedToolCalls).toBe(1);
		const fed = surface.continues[0]?.[0];
		expect(fed?.isError).toBe(true);
		expect(fed?.result).toContain("unknown tool: merge_pr");
		expect(fed?.result).toContain("create_issue");
	});

	it("schema rejection: missing required / unknown param / empty string all feed back as errors", async () => {
		const surface = scriptedSurface([
			turnOf([
				{ id: "c1", name: "create_issue", args: {} },
				{ id: "c2", name: "create_issue", args: { title: "x", bogus: 1 } },
				{ id: "c3", name: "create_issue", args: { title: "" } },
			]),
			turnOf([], "ok"),
		]);
		const registry = { create_issue: makeTool("create_issue") };
		const t = await runLoop(baseOpts(surface, registry));
		expect(t.reason).toBe("completed");
		expect(t.stats.toolErrors).toBe(3);
		const fed = surface.continues[0] ?? [];
		expect(fed[0]?.result).toContain("missing required parameter: title");
		expect(fed[1]?.result).toContain("unknown parameter: bogus");
		expect(fed[2]?.result).toContain("missing required parameter: title");
		for (const r of fed) expect(r.isError).toBe(true);
	});

	it("maxSteps fuse: exits with max_steps_exceeded, never throws", async () => {
		// model asks for a tool every turn, forever
		const loopTurn = turnOf([
			{ id: "c", name: "create_issue", args: { title: "t" } },
		]);
		const surface = scriptedSurface(new Array(20).fill(loopTurn));
		const registry = { create_issue: makeTool("create_issue") };
		const t = await runLoop(baseOpts(surface, registry, { maxSteps: 3 }));
		expect(t.reason).toBe("max_steps_exceeded");
		expect(t.finalText).toBe(null);
		expect(t.stats.steps).toBe(3);
	});

	it("token budget fuse", async () => {
		const bigTurn = turnOf(
			[{ id: "c", name: "create_issue", args: { title: "t" } }],
			null,
			{ inputTokens: 600, outputTokens: 10 },
		);
		const surface = scriptedSurface(new Array(10).fill(bigTurn));
		const registry = { create_issue: makeTool("create_issue") };
		const t = await runLoop(
			baseOpts(surface, registry, { tokenBudgetIn: 1_000 }),
		);
		expect(t.reason).toBe("token_budget_exceeded");
		expect(t.stats.inputTokens).toBe(1200);
	});

	it("context overflow fuse: fail-fast at 0.8× window, no compaction", async () => {
		const bigTurn = turnOf(
			[{ id: "c", name: "create_issue", args: { title: "t" } }],
			null,
			{ inputTokens: 500, outputTokens: 1 },
		);
		const surface = scriptedSurface(new Array(10).fill(bigTurn));
		const registry = { create_issue: makeTool("create_issue") };
		const t = await runLoop(
			baseOpts(surface, registry, { contextWindowTokens: 1_000 }),
		);
		expect(t.reason).toBe("context_overflow");
	});

	it("abort before start → aborted terminal", async () => {
		const ac = new AbortController();
		ac.abort();
		const surface = scriptedSurface([turnOf([], "never")]);
		const t = await runLoop(baseOpts(surface, {}, { signal: ac.signal }));
		expect(t.reason).toBe("aborted");
	});

	it("abort mid-dispatch: dangling calls get synthesized isError results (pairing invariant)", async () => {
		const ac = new AbortController();
		const { audit, events } = recordingAudit();
		const surface = scriptedSurface([
			turnOf([
				{ id: "c1", name: "create_issue", args: { title: "a" } },
				{ id: "c2", name: "create_issue", args: { title: "b" } },
			]),
		]);
		const registry = {
			create_issue: makeTool("create_issue", {}, async () => {
				ac.abort(); // abort fires while the FIRST tool is executing
				return { ok: true, body: "{}" };
			}),
		};
		const t = await runLoop(
			baseOpts(surface, registry, { signal: ac.signal, audit }),
		);
		expect(t.reason).toBe("aborted");
		// the dangling second call was answered locally (audit trail shows it)
		const toolResults = events.filter((e) => e.type === "tool_result");
		expect(toolResults).toHaveLength(2);
		expect(toolResults[1]?.ok).toBe(false);
		// and no further model call happened after the abort
		expect(surface.continues).toHaveLength(0);
	});

	it("tool isError (HTTP 4xx/5xx body) feeds back and the loop continues", async () => {
		const surface = scriptedSurface([
			turnOf([{ id: "c1", name: "create_issue", args: { title: "t" } }]),
			turnOf([{ id: "c2", name: "create_issue", args: { title: "t2" } }]),
			turnOf([], "recovered"),
		]);
		let calls = 0;
		const registry = {
			create_issue: makeTool("create_issue", {}, async () => {
				calls += 1;
				return calls === 1
					? { ok: false, httpStatus: 409, body: '{"error":"dup"}' }
					: { ok: true, httpStatus: 200, body: '{"ok":true}' };
			}),
		};
		const t = await runLoop(baseOpts(surface, registry));
		expect(t.reason).toBe("completed");
		expect(t.finalText).toBe("recovered");
		expect(t.stats.toolErrors).toBe(1);
		expect(surface.continues[0]?.[0]?.isError).toBe(true);
		expect(surface.continues[1]?.[0]?.isError).toBe(false);
	});

	it("tool execute() throw becomes an error result — the loop never throws", async () => {
		const surface = scriptedSurface([
			turnOf([{ id: "c1", name: "create_issue", args: { title: "t" } }]),
			turnOf([], "ok"),
		]);
		const registry = {
			create_issue: makeTool("create_issue", {}, async () => {
				throw new Error("socket hang up");
			}),
		};
		const t = await runLoop(baseOpts(surface, registry));
		expect(t.reason).toBe("completed");
		const fed = surface.continues[0]?.[0];
		expect(fed?.isError).toBe(true);
		expect(fed?.result).toContain("socket hang up");
	});

	it("model_error terminal carries the ORIGINAL error (nothing swallowed)", async () => {
		const surface = scriptedSurface([
			new ModelCallError("quota", "quota exceeded original", 429),
		]);
		const t = await runLoop(baseOpts(surface, {}));
		expect(t.reason).toBe("model_error");
		expect(t.error).toEqual({
			kind: "quota",
			message: "quota exceeded original",
			httpStatus: 429,
		});
	});

	it("AbortedError from the client maps to aborted", async () => {
		const surface = scriptedSurface([new AbortedError()]);
		const t = await runLoop(baseOpts(surface, {}));
		expect(t.reason).toBe("aborted");
	});

	it("oversized tool results are truncated before feedback, audit records pre-truncation size", async () => {
		const { audit } = recordingAudit();
		const bigBody = JSON.stringify({ data: "x".repeat(500) });
		const surface = scriptedSurface([
			turnOf([{ id: "c1", name: "create_issue", args: { title: "t" } }]),
			turnOf([], "ok"),
		]);
		const registry = {
			create_issue: makeTool("create_issue", {}, async () => ({
				ok: true,
				httpStatus: 200,
				body: bigBody,
			})),
		};
		const t = await runLoop(
			baseOpts(surface, registry, { resultCapChars: 100, audit }),
		);
		expect(t.reason).toBe("completed");
		const fed = surface.continues[0]?.[0]?.result ?? "";
		expect(fed.length).toBeLessThan(bigBody.length);
		expect(fed).toMatch(/\[truncated \d+ chars\]/);
	});

	it("dispatch gate ordering: audit line precedes execution (audit-first)", async () => {
		const order: string[] = [];
		const { audit } = recordingAudit();
		const auditSpy: AuditLog = {
			...audit,
			toolDispatch: (...args) => {
				order.push("audit_dispatch");
				audit.toolDispatch(...args);
			},
		};
		const surface = scriptedSurface([
			turnOf([{ id: "c1", name: "create_issue", args: { title: "t" } }]),
			turnOf([], "ok"),
		]);
		const registry = {
			create_issue: makeTool("create_issue", {}, async () => {
				order.push("execute");
				return { ok: true, body: "{}" };
			}),
		};
		await runLoop(baseOpts(surface, registry, { audit: auditSpy }));
		expect(order).toEqual(["audit_dispatch", "execute"]);
	});

	it("emits onEvent step/tool_dispatch/tool_result for entry shells", async () => {
		const events: string[] = [];
		const surface = scriptedSurface([
			turnOf([{ id: "c1", name: "create_issue", args: { title: "t" } }]),
			turnOf([], "ok"),
		]);
		const registry = { create_issue: makeTool("create_issue") };
		await runLoop(
			baseOpts(surface, registry, { onEvent: (e) => events.push(e.type) }),
		);
		expect(events).toEqual(["step", "tool_dispatch", "tool_result", "step"]);
	});
});
