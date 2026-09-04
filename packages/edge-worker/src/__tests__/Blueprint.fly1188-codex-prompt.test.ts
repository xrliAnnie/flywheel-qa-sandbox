/**
 * FLY-1188 M2 — codex-flavored prompt assembly (plan §4.2).
 *
 * A codex-tmux runner's Blueprint-generated system prompt must carry NO
 * Claude-only tooling references (banned tokens: "SendMessage",
 * "Claude-in-Chrome", "/compact", the Skill-tool onboard step) — each is
 * either dropped or replaced by a capability-honest codex equivalent. Role
 * files stay verbatim but get a fixed ENVIRONMENT TRANSLATION header. The
 * claude path stays byte-compatible (guarded here by a full-prompt snapshot
 * with the machine-dependent CLI path normalized).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerMemoryMode } from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import {
	buildRunnerMemoryPromptSection,
	prepareRunnerMemoryMount,
} from "../runner-memory.js";
import type { WorktreeManager } from "../WorktreeManager.js";
import { resolvedTestAgent } from "./agent-dispatch-fixtures.js";

const BANNED_IN_CODEX_PROMPT = [
	"SendMessage",
	"Claude-in-Chrome",
	"/compact",
	// Codex M2 review LOW-1: the codex adapter has no PostToolUse hook.
	"PostToolUse",
	// FLY-1188 M4 (Codex R2 HIGH): a resident /goal runner is never auto-resumed
	// on a gate — the codex gate branches poll `check`, they never promise resume.
	"resumed automatically",
];

function makeNode(id = "FLY-1188"): DagNode {
	return { id, blockedBy: [] };
}
function makeHydrator() {
	return new PreHydrator(async (id) => ({
		title: `Issue ${id} title`,
		description: `Description for ${id}`,
		labels: [],
	}));
}
function makeMockGitChecker() {
	return {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "abc123"),
		check: vi.fn(async () => ({
			hasNewCommits: true,
			commitCount: 1,
			filesChanged: 1,
			commitMessages: ["feat: x"],
		})),
	} as unknown as GitResultChecker;
}
function makeMockShell(): ShellRunner {
	return { execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })) };
}
function makeMockAdapter(): IAdapter {
	return {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(
			async (
				_ctx: AdapterExecutionContext,
			): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "sess-uuid",
				tmuxWindow: "flywheel:@42",
				durationMs: 100,
			}),
		),
	};
}
function makeRealWorktree(): string {
	const p = join(
		tmpdir(),
		`fly1188-m2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(p, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: p });
	return p;
}
function makeWtManager(worktreePath: string) {
	return {
		expectedWorktree: vi.fn(() => ({
			path: worktreePath,
			branch: "flywheel-FLY-1188",
		})),
		isRegistered: vi.fn(async () => false),
		removeIfExists: vi.fn(async () => true),
		create: vi.fn(async () => ({
			projectName: "proj",
			issueId: "FLY-1188",
			worktreePath,
			branch: "flywheel-FLY-1188",
			mainRepoPath: "/tmp/fly1188-main",
		})),
	} as unknown as WorktreeManager;
}

const CHECKPOINTS = {
	brainstorm: { enabled: true },
	question: { enabled: true },
	approve_to_ship: { enabled: true },
};

const cleanups: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	while (cleanups.length) {
		rmSync(cleanups.pop() as string, { recursive: true, force: true });
	}
});

function deterministicMemoryPreparer(
	input: Parameters<typeof prepareRunnerMemoryMount>[0],
) {
	const root = process.env.FLYWHEEL_RUNNER_MEMORY_ROOT as string;
	return prepareRunnerMemoryMount({
		...input,
		managedSettings: {
			managedFile: `${root}.fly1188-absent-managed.json`,
			managedDropinDir: `${root}.fly1188-absent-managed.d`,
		},
	});
}

function makeBlueprint(input: {
	adapter: IAdapter;
	worktreeManager?: WorktreeManager;
	dispatcher?: unknown;
	checkpointConfig: Record<string, { enabled?: boolean }>;
	memoryMode?: RunnerMemoryMode;
}): Blueprint {
	return Reflect.construct(Blueprint, [
		makeHydrator(),
		makeMockGitChecker(),
		() => input.adapter,
		makeMockShell(),
		input.worktreeManager,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		input.dispatcher,
		input.checkpointConfig,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		() => ({
			hasOverride: true,
			raw: input.memoryMode ?? "off",
		}),
		deterministicMemoryPreparer,
	]) as Blueprint;
}

async function buildPromptWithContext(opts: {
	ctxOverrides?: Partial<BlueprintContext>;
	worktreePath?: string;
	checkpointConfig?: Record<string, { enabled?: boolean }>;
	memoryMode?: RunnerMemoryMode;
}): Promise<{ prompt: string; adapterContext: AdapterExecutionContext }> {
	const adapter = makeMockAdapter();
	const blueprint = makeBlueprint({
		adapter,
		worktreeManager: opts.worktreePath
			? makeWtManager(opts.worktreePath)
			: undefined,
		checkpointConfig: opts.checkpointConfig ?? CHECKPOINTS,
		memoryMode: opts.memoryMode,
	});
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "runner",
		leadId: "flywheel-eng-lead",
		projectName: "proj",
		...opts.ctxOverrides,
	};
	await blueprint.run(makeNode(), "/tmp/fly1188-m2-project", ctx);
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]?.[0] as AdapterExecutionContext | undefined;
	expect(call).toBeDefined();
	return {
		prompt: call?.appendSystemPrompt ?? "",
		adapterContext: call as AdapterExecutionContext,
	};
}

async function buildPrompt(opts: {
	ctxOverrides?: Partial<BlueprintContext>;
	worktreePath?: string;
	checkpointConfig?: Record<string, { enabled?: boolean }>;
	memoryMode?: RunnerMemoryMode;
}): Promise<string> {
	return (await buildPromptWithContext(opts)).prompt;
}

async function buildCodexPrompt(
	ctxOverrides: Partial<BlueprintContext> = {},
): Promise<string> {
	const wt = makeRealWorktree();
	cleanups.push(wt);
	return buildPrompt({
		worktreePath: wt,
		ctxOverrides: { runnerBackend: "codex-tmux", ...ctxOverrides },
	});
}

function normalizePromptForSnapshot(prompt: string): string {
	return prompt
		.replace(/node \/[^\s`]+flywheel-comm[^\s`]*/g, "node <COMM_CLI>")
		.replace(/\/[^\s`]*land-status\.json/g, "<LAND_STATUS>")
		.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
			"<EXEC_ID>",
		);
}

describe("FLY-1188 M2 — codex prompt has ZERO Claude-only tooling references", () => {
	it("FLY-1718: makes push-guard bypasses forbidden and ACK Lead-supervised", async () => {
		const prompt = await buildCodexPrompt();
		expect(prompt).toContain("git push --no-verify");
		expect(prompt).toContain("core.hooksPath");
		expect(prompt).toContain("Lead confirmation");
		expect(prompt).toContain("FLYWHEEL_FORCE_PUSH_ACK=<exact-branch>");
		expect(prompt).toContain("one command");
	});

	it("FLY-1718: renders inherited branch/PR inventory without claiming a resume or gate skip", async () => {
		const prompt = await buildCodexPrompt({
			startPoint: "a".repeat(40),
			continuityInherit: {
				branch: "flywheel-FLY-1704",
				sha: "a".repeat(40),
				prNumber: 813,
				prUrl: "https://github.test/pull/813",
			},
		});
		expect(prompt).toContain("BRANCH CONTINUITY");
		expect(prompt).toContain("origin/flywheel-FLY-1704@aaaaaaa");
		expect(prompt).toContain("open PR #813: https://github.test/pull/813");
		expect(prompt).toContain("git log --oneline -10");
		expect(prompt).toContain("No pipeline gate is skipped");
		expect(prompt).not.toContain("RESUME MODE");
	});

	it("baseline codex prompt: banned tokens absent, codex equivalents present", async () => {
		const prompt = await buildCodexPrompt();
		expect(prompt.length).toBeGreaterThan(0);
		for (const banned of BANNED_IN_CODEX_PROMPT) {
			expect(prompt).not.toContain(banned);
		}
		// onboard: manual same-shape, not the Skill tool
		expect(prompt).toContain("Onboard MANUALLY (you have no Skill tool)");
		expect(prompt).not.toContain("Attempt the `onboard` skill");
		// report channel honesty
		expect(prompt).toContain("NO teammate-messaging tool");
		expect(prompt).not.toContain("fresh QA PASS verdict");
		expect(prompt).not.toContain("Bridge then auto-rebinds the ship gate");
		expect(prompt).toContain("recovery is a fresh review lap");
	});

	it("codex DAG workflow implement phase (keep-alive): park wording carries no banned tokens", async () => {
		const prompt = await buildCodexPrompt({
			sessionRole: "implement",
			shareParentBranch: true,
			startPoint: "abc123", // matches the mock gitChecker baseline (takeover guard)
		});
		expect(prompt).toContain("DAG workflow keep-alive (implement phase)");
		for (const banned of BANNED_IN_CODEX_PROMPT) {
			expect(prompt).not.toContain(banned);
		}
		expect(prompt).toContain("park --exec-id");
		expect(prompt).toContain("phase controller stays alive");
		expect(prompt).toContain("[phase-wake <id>]");
		expect(prompt).toContain("message is context; TURN is authority");
		expect(prompt).toContain("do not repeat external or worktree side effects");
		expect(prompt).not.toContain(
			"make your final message a short status note and END YOUR TURN",
		);
	});

	it("codex DAG workflow design phase parks after its exact completion route", async () => {
		const prompt = await buildCodexPrompt({
			sessionRole: "design",
			shareParentBranch: true,
			startPoint: "abc123",
		});
		const complete = prompt.indexOf("complete --route phase_design_complete");
		const park = prompt.indexOf("park --exec-id", complete);
		expect(complete).toBeGreaterThanOrEqual(0);
		expect(park).toBeGreaterThan(complete);
		expect(prompt).toContain("phase controller stays alive");
		expect(prompt).toContain("[phase-wake <id>]");
		expect(prompt).not.toContain(
			"make your final message a short handoff note and END YOUR TURN",
		);
	});

	it("codex DAG workflow QA phase parks after verdict and supports same-session re-test", async () => {
		const prompt = await buildCodexPrompt({
			sessionRole: "qa",
			shareParentBranch: true,
			startPoint: "abc123",
		});
		expect(prompt).toContain("QA phase of a DAG workflow");
		for (const banned of BANNED_IN_CODEX_PROMPT) {
			expect(prompt).not.toContain(banned);
		}
		const failVerdict = prompt.indexOf("--status fail");
		const park = prompt.indexOf("park --exec-id", failVerdict);
		expect(failVerdict).toBeGreaterThanOrEqual(0);
		expect(park).toBeGreaterThan(failVerdict);
		expect(prompt).toContain("RE-TEST wake");
		expect(prompt).toContain("turn --exec-id");
		expect(prompt).toContain("[phase-wake <id>]");
		expect(prompt).toContain("message is context; TURN is authority");
		expect(prompt).toContain("5-fb.");
		expect(prompt).toContain("FEEDBACK = KICKBACK");
	});
});

describe("FLY-1188 M2 — role-file ENVIRONMENT TRANSLATION header (codex only)", () => {
	async function buildWithDispatcher(codex: boolean): Promise<string> {
		const adapter = makeMockAdapter();
		const dispatcher = {
			dispatch: vi.fn(() => ({
				agentConfig: resolvedTestAgent({
					nodeName: "role",
					projectRoot: wt,
					relativeFile: "role.md",
				}),
			})),
			dispatchByName: vi.fn(),
		};
		const wt = makeRealWorktree();
		cleanups.push(wt);
		// Place the role file inside the registry-owned agent root.
		const { writeFileSync } = await import("node:fs");
		mkdirSync(join(wt, ".flywheel", "agents"), { recursive: true });
		writeFileSync(
			join(wt, ".flywheel", "agents", "role.md"),
			"Use the Skill tool and SendMessage as usual.",
		);
		const blueprint = makeBlueprint({
			adapter,
			worktreeManager: makeWtManager(wt),
			dispatcher,
			checkpointConfig: CHECKPOINTS,
		});
		const ctx: BlueprintContext = {
			teamName: "eng",
			runnerName: "runner",
			leadId: "flywheel-eng-lead",
			projectName: "proj",
			...(codex ? { runnerBackend: "codex-tmux" } : {}),
		};
		await blueprint.run(makeNode(), "/tmp/fly1188-m2-project", ctx);
		const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as AdapterExecutionContext | undefined;
		return call?.appendSystemPrompt ?? "";
	}

	it("codex: translation header precedes the verbatim role text", async () => {
		const prompt = await buildWithDispatcher(true);
		const headerIdx = prompt.indexOf(
			"## Environment Translation (codex runner)",
		);
		const roleIdx = prompt.indexOf("## Agent Role");
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		expect(roleIdx).toBeGreaterThan(headerIdx);
		// role text stays VERBATIM (translation is a header, not a rewrite)
		expect(prompt).toContain("Use the Skill tool and SendMessage as usual.");
		expect(prompt).toContain(
			"appears in your Available skills catalog, use it natively",
		);
		expect(prompt).not.toContain(
			"you have no Skill tool — perform the same steps manually",
		);
	});

	it("claude: no translation header (byte-compat)", async () => {
		const prompt = await buildWithDispatcher(false);
		expect(prompt).not.toContain("## Environment Translation");
		expect(prompt).toContain("## Agent Role");
	});
});

describe("FLY-1188 M2 — claude prompt byte-snapshot (drift guard)", () => {
	it("FLY-2147 only inserts the deterministic fail-closed section", async () => {
		const { prompt, adapterContext } = await buildPromptWithContext({
			memoryMode: "role",
		});
		const normalized = normalizePromptForSnapshot(prompt);
		const sectionStart = normalized.indexOf("## Runner Memory\n");
		const sectionEnd = normalized.indexOf("\n## ", sectionStart);
		expect(sectionStart).toBeGreaterThanOrEqual(0);
		expect(sectionEnd).toBeGreaterThan(sectionStart);
		const section = normalized.slice(sectionStart, sectionEnd);
		const expectedSection = buildRunnerMemoryPromptSection(
			{
				status: "skipped",
				reason: "no_role",
				backend: "claude-tmux",
				project: "proj",
			},
			{ legacyProjectMemoryDir: undefined },
		);
		expect(section).toBe(expectedSection);
		const beforeWithRepositoryNewline = readFileSync(
			new URL("./fixtures/fly1188-prompt-before-fly2147.txt", import.meta.url),
			"utf8",
		);
		const before = beforeWithRepositoryNewline.endsWith("\n")
			? beforeWithRepositoryNewline.slice(0, -1)
			: beforeWithRepositoryNewline;
		expect(normalized).toBe(`${expectedSection}\n## Baseline Rules\n${before}`);
		expect(adapterContext.runnerMemory).toEqual({
			status: "disabled",
			reason: "no_role",
		});
	});

	it("FLY-2147 gives identity-less Codex the exact honest fail-closed section", async () => {
		const wt = makeRealWorktree();
		cleanups.push(wt);
		const { prompt, adapterContext } = await buildPromptWithContext({
			worktreePath: wt,
			ctxOverrides: { runnerBackend: "codex-tmux" },
			memoryMode: "role",
		});
		const sectionStart = prompt.indexOf("## Runner Memory\n");
		const sectionEnd = prompt.indexOf("\n## ", sectionStart);
		const section = prompt.slice(sectionStart, sectionEnd);
		const expectedSection = buildRunnerMemoryPromptSection(
			{
				status: "skipped",
				reason: "no_role",
				backend: "codex-tmux",
				project: "proj",
			},
			{ legacyProjectMemoryDir: undefined },
		);
		expect(section).toBe(expectedSection);
		expect(section).not.toContain("auto memory is DISABLED");
		expect(section).not.toContain("Claude Code loads");
		expect(adapterContext.runnerMemory).toEqual({
			status: "disabled",
			reason: "no_role",
		});
	});

	it("default claude ctx full prompt is unchanged", async () => {
		const prompt = await buildPrompt({ memoryMode: "role" });
		// normalize the machine-dependent CLI path, land-signal path, and the
		// per-run random executionId
		const normalized = normalizePromptForSnapshot(prompt);
		expect(normalized).toMatchSnapshot();
	});

	it("FLY-2147 off mode omits runner memory and preserves the pre-FLY-2147 prompt byte-for-byte", async () => {
		const { prompt, adapterContext } = await buildPromptWithContext({
			memoryMode: "off",
		});
		const normalized = normalizePromptForSnapshot(prompt);
		const beforeWithRepositoryNewline = readFileSync(
			new URL("./fixtures/fly1188-prompt-before-fly2147.txt", import.meta.url),
			"utf8",
		);
		const before = beforeWithRepositoryNewline.endsWith("\n")
			? beforeWithRepositoryNewline.slice(0, -1)
			: beforeWithRepositoryNewline;

		expect(normalized).not.toContain("## Runner Memory\n");
		expect(normalized).toBe(before);
		expect(adapterContext.runnerMemory).toBeUndefined();
	});
});

// ── FLY-1257 M1-a — resident Codex gate-wait law ──────────────────────────────
// The same invariant is requested at every Codex gate surface but rendered
// exactly once per prompt. This prevents a long-pending human gate from being
// mistaken for permission to terminalize the durable goal as blocked.
describe("FLY-1257 M1-a — resident Codex gate-wait law", () => {
	const WAIT_LAW = "gate/review pending is NEVER blocked";

	it("renders the shared law exactly once when all Codex checkpoints are enabled", async () => {
		const prompt = await buildCodexPrompt();
		expect(prompt).toContain("BRAINSTORM GATE");
		expect(prompt).toContain("CODE REVIEW GATE (codex author");
		expect(prompt).toContain("APPROVE GATE (MANDATORY");
		expect(prompt).toContain("QUESTION GATE");
		expect(prompt.match(new RegExp(WAIT_LAW, "g")) ?? []).toHaveLength(1);
		expect(prompt).toContain("fail-open timeout means continue");
	});

	it.each([
		["brainstorm", { brainstorm: { enabled: true } }],
		["question", { question: { enabled: true } }],
		["generic", { security_review: { enabled: true } }],
		["review-and-approve", { approve_to_ship: { enabled: true } }],
	] as const)(
		"%s-only Codex prompt still carries the shared law once",
		async (_name, checkpointConfig) => {
			const wt = makeRealWorktree();
			cleanups.push(wt);
			const prompt = await buildPrompt({
				worktreePath: wt,
				ctxOverrides: { runnerBackend: "codex-tmux" },
				checkpointConfig,
			});
			expect(prompt.match(new RegExp(WAIT_LAW, "g")) ?? []).toHaveLength(1);
		},
	);

	it("Claude prompt remains free of the Codex-only wait law", async () => {
		const prompt = await buildPrompt({ ctxOverrides: {} });
		expect(prompt).not.toContain(WAIT_LAW);
		expect(prompt).not.toContain("fail-open timeout means continue");
	});

	it("FLY-2103 treats a declared checkpoint as enabled regardless of a legacy false value", async () => {
		const wt = makeRealWorktree();
		cleanups.push(wt);
		const prompt = await buildPrompt({
			worktreePath: wt,
			ctxOverrides: { runnerBackend: "codex-tmux" },
			checkpointConfig: { security_review: { enabled: false } },
		});
		expect(prompt).toContain("SECURITY_REVIEW GATE");
	});
});

// ── FLY-1224 (T13 ①) — codex author code-review lane guidance ─────────────
// A codex author's FLY-827 code gate is request-driven (event-route skips the
// legacy trigger); without this prompt block NO review ever runs and the ship
// gate deadlocks. The block must carry the coordinator's FULL state machine:
// three terminal outcomes + the re-round loop + fail-closed failure handling.
describe("FLY-1224 — codex author CODE REVIEW GATE guidance (T13 ①)", () => {
	it("codex prompt carries the full code-review lane state machine", async () => {
		const prompt = await buildCodexPrompt();
		expect(prompt).toContain("CODE REVIEW GATE (codex author");
		// lane mechanics: gate → request-review → poll
		expect(prompt).toContain("gate review_code");
		expect(prompt).toContain("request-review --type code --question-id");
		expect(prompt).toContain("check <questionId>");
		// all THREE terminal outcomes (R5 #1: the real coordinator state machine)
		expect(prompt).toContain("APPROVED → the code gate is satisfied");
		expect(prompt).toContain("SKIPPED (governance-level codex-skip");
		expect(prompt).toContain(
			"CHANGES_REQUESTED → the answered question is CONSUMED",
		);
		// the re-round loop: a NEW gate + a NEW request per round
		expect(prompt).toContain("open a NEW `gate review_code --no-block`");
		// fail-closed failure handling — never a same-family substitute
		expect(prompt).toContain("FAIL-CLOSED: report it to your Lead");
		expect(prompt).toContain("never substitute a same-family review");
		// ordering: the code gate guidance precedes the approve gate
		expect(prompt.indexOf("CODE REVIEW GATE (codex author")).toBeLessThan(
			prompt.indexOf("APPROVE GATE (MANDATORY"),
		);
	});

	it("claude prompt does NOT carry the codex code-review lane (byte-compat guard)", async () => {
		const prompt = await buildPrompt({ ctxOverrides: {} });
		expect(prompt).not.toContain("CODE REVIEW GATE (codex author");
		expect(prompt).not.toContain("request-review --type code");
	});
});
