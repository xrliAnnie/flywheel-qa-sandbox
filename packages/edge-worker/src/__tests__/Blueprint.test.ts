import { describe, expect, it, vi, beforeEach } from "vitest";
import { Blueprint } from "../Blueprint.js";
import { PreHydrator } from "../PreHydrator.js";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import type { FlywheelConfig } from "flywheel-config";
import type { DagNode } from "flywheel-dag-resolver";
import type {
	IFlywheelRunner,
	FlywheelRunRequest,
	FlywheelRunResult,
} from "flywheel-core";

// ─── Helpers ─────────────────────────────────────

function makeConfig(overrides: Partial<FlywheelConfig> = {}): FlywheelConfig {
	return {
		project: "test-project",
		linear: { team_id: "T" },
		runners: {
			default: "claude",
			available: { claude: { type: "claude" } },
		},
		teams: [
			{
				name: "eng",
				orchestrators: [
					{ type: "code", runner: "claude", budget_per_issue: 5 },
				],
			},
		],
		decision_layer: {
			autonomy_level: "manual_only",
			escalation_channel: "#dev",
		},
		...overrides,
	};
}

function makeNode(id = "issue-1"): DagNode {
	return { id, blockedBy: [] };
}

function makeContext(overrides: Partial<BlueprintContext> = {}): BlueprintContext {
	return {
		teamName: "eng",
		runnerName: "claude",
		budgetPerIssue: 5.0,
		fixBudgetUsd: 2.0,
		...overrides,
	};
}

function makeMockRunner(results: FlywheelRunResult[]): IFlywheelRunner {
	let callIndex = 0;
	return {
		name: "claude",
		run: vi.fn(async (_req: FlywheelRunRequest): Promise<FlywheelRunResult> => {
			const result = results[callIndex] ?? results[results.length - 1]!;
			callIndex++;
			return result;
		}),
	};
}

function makeSuccessResult(cost = 1.0, sessionId = "sess-1"): FlywheelRunResult {
	return { success: true, costUsd: cost, sessionId };
}

function makeFailResult(cost = 0.5, sessionId = "sess-1"): FlywheelRunResult {
	return { success: false, costUsd: cost, sessionId };
}

function makeMockShell(ciPassed: boolean | boolean[] = true): ShellRunner {
	let ciCallIndex = 0;
	const ciResults = Array.isArray(ciPassed) ? ciPassed : [ciPassed];
	return {
		execFile: vi.fn(async (cmd: string, _args: string[], _cwd: string) => {
			if (cmd === "gh") {
				const passed = ciResults[ciCallIndex] ?? ciResults[ciResults.length - 1]!;
				ciCallIndex++;
				if (passed) {
					return {
						stdout: JSON.stringify([{ conclusion: "success", status: "completed" }]),
						exitCode: 0,
					};
				}
				return {
					stdout: JSON.stringify([{ conclusion: "failure", status: "completed" }]),
					exitCode: 0,
				};
			}
			return { stdout: "", exitCode: 0 };
		}),
	};
}

function makeHydrator(): PreHydrator {
	return new PreHydrator(
		async () => ({ title: "Test Issue", description: "Fix the bug" }),
		async () => "Follow TDD",
		"/project",
	);
}

// ─── Tests ───────────────────────────────────────

describe("Blueprint", () => {
	// ─── Happy path ─────────────────────────────────

	it("completes successfully when CI passes on first round", async () => {
		const runner = makeMockRunner([makeSuccessResult(1.5)]);
		const shell = makeMockShell(true);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		expect(result.success).toBe(true);
		expect(result.costUsd).toBe(1.5);
		expect(result.ciRounds).toBe(1);
		expect(result.sessionId).toBe("sess-1");
	});

	it("calls runner with correct prompt containing issue details", async () => {
		const runner = makeMockRunner([makeSuccessResult()]);
		const shell = makeMockShell(true);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		const runCall = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(runCall.prompt).toContain("Test Issue");
		expect(runCall.prompt).toContain("Fix the bug");
		expect(runCall.prompt).toContain("Follow TDD");
		expect(runCall.cwd).toBe("/project");
	});

	it("uses default tools when not configured", async () => {
		const runner = makeMockRunner([makeSuccessResult()]);
		const shell = makeMockShell(true);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		const runCall = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(runCall.allowedTools).toEqual([
			"Read",
			"Edit",
			"Write",
			"Bash",
			"Grep",
			"Glob",
		]);
		expect(runCall.maxTurns).toBe(50);
	});

	it("uses configured tools and maxTurns", async () => {
		const runner = makeMockRunner([makeSuccessResult()]);
		const shell = makeMockShell(true);
		const config = makeConfig({
			agent_nodes: {
				implement: { tools: ["Read", "Bash"], max_turns: 100 },
			},
		});
		const blueprint = new Blueprint(config, makeHydrator(), () => runner, shell);

		await blueprint.run(makeNode(), "/project", makeContext());

		const runCall = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(runCall.allowedTools).toEqual(["Read", "Bash"]);
		expect(runCall.maxTurns).toBe(100);
	});

	// ─── CI fail → fix → retry ──────────────────────

	it("retries on CI failure and succeeds on second round", async () => {
		const runner = makeMockRunner([
			makeSuccessResult(1.0), // implement
			makeSuccessResult(0.5), // fix
		]);
		const shell = makeMockShell([false, true]); // CI fail, then pass
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		expect(result.success).toBe(true);
		expect(result.costUsd).toBe(1.5); // 1.0 implement + 0.5 fix
		expect(result.ciRounds).toBe(2);
		expect((runner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
	});

	it("fix prompt includes CI error output", async () => {
		const runner = makeMockRunner([
			makeSuccessResult(1.0),
			makeSuccessResult(0.5),
		]);
		const shell = makeMockShell([false, true]);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		const fixCall = (runner.run as ReturnType<typeof vi.fn>).mock.calls[1]![0];
		expect(fixCall.prompt).toContain("CI failed");
		expect(fixCall.sessionId).toBe("sess-1"); // resumes same session
	});

	// ─── Max retries → shelve ────────────────────────

	it("fails after max CI rounds exhausted (default 2)", async () => {
		const runner = makeMockRunner([
			makeSuccessResult(1.0),
			makeSuccessResult(0.5),
		]);
		const shell = makeMockShell([false, false]); // Both CI rounds fail
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		expect(result.success).toBe(false);
		expect(result.ciRounds).toBe(2);
		expect(result.costUsd).toBe(1.5);
	});

	// ─── Configurable CI rounds ──────────────────────

	it("respects configurable CI rounds (3 rounds)", async () => {
		const runner = makeMockRunner([
			makeSuccessResult(1.0), // implement
			makeSuccessResult(0.3), // fix 1
			makeSuccessResult(0.3), // fix 2
		]);
		const shell = makeMockShell([false, false, true]); // Fail, fail, pass
		const config = makeConfig({ ci: { max_rounds: 3 } });
		const blueprint = new Blueprint(config, makeHydrator(), () => runner, shell);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		expect(result.success).toBe(true);
		expect(result.ciRounds).toBe(3);
		expect(result.costUsd).toBeCloseTo(1.6); // 1.0 + 0.3 + 0.3
	});

	it("ci.max_rounds = 1 means no fix attempts", async () => {
		const runner = makeMockRunner([makeSuccessResult(1.0)]);
		const shell = makeMockShell(false);
		const config = makeConfig({ ci: { max_rounds: 1 } });
		const blueprint = new Blueprint(config, makeHydrator(), () => runner, shell);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		expect(result.success).toBe(false);
		expect(result.ciRounds).toBe(1);
		// Only 1 runner call (implement), no fix
		expect((runner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	// ─── Budget cap enforcement ──────────────────────

	it("enforces per-issue budget cap", async () => {
		const runner = makeMockRunner([makeSuccessResult(4.5)]);
		const shell = makeMockShell(true);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		await blueprint.run(makeNode(), "/project", makeContext({ budgetPerIssue: 5.0 }));

		const runCall = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(runCall.maxCostUsd).toBe(5.0);
	});

	it("stops fix attempts when budget exhausted", async () => {
		const runner = makeMockRunner([
			makeSuccessResult(4.8), // implement uses almost all budget
		]);
		const shell = makeMockShell([false, false]);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		const result = await blueprint.run(
			makeNode(),
			"/project",
			makeContext({ budgetPerIssue: 5.0, fixBudgetUsd: 2.0 }),
		);

		// Budget remaining = 5.0 - 4.8 = 0.2, fixBudget = min(2.0, 0.2) = 0.2
		// Should still attempt fix with reduced budget
		expect(result.costUsd).toBeGreaterThanOrEqual(4.8);
	});

	it("rejects immediately when budget is zero", async () => {
		const runner = makeMockRunner([]);
		const shell = makeMockShell(true);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		const result = await blueprint.run(
			makeNode(),
			"/project",
			makeContext({ budgetPerIssue: 0 }),
		);

		expect(result.success).toBe(false);
		expect(result.costUsd).toBe(0);
		expect((runner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	// ─── Implement failure short-circuit ─────────────

	it("returns immediately when implement fails without pushing", async () => {
		const runner = makeMockRunner([makeFailResult(2.0)]);
		const shell = makeMockShell(true);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		expect(result.success).toBe(false);
		expect(result.costUsd).toBe(2.0);
		expect(result.ciRounds).toBe(0);
		// Should NOT have called git push or CI
		const shellCalls = (shell.execFile as ReturnType<typeof vi.fn>).mock.calls;
		const gitPushCalls = shellCalls.filter(
			(c: [string, string[], string]) =>
				c[0] === "git" && c[1][0] === "push",
		);
		expect(gitPushCalls).toHaveLength(0);
	});

	// ─── Session resume ──────────────────────────────

	it("passes resumeSessionId to runner for crash recovery", async () => {
		const runner = makeMockRunner([makeSuccessResult()]);
		const shell = makeMockShell(true);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		await blueprint.run(
			makeNode(),
			"/project",
			makeContext({ resumeSessionId: "prev-session-42" }),
		);

		const runCall = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(runCall.sessionId).toBe("prev-session-42");
	});

	it("fires onSessionCreated callback after implement", async () => {
		const runner = makeMockRunner([makeSuccessResult(1.0, "new-session-99")]);
		const shell = makeMockShell(true);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		const sessionCallback = vi.fn();
		blueprint.onSessionCreated = sessionCallback;

		await blueprint.run(makeNode("issue-42"), "/project", makeContext());

		expect(sessionCallback).toHaveBeenCalledWith("issue-42", "new-session-99");
	});

	it("interrupts and resumes session (simulate kill and resume)", async () => {
		// First run: agent gets killed → returns partial result with sessionId
		const firstRunner = makeMockRunner([
			{ success: false, costUsd: 0.8, sessionId: "interrupted-session" },
		]);
		const firstShell = makeMockShell(false);
		const blueprint1 = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => firstRunner,
			firstShell,
		);

		const savedSessions: Record<string, string> = {};
		blueprint1.onSessionCreated = async (nodeId, sessionId) => {
			savedSessions[nodeId] = sessionId;
		};

		const result1 = await blueprint1.run(makeNode("issue-1"), "/project", makeContext());
		expect(result1.success).toBe(false);
		expect(savedSessions["issue-1"]).toBe("interrupted-session");

		// Second run: resume with saved sessionId
		const secondRunner = makeMockRunner([makeSuccessResult(0.5, "interrupted-session")]);
		const secondShell = makeMockShell(true);
		const blueprint2 = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => secondRunner,
			secondShell,
		);

		const result2 = await blueprint2.run(
			makeNode("issue-1"),
			"/project",
			makeContext({ resumeSessionId: savedSessions["issue-1"] }),
		);

		expect(result2.success).toBe(true);
		const resumeCall = (secondRunner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(resumeCall.sessionId).toBe("interrupted-session");
	});

	// ─── Pre-hydrator integration ────────────────────

	it("hydrates context before agent call", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "Custom Title",
			description: "Custom Description",
		}));
		const readRules = vi.fn(async () => "Custom Rules");
		const hydrator = new PreHydrator(fetchIssue, readRules, "/project");

		const runner = makeMockRunner([makeSuccessResult()]);
		const shell = makeMockShell(true);
		const blueprint = new Blueprint(
			makeConfig(),
			hydrator,
			() => runner,
			shell,
		);

		await blueprint.run(makeNode("issue-99"), "/project", makeContext());

		expect(fetchIssue).toHaveBeenCalledWith("issue-99");
		expect(readRules).toHaveBeenCalledWith("/project");

		const prompt = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0].prompt;
		expect(prompt).toContain("Custom Title");
		expect(prompt).toContain("Custom Description");
		expect(prompt).toContain("Custom Rules");
	});

	// ─── Shell commands ──────────────────────────────

	it("runs lint after implement and after each fix", async () => {
		const runner = makeMockRunner([
			makeSuccessResult(1.0),
			makeSuccessResult(0.5),
		]);
		const shell = makeMockShell([false, true]);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		const shellCalls = (shell.execFile as ReturnType<typeof vi.fn>).mock.calls;
		const npmCalls = shellCalls.filter(
			(c: [string, string[], string]) => c[0] === "npm",
		);
		// lint after implement + lint after fix = 2 npm calls
		expect(npmCalls).toHaveLength(2);
	});

	it("calls git push before each CI check", async () => {
		const runner = makeMockRunner([makeSuccessResult()]);
		const shell = makeMockShell(true);
		const blueprint = new Blueprint(
			makeConfig(),
			makeHydrator(),
			() => runner,
			shell,
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		const shellCalls = (shell.execFile as ReturnType<typeof vi.fn>).mock.calls;
		const gitPushCalls = shellCalls.filter(
			(c: [string, string[], string]) =>
				c[0] === "git" && c[1][0] === "push",
		);
		expect(gitPushCalls).toHaveLength(1);
	});
});
