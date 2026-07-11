/**
 * FLY-1018 voice phase — /gemini-advanced deep-dispatch injection:
 *   - config: optional huddle.assistant.advanced block (leadId required,
 *     blank optionals fail fast, absent = byte-compatible undefined);
 *   - formatSpokenAnnouncement: short spoken copy for both terminals;
 *   - buildAdvancedDelegateTool: fail-fast on incomplete deep-agent env,
 *     delegate_task LiveToolSpec wired to the session binding, completion
 *     spoken via the injected speak channel (+ optional text fallback).
 */

import { describe, expect, it, vi } from "vitest";
import {
	buildAdvancedDelegateTool,
	formatSpokenAnnouncement,
} from "../assistant/advanced.js";
import { resolveAssistantConfig } from "../assistant/config.js";

function rawProjects(assistant: Record<string, unknown>) {
	return [{ huddle: { assistant } }];
}

const AGENT_ENV = {
	FLYWHEEL_GEMINI_AGENT: "1",
	GEMINI_API_KEY: "test-key",
	FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9",
	FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN: "scoped-test",
} as NodeJS.ProcessEnv;

function completedTerminal(finalText: string | null) {
	return {
		reason: "completed" as const,
		finalText,
		stats: {
			sessionId: "t1",
			steps: 1,
			toolCalls: 1,
			toolErrors: 0,
			hallucinatedToolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			durationMs: 1,
			model: "m",
			surface: "interactions",
		},
	};
}

describe("assistant.advanced config (FLY-1018 voice phase)", () => {
	it("absent → advanced stays undefined (byte-compat)", () => {
		const cfg = resolveAssistantConfig(rawProjects({}), {});
		expect(cfg?.advanced).toBeUndefined();
	});

	it("parses leadId/deptLabel/identityPath trimmed", () => {
		const cfg = resolveAssistantConfig(
			rawProjects({
				advanced: {
					leadId: " qa-lead ",
					deptLabel: " Ops-Test ",
					identityPath: " /x/identity.md ",
				},
			}),
			{},
		);
		expect(cfg?.advanced).toEqual({
			leadId: "qa-lead",
			commandName: "gemini-advanced",
			deptLabel: "Ops-Test",
			identityPath: "/x/identity.md",
		});
	});

	// FLY-1159 founder correction (2026-07-11): the delegate mounts on its OWN
	// voice command — /gemini stays plain. advanced.commandName names it.
	it("advanced.commandName defaults to gemini-advanced (the separate voice command)", () => {
		const cfg = resolveAssistantConfig(
			rawProjects({ advanced: { leadId: "qa-lead" } }),
			{},
		);
		expect(cfg?.advanced?.commandName).toBe("gemini-advanced");
	});

	it("advanced.commandName is configurable and trimmed", () => {
		const cfg = resolveAssistantConfig(
			rawProjects({ advanced: { leadId: "qa-lead", commandName: " ga-x " } }),
			{},
		);
		expect(cfg?.advanced?.commandName).toBe("ga-x");
	});

	it("advanced.commandName colliding with the plain commandName fails fast — /gemini never carries the delegate", () => {
		expect(() =>
			resolveAssistantConfig(
				rawProjects({ advanced: { leadId: "qa-lead", commandName: "gemini" } }),
				{},
			),
		).toThrow(/must differ/);
		expect(() =>
			resolveAssistantConfig(
				rawProjects({
					commandName: "voz",
					advanced: { leadId: "qa-lead", commandName: "voz" },
				}),
				{},
			),
		).toThrow(/must differ/);
	});

	it("rejects a blank advanced.commandName when present", () => {
		expect(() =>
			resolveAssistantConfig(
				rawProjects({ advanced: { leadId: "qa-lead", commandName: " " } }),
				{},
			),
		).toThrow(/commandName/);
	});

	it("requires leadId (the explicit dispatch Lead — never inferred)", () => {
		expect(() =>
			resolveAssistantConfig(rawProjects({ advanced: {} }), {}),
		).toThrow(/advanced\.leadId/);
	});

	it("rejects a blank deptLabel when present", () => {
		expect(() =>
			resolveAssistantConfig(
				rawProjects({ advanced: { leadId: "qa-lead", deptLabel: " " } }),
				{},
			),
		).toThrow(/deptLabel/);
	});

	it("rejects a non-object advanced block", () => {
		expect(() =>
			resolveAssistantConfig(rawProjects({ advanced: "yes" }), {}),
		).toThrow(/advanced/);
	});
});

describe("formatSpokenAnnouncement", () => {
	it("speaks the completed result with the task id", () => {
		const text = formatSpokenAnnouncement(
			"abc123",
			completedTerminal("建好了 FLY-9"),
		);
		expect(text).toContain("abc123");
		expect(text).toContain("完成");
		expect(text).toContain("建好了 FLY-9");
	});

	it("caps a long result for speech", () => {
		const text = formatSpokenAnnouncement(
			"abc123",
			completedTerminal("x".repeat(2000)),
		);
		expect(text.length).toBeLessThan(400);
	});

	it("reports a non-completed terminal honestly (reason, no fake success)", () => {
		const text = formatSpokenAnnouncement("abc123", {
			...completedTerminal(null),
			reason: "max_steps" as const,
		});
		expect(text).toContain("未完成");
		expect(text).toContain("max_steps");
		expect(text).not.toContain("完成:");
	});
});

describe("buildAdvancedDelegateTool", () => {
	const advanced = { leadId: "qa-lead", deptLabel: "Ops-Test" };

	it("fails fast with fix guidance when the deep-agent env is incomplete", () => {
		expect(() =>
			buildAdvancedDelegateTool({
				advanced,
				projectName: "geoforge3d",
				env: {},
				speak: () => {},
				log: () => {},
			}),
		).toThrow(/FLYWHEEL_GEMINI_AGENT/);
	});

	it("returns the delegate_task LiveToolSpec", () => {
		const tool = buildAdvancedDelegateTool({
			advanced,
			projectName: "geoforge3d",
			env: AGENT_ENV,
			speak: () => {},
			log: () => {},
		});
		expect(tool.declaration.name).toBe("delegate_task");
	});

	it("speaks the completion through the injected channel; binding reaches the session", async () => {
		const speak = vi.fn();
		const seen: Array<Record<string, unknown>> = [];
		const tool = buildAdvancedDelegateTool({
			advanced,
			projectName: "geoforge3d",
			env: AGENT_ENV,
			speak,
			log: () => {},
			_test: {
				runSession: async (opts) => {
					seen.push(opts.binding as unknown as Record<string, unknown>);
					return { sessionId: "task9", terminal: completedTerminal("搞定") };
				},
				newTaskId: () => "task9",
				appendAudit: () => {},
			},
		});
		const ack = await tool.handler(
			{ instruction: "建个票" },
			{ signal: new AbortController().signal },
		);
		expect(String(ack)).toContain("task9");
		await vi.waitFor(() => {
			expect(speak).toHaveBeenCalledWith(expect.stringContaining("搞定"));
		});
		expect(seen[0]).toEqual({
			projectName: "geoforge3d",
			leadId: "qa-lead",
			deptLabel: "Ops-Test",
		});
	});

	it("a throwing speak channel is contained (logged, never unhandled)", async () => {
		const log = vi.fn();
		const tool = buildAdvancedDelegateTool({
			advanced,
			projectName: "geoforge3d",
			env: AGENT_ENV,
			speak: () => {
				throw new Error("live session gone");
			},
			log,
			_test: {
				runSession: async () => ({
					sessionId: "t2",
					terminal: completedTerminal("ok"),
				}),
				newTaskId: () => "t2",
				appendAudit: () => {},
			},
		});
		await tool.handler(
			{ instruction: "x" },
			{ signal: new AbortController().signal },
		);
		await vi.waitFor(() => {
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("live session gone"),
			);
		});
	});

	it("text fallback is UNCONDITIONAL — lands even when speak silently no-ops (mid-rotation / post-meeting window, Codex R1)", async () => {
		// TalkSessionRotator.sendText silently no-ops while the current session
		// is null (rotation in flight) and after the meeting closed — the spoken
		// announce can vanish without an error. The Discord-text landing must
		// not depend on speak outcome in any way.
		const sent: string[] = [];
		let spoke = 0;
		const tool = buildAdvancedDelegateTool({
			advanced,
			projectName: "geoforge3d",
			env: AGENT_ENV,
			speak: () => {
				spoke++; // swallowed by a session-less rotator in production
			},
			log: () => {},
			sendText: async (content) => {
				sent.push(content);
			},
			_test: {
				runSession: async () => ({
					sessionId: "t4",
					terminal: completedTerminal("落地结果"),
				}),
				newTaskId: () => "t4",
				appendAudit: () => {},
			},
		});
		await tool.handler(
			{ instruction: "x" },
			{ signal: new AbortController().signal },
		);
		await vi.waitFor(() => {
			expect(sent.join("\n")).toContain("落地结果");
		});
		expect(spoke).toBe(1); // spoken attempted too — text is not a mere backup branch
	});

	it("optional text fallback receives the full outcome", async () => {
		const sent: string[] = [];
		const tool = buildAdvancedDelegateTool({
			advanced,
			projectName: "geoforge3d",
			env: AGENT_ENV,
			speak: () => {},
			log: () => {},
			sendText: async (content) => {
				sent.push(content);
			},
			_test: {
				runSession: async () => ({
					sessionId: "t3",
					terminal: completedTerminal("全文结果"),
				}),
				newTaskId: () => "t3",
				appendAudit: () => {},
			},
		});
		await tool.handler(
			{ instruction: "x" },
			{ signal: new AbortController().signal },
		);
		await vi.waitFor(() => {
			expect(sent.join("\n")).toContain("全文结果");
		});
	});
});
