import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../cli.js";
import type { RawGenAi } from "../client.js";
import type { AgentConfig } from "../config.js";
import { assembleSystemPrompt, FIXED_CORE } from "../context.js";
import { runAgentSession } from "../session.js";
import type { AuditLog } from "../types.js";

function noopAudit(): AuditLog & { warnings: string[] } {
	const warnings: string[] = [];
	return {
		warnings,
		sessionStart: () => {},
		modelCall: () => {},
		modelResponse: () => {},
		toolDispatch: () => {},
		toolResult: () => {},
		retry: () => {},
		terminal: () => {},
		warning: (m) => {
			warnings.push(m);
		},
	};
}

describe("assembleSystemPrompt (three-segment system)", () => {
	it("always includes the fixed core with the guardrail language contract", () => {
		const text = assembleSystemPrompt({
			projectName: "flywheel",
			audit: noopAudit(),
		});
		expect(text).toContain(FIXED_CORE);
		expect(text).toContain("request_ship_approval");
		expect(text).toContain("NEVER claim a PR is merged");
		expect(text).toContain("ALWAYS call search_memory first");
		expect(text).toContain("Project: flywheel");
	});

	// FLY-1060 QA F2: the model must KNOW its department label — otherwise it
	// guesses label names when dispatch admission rejects the issue.
	it("documents the auto-applied department label when the binding has one", () => {
		const text = assembleSystemPrompt({
			projectName: "flywheel",
			deptLabel: "Eng",
			audit: noopAudit(),
		});
		expect(text).toContain('Department label: "Eng"');
	});

	it("omits the department-label line when not configured (byte-compat)", () => {
		const text = assembleSystemPrompt({
			projectName: "flywheel",
			audit: noopAudit(),
		});
		expect(text).not.toContain("Department label");
	});

	it("includes the persona segment from identity.md", () => {
		const text = assembleSystemPrompt({
			projectName: "p",
			identityPath: "/x/identity.md",
			readFile: () => "I am Nova, the dispatch persona.",
			audit: noopAudit(),
		});
		expect(text).toContain("## Persona");
		expect(text).toContain("I am Nova");
	});

	it("caps the persona segment at 8000 chars", () => {
		const text = assembleSystemPrompt({
			projectName: "p",
			identityPath: "/x/identity.md",
			readFile: () => "x".repeat(20_000),
			audit: noopAudit(),
		});
		const persona = text.split("## Persona\n")[1]?.split("\n\n")[0] ?? "";
		expect(persona.length).toBeLessThanOrEqual(8_000);
	});

	it("missing identity file degrades with an audit warning, never fatal", () => {
		const audit = noopAudit();
		const text = assembleSystemPrompt({
			projectName: "p",
			identityPath: "/nope/identity.md",
			readFile: () => {
				throw new Error("ENOENT");
			},
			audit,
		});
		expect(text).not.toContain("## Persona");
		expect(audit.warnings[0]).toContain("/nope/identity.md");
	});

	it("appends the entry-injected context note to the project segment", () => {
		const text = assembleSystemPrompt({
			projectName: "geoforge3d",
			contextNote: "eng channel — default topic is Flywheel engineering",
			audit: noopAudit(),
		});
		expect(text).toContain("Project: geoforge3d");
		expect(text).toContain("eng channel — default topic");
	});
});

describe("runAgentSession (facade wiring)", () => {
	let auditDir: string;

	beforeEach(() => {
		auditDir = mkdtempSync(path.join(tmpdir(), "gemini-agent-audit-"));
	});
	afterEach(() => {
		rmSync(auditDir, { recursive: true, force: true });
	});

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
			auditDir,
		};
	}

	/** Interactions fake: one text-only turn (no tool calls). */
	function fakeAi(captured: Array<Record<string, unknown>>): RawGenAi {
		return {
			interactions: {
				create: async (params) => {
					captured.push(params);
					return {
						id: "i1",
						steps: [
							{
								type: "model_output",
								content: [{ type: "text", text: "done" }],
							},
						],
						usage: { total_input_tokens: 5, total_output_tokens: 2 },
					};
				},
			},
			models: {
				generateContent: async () => {
					throw new Error("not used");
				},
			},
		};
	}

	it("runs to completed, writes session_start BEFORE the first model call, persists interaction id", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const { sessionId, terminal } = await runAgentSession({
			config: config(),
			binding: { projectName: "flywheel", leadId: "flywheel-eng-lead" },
			userText: "say done",
			entry: "cli",
			ai: fakeAi(captured),
		});
		expect(terminal.reason).toBe("completed");
		expect(terminal.finalText).toBe("done");
		// the system prompt reached the wire with all three segment anchors
		expect(String(captured[0]?.system_instruction)).toContain(
			"Flywheel dispatch assistant",
		);
		expect(String(captured[0]?.system_instruction)).toContain(
			"Project: flywheel",
		);
		// audit file ordering: session_start line precedes model_call
		const lines = readFileSync(
			path.join(auditDir, `session-${sessionId}.jsonl`),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines[0]?.type).toBe("session_start");
		expect(lines[0]?.userTextDigest).toBe("say done");
		expect(lines[1]?.type).toBe("model_call");
		expect(lines.at(-1)?.type).toBe("terminal");
		// interaction id persisted for --resume
		const state = JSON.parse(
			readFileSync(
				path.join(auditDir, `session-${sessionId}.state.json`),
				"utf8",
			),
		);
		expect(state.lastInteractionId).toBe("i1");
	});

	it("resume: reuses the persisted interaction id as previous_interaction_id", async () => {
		const captured1: Array<Record<string, unknown>> = [];
		const first = await runAgentSession({
			config: config(),
			binding: { projectName: "flywheel", leadId: "flywheel-eng-lead" },
			userText: "start",
			entry: "cli",
			ai: fakeAi(captured1),
		});
		const captured2: Array<Record<string, unknown>> = [];
		await runAgentSession({
			config: config(),
			binding: { projectName: "flywheel", leadId: "flywheel-eng-lead" },
			userText: "continue",
			entry: "cli",
			resumeSessionId: first.sessionId,
			ai: fakeAi(captured2),
		});
		expect(captured2[0]?.previous_interaction_id).toBe("i1");
	});
});

describe("cli parseArgs", () => {
	it("parses command, positional and flags", () => {
		const parsed = parseArgs([
			"run",
			"file an issue",
			"--project",
			"flywheel",
			"--lead",
			"flywheel-eng-lead",
			"--resume",
			"abc123",
		]);
		expect(parsed.command).toBe("run");
		expect(parsed.positional).toEqual(["file an issue"]);
		expect(parsed.flags).toEqual({
			project: "flywheel",
			lead: "flywheel-eng-lead",
			resume: "abc123",
		});
	});

	it("handles a valueless trailing flag", () => {
		const parsed = parseArgs(["run", "x", "--verbose"]);
		expect(parsed.flags.verbose).toBe("");
	});
});
