import type { LiveToolSpec } from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import {
	createDelegateTool,
	createDiscordCompletionSink,
	type DelegateToolOptions,
} from "../delegate.js";
import type { SessionResult } from "../session.js";
import type { Terminal } from "../types.js";

function config(): AgentConfig {
	return {
		apiKey: "k",
		modelTier: "flash",
		model: "gemini-3.5-flash",
		surface: "interactions",
		maxSteps: 12,
		tokenBudgetIn: 200_000,
		tokenBudgetOut: 20_000,
		toolTimeoutMs: 1_000,
		resultCapChars: 16_000,
		bridgeUrl: "http://127.0.0.1:1",
		bridgeToken: "t",
		auditDir: "/tmp/unused",
	};
}

function terminalOf(
	reason: Terminal["reason"],
	finalText: string | null,
): Terminal {
	return {
		reason,
		finalText,
		stats: {
			sessionId: "t",
			steps: 1,
			toolCalls: 1,
			toolErrors: 0,
			hallucinatedToolCalls: 0,
			inputTokens: 1,
			outputTokens: 1,
			durationMs: 1,
			model: "m",
			surface: "interactions",
		},
	};
}

function makeTool(overrides: Partial<DelegateToolOptions> = {}) {
	const auditLines: string[] = [];
	const completions: Array<{ taskId: string; terminal: Terminal }> = [];
	let resolveSession: ((r: SessionResult) => void) | undefined;
	const sessionGate = new Promise<SessionResult>((r) => {
		resolveSession = r;
	});
	const runSession = vi.fn(async () => sessionGate);
	const tool = createDelegateTool({
		config: config(),
		binding: { projectName: "flywheel", leadId: "flywheel-eng-lead" },
		contextNote: "voice huddle",
		onComplete: (taskId, terminal) => {
			completions.push({ taskId, terminal });
		},
		runSession,
		newTaskId: () => "task1234",
		appendAudit: (line) => {
			auditLines.push(line);
		},
		...overrides,
	});
	return { tool, auditLines, completions, runSession, resolveSession };
}

describe("createDelegateTool (M3 seam)", () => {
	it("shape is voice-core LiveToolSpec compatible (type-level + structural)", () => {
		const { tool } = makeTool();
		// type-level: assignment compiles against the real voice-core type
		const spec: LiveToolSpec = tool;
		expect(spec.declaration.name).toBe("delegate_task");
		expect(typeof spec.handler).toBe("function");
		expect(spec.declaration.parameters).toMatchObject({
			type: "OBJECT",
			required: ["instruction"],
		});
	});

	it("ACKs immediately WITHOUT waiting for the deep session", async () => {
		const { tool, runSession, completions } = makeTool();
		const ack = await tool.handler(
			{ instruction: "file an issue about the printer" },
			{ signal: new AbortController().signal },
		);
		expect(ack).toBe("已受理,任务 task1234,完成后另行播报。");
		expect(runSession).toHaveBeenCalledTimes(1);
		// deep session still running — no completion yet
		expect(completions).toHaveLength(0);
	});

	it("writes delegate_accept to the audit BEFORE returning the ACK", async () => {
		const { tool, auditLines } = makeTool();
		await tool.handler(
			{ instruction: "do it" },
			{ signal: new AbortController().signal },
		);
		const line = JSON.parse(auditLines[0] ?? "");
		expect(line.type).toBe("delegate_accept");
		expect(line.taskId).toBe("task1234");
		expect(line.instructionDigest).toBe("do it");
	});

	it("onComplete fires asynchronously with the terminal once the deep session ends", async () => {
		const { tool, completions, resolveSession } = makeTool();
		await tool.handler(
			{ instruction: "dispatch a runner" },
			{ signal: new AbortController().signal },
		);
		resolveSession?.({
			sessionId: "task1234",
			terminal: terminalOf("completed", "runner dispatched, exec-1"),
		});
		await vi.waitFor(() => {
			expect(completions).toHaveLength(1);
		});
		expect(completions[0]).toMatchObject({
			taskId: "task1234",
			terminal: { reason: "completed" },
		});
	});

	it("passes binding + context through to the deep session", async () => {
		const { tool, runSession } = makeTool();
		await tool.handler(
			{ instruction: "check status", context: "we were talking about FLY-9" },
			{ signal: new AbortController().signal },
		);
		expect(runSession).toHaveBeenCalledWith(
			expect.objectContaining({
				binding: { projectName: "flywheel", leadId: "flywheel-eng-lead" },
				entry: "delegate",
				sessionId: "task1234",
				userText: expect.stringContaining("we were talking about FLY-9"),
			}),
		);
	});

	it("pre-ACK abort cancels preparation: no deep session, cancellation audited", async () => {
		const { tool, runSession, auditLines } = makeTool();
		const ac = new AbortController();
		ac.abort();
		const out = await tool.handler(
			{ instruction: "do it" },
			{ signal: ac.signal },
		);
		expect(out).toContain("已取消");
		expect(runSession).not.toHaveBeenCalled();
		const line = JSON.parse(auditLines[0] ?? "");
		expect(line.type).toBe("delegate_cancellation");
	});

	it("missing instruction is refused with a spoken-friendly error (no task started)", async () => {
		const { tool, runSession } = makeTool();
		const out = await tool.handler(
			{ context: "just vibes" },
			{ signal: new AbortController().signal },
		);
		expect(out).toContain("缺少 instruction");
		expect(runSession).not.toHaveBeenCalled();
	});

	it("a runSession THROW still reaches the sink as a model_error terminal (never vanishes)", async () => {
		const completions: Array<{ taskId: string; terminal: Terminal }> = [];
		const tool = createDelegateTool({
			config: config(),
			binding: { projectName: "p", leadId: "l" },
			onComplete: (taskId, terminal) => {
				completions.push({ taskId, terminal });
			},
			runSession: vi.fn().mockRejectedValue(new Error("bug-class boom")),
			newTaskId: () => "tX",
			appendAudit: () => {},
		});
		await tool.handler(
			{ instruction: "do it" },
			{ signal: new AbortController().signal },
		);
		await vi.waitFor(() => {
			expect(completions).toHaveLength(1);
		});
		expect(completions[0]?.terminal.reason).toBe("model_error");
		expect(completions[0]?.terminal.error?.message).toContain("bug-class boom");
	});
});

describe("createDiscordCompletionSink", () => {
	it("completed → ✅ message with the final text, chunked", async () => {
		const sent: string[] = [];
		const sink = createDiscordCompletionSink(async (c) => {
			sent.push(c);
		});
		await sink("task1234", terminalOf("completed", "issue FLY-99 created"));
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("✅ 任务 task1234 完成");
		expect(sent[0]).toContain("issue FLY-99 created");
	});

	it("long completed output is chunked to Discord limits", async () => {
		const sent: string[] = [];
		const sink = createDiscordCompletionSink(async (c) => {
			sent.push(c);
		});
		await sink("t", terminalOf("completed", "x".repeat(4500)));
		expect(sent.length).toBeGreaterThan(1);
		for (const s of sent) expect(s.length).toBeLessThanOrEqual(2000);
	});

	it("non-completed → ⚠️ honest failure message with reason + audit pointer", async () => {
		const sent: string[] = [];
		const sink = createDiscordCompletionSink(async (c) => {
			sent.push(c);
		});
		const terminal: Terminal = {
			...terminalOf("model_error", null),
			error: { kind: "quota", message: "quota exhausted" },
		};
		await sink("task9", terminal);
		expect(sent[0]).toContain("⚠️ 任务 task9 未完成(model_error)");
		expect(sent[0]).toContain("quota exhausted");
		expect(sent[0]).toContain("session task9");
	});
});
